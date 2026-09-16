/**
 * Product recall workflow — the regulatory reason lot tracking exists.
 *
 * Quarantine FIRST at initiate, investigate second. Selling one more unit during
 * setup is the failure this system exists to prevent.
 *
 * Recalled goods must NEVER return to sellable stock (refunds use restock=false).
 * Recall rows are NEVER deleted — COMPLETED / CANCELLED only (regulatory retention).
 */
import {
  LotStatus,
  Prisma,
  RecallNotificationChannel,
  RecallSeverity,
  RecallStatus,
  Role,
  type Recall,
} from "@prisma/client";
import { env } from "../config/env.js";
import { AuditAction, writeAuditLog } from "../lib/audit.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../types/auth.js";
import * as salesService from "./sales.service.js";
import { traceForward } from "./traceability.service.js";
import nodemailer from "nodemailer";

function assertCoopAdmin(actor: AuthUser): void {
  if (actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Only COOP_ADMIN can manage recalls");
  }
}

async function nextRecallNumber(tx: Prisma.TransactionClient): Promise<string> {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `REC-${day}-`;
  const latest = await tx.recall.findFirst({
    where: { recallNumber: { startsWith: prefix } },
    orderBy: { recallNumber: "desc" },
    select: { recallNumber: true },
  });
  const seq = latest ? Number(latest.recallNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

export type InitiateRecallInput = {
  lotIds: string[];
  reason: string;
  severity: RecallSeverity;
  publicNotice?: string;
  ipAddress?: string | null;
};

/**
 * Create a DRAFT recall and QUARANTINE every lot immediately in one transaction.
 */
export async function initiateRecall(
  actor: AuthUser,
  input: InitiateRecallInput,
): Promise<Recall & { lots: Array<{ id: string; lotId: string; quantityAtRecall: number }> }> {
  assertCoopAdmin(actor);
  const reason = input.reason.trim();
  if (!reason) throw new AppError(400, "Recall reason is required");
  const lotIds = [...new Set(input.lotIds)];
  if (!lotIds.length) throw new AppError(400, "At least one lotId is required");

  const result = await prisma.$transaction(async (tx) => {
    const lots = await tx.lot.findMany({
      where: { id: { in: lotIds } },
    });
    if (lots.length !== lotIds.length) {
      const found = new Set(lots.map((l) => l.id));
      throw new AppError(404, "One or more lots were not found", {
        missing: lotIds.filter((id) => !found.has(id)),
      });
    }

    for (const lot of lots) {
      if (lot.status !== LotStatus.ACTIVE && lot.status !== LotStatus.QUARANTINED) {
        throw new AppError(409, "Lot cannot be recalled in its current status", {
          lotId: lot.id,
          status: lot.status,
        });
      }
      if (lot.quantityReserved > 0) {
        throw new AppError(
          409,
          "Cannot recall lot with open reservations — finalize or expire pending sales first",
          { lotId: lot.id, quantityReserved: lot.quantityReserved },
        );
      }
    }

    const recallNumber = await nextRecallNumber(tx);
    const recall = await tx.recall.create({
      data: {
        recallNumber,
        initiatedByUserId: actor.id,
        reason,
        severity: input.severity,
        status: RecallStatus.DRAFT,
        publicNotice: input.publicNotice?.trim() || null,
      },
    });

    const recallLots = [];
    for (const lot of lots) {
      if (lot.status === LotStatus.ACTIVE) {
        // Leave ACTIVE rollup: quarantine removes sellable units from Product.stock cache.
        const writeOffQty = Math.max(0, lot.quantityRemaining);
        await tx.lot.update({
          where: { id: lot.id },
          data: { status: LotStatus.QUARANTINED },
        });
        if (writeOffQty > 0) {
          await tx.product.update({
            where: { id: lot.productId },
            data: { stock: { decrement: writeOffQty } },
          });
        }
      }

      const rl = await tx.recallLot.create({
        data: {
          recallId: recall.id,
          lotId: lot.id,
          quantityAtRecall: lot.quantityRemaining,
        },
      });
      recallLots.push(rl);
    }

    await writeAuditLog(
      {
        userId: actor.id,
        storeId: lots[0]?.storeId ?? null,
        action: AuditAction.RECALL_INITIATE,
        entityType: "Recall",
        entityId: recall.id,
        after: {
          recallNumber,
          severity: input.severity,
          reason,
          lotIds,
          quarantined: true,
        },
        ipAddress: input.ipAddress ?? null,
      },
      { tx },
    );

    return { ...recall, lots: recallLots };
  });

  return result;
}

export type RecallImpactPreview = {
  recallId: string;
  recallNumber: string;
  status: RecallStatus;
  affectedMembers: Array<{
    memberId: string;
    memberNumber: string;
    name: string;
    email: string;
    phone: string;
    quantityPurchased: number;
    saleIds: string[];
  }>;
  unitsSold: number;
  unitsOnShelves: number;
  storesInvolved: Array<{ storeId: string; storeName: string }>;
  /** Estimated COGS exposure of sold + on-shelf units (lot unitCost × qty). */
  estimatedFinancialExposure: string;
  saleIds: string[];
};

/**
 * Review impact before going public — members, shelf units, stores, $ exposure.
 */
export async function previewRecallImpact(
  actor: AuthUser,
  recallId: string,
): Promise<RecallImpactPreview> {
  if (actor.role !== Role.COOP_ADMIN && actor.role !== Role.STORE_ADMIN) {
    throw new AppError(403, "Insufficient role");
  }

  const recall = await prisma.recall.findUnique({
    where: { id: recallId },
    include: {
      lots: {
        include: {
          lot: {
            include: { store: { select: { id: true, name: true } } },
          },
        },
      },
    },
  });
  if (!recall) throw new AppError(404, "Recall not found");

  const memberMap = new Map<string, RecallImpactPreview["affectedMembers"][0]>();
  const storeMap = new Map<string, { storeId: string; storeName: string }>();
  const saleIds = new Set<string>();
  let unitsSold = 0;
  let exposure = new Prisma.Decimal(0);

  for (const rl of recall.lots) {
    storeMap.set(rl.lot.storeId, {
      storeId: rl.lot.storeId,
      storeName: rl.lot.store.name,
    });
    exposure = exposure.add(rl.lot.unitCost.mul(Math.max(0, rl.lot.quantityRemaining)));

    const forward = await traceForward(actor, rl.lotId);
    unitsSold += forward.quantitySold;
    for (const sale of forward.sales) {
      saleIds.add(sale.saleId);
    }
    for (const m of forward.members) {
      const existing = memberMap.get(m.memberId);
      if (existing) {
        existing.quantityPurchased += m.quantityPurchased;
        existing.saleIds = [...new Set([...existing.saleIds, ...m.saleIds])];
      } else {
        memberMap.set(m.memberId, {
          memberId: m.memberId,
          memberNumber: m.memberNumber,
          name: m.name,
          email: m.email,
          phone: m.phone,
          quantityPurchased: m.quantityPurchased,
          saleIds: [...m.saleIds],
        });
      }
      exposure = exposure.add(rl.lot.unitCost.mul(m.quantityPurchased));
    }
  }

  const unitsOnShelves = recall.lots.reduce(
    (s, rl) => s + Math.max(0, rl.lot.quantityRemaining),
    0,
  );

  return {
    recallId: recall.id,
    recallNumber: recall.recallNumber,
    status: recall.status,
    affectedMembers: [...memberMap.values()].sort((a, b) =>
      a.memberNumber.localeCompare(b.memberNumber),
    ),
    unitsSold,
    unitsOnShelves,
    storesInvolved: [...storeMap.values()],
    estimatedFinancialExposure: exposure.toFixed(2),
    saleIds: [...saleIds],
  };
}

/**
 * Activate: lots → RECALLED, write off remaining shelf stock, create notification rows.
 */
export async function activateRecall(
  actor: AuthUser,
  recallId: string,
  options?: { publicNotice?: string; ipAddress?: string | null },
): Promise<{
  recall: Recall;
  notificationsCreated: number;
  unitsWrittenOff: number;
}> {
  assertCoopAdmin(actor);

  const impact = await previewRecallImpact(actor, recallId);

  return prisma.$transaction(async (tx) => {
    const recall = await tx.recall.findUnique({
      where: { id: recallId },
      include: { lots: { include: { lot: true } } },
    });
    if (!recall) throw new AppError(404, "Recall not found");
    if (recall.status !== RecallStatus.DRAFT) {
      throw new AppError(409, "Only DRAFT recalls can be activated", {
        status: recall.status,
      });
    }

    let unitsWrittenOff = 0;
    for (const rl of recall.lots) {
      const lot = rl.lot;
      const remaining = Math.max(0, lot.quantityRemaining);

      await tx.lot.update({
        where: { id: lot.id },
        data: {
          status: LotStatus.RECALLED,
          quantityRemaining: 0,
        },
      });

      if (remaining > 0) {
        // Product.stock already reduced at quarantine when leaving ACTIVE.
        await tx.inventoryWriteOff.create({
          data: {
            storeId: lot.storeId,
            productId: lot.productId,
            lotId: lot.id,
            quantity: remaining,
            reason: "RECALL",
          },
        });
        unitsWrittenOff += remaining;
      }
    }

    const channels = [
      RecallNotificationChannel.EMAIL,
      RecallNotificationChannel.SMS,
      RecallNotificationChannel.WHATSAPP,
    ];
    let notificationsCreated = 0;
    for (const m of impact.affectedMembers) {
      for (const channel of channels) {
        await tx.recallNotification.create({
          data: {
            recallId: recall.id,
            memberId: m.memberId,
            channel,
            quantityPurchased: m.quantityPurchased,
          },
        });
        notificationsCreated += 1;
      }
    }

    const updated = await tx.recall.update({
      where: { id: recall.id },
      data: {
        status: RecallStatus.ACTIVE,
        publicNotice:
          options?.publicNotice?.trim() || recall.publicNotice || null,
      },
    });

    await writeAuditLog(
      {
        userId: actor.id,
        action: AuditAction.RECALL_ACTIVATE,
        entityType: "Recall",
        entityId: recall.id,
        after: {
          recallNumber: recall.recallNumber,
          membersNotified: impact.affectedMembers.length,
          notificationsCreated,
          unitsWrittenOff,
        },
        ipAddress: options?.ipAddress ?? null,
      },
      { tx },
    );

    return { recall: updated, notificationsCreated, unitsWrittenOff };
  });
}

async function dispatchEmail(to: string, subject: string, html: string): Promise<"smtp" | "logged"> {
  if (env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    await transporter.sendMail({
      from: env.SMTP_FROM || "recalls@harvestlink.local",
      to,
      subject,
      html,
    });
    return "smtp";
  }
  console.log(
    JSON.stringify({
      type: "RECALL_EMAIL_LOGGED",
      to,
      subject,
      at: new Date().toISOString(),
    }),
  );
  return "logged";
}

/**
 * Send pending RecallNotification rows (EMAIL via SMTP/log; SMS + WhatsApp logged stubs).
 */
export async function dispatchRecallNotifications(
  actor: AuthUser,
  recallId: string,
  options?: { ipAddress?: string | null },
): Promise<{ sent: number; modes: Record<string, number> }> {
  assertCoopAdmin(actor);

  const recall = await prisma.recall.findUnique({ where: { id: recallId } });
  if (!recall) throw new AppError(404, "Recall not found");
  if (recall.status !== RecallStatus.ACTIVE) {
    throw new AppError(409, "Notifications only dispatch for ACTIVE recalls");
  }

  const pending = await prisma.recallNotification.findMany({
    where: { recallId, sentAt: null },
    include: { member: true },
  });

  let sent = 0;
  const modes: Record<string, number> = {};

  for (const row of pending) {
    const member = row.member;
    let mode = "skipped";

    if (row.channel === RecallNotificationChannel.EMAIL) {
      if (member.email) {
        mode = await dispatchEmail(
          member.email,
          `Important: Product recall ${recall.recallNumber}`,
          `<p>Dear ${member.name},</p>
           <p>A product you purchased is under recall (${recall.recallNumber}).</p>
           <p><strong>Reason:</strong> ${recall.reason}</p>
           <p>You purchased approximately ${row.quantityPurchased} unit(s). Please return them to your store. Do not consume.</p>
           ${recall.publicNotice ? `<p>${recall.publicNotice}</p>` : ""}`,
        );
      } else {
        mode = "no_email";
      }
    } else if (row.channel === RecallNotificationChannel.SMS) {
      console.log(
        JSON.stringify({
          type: "RECALL_SMS_LOGGED",
          recallId,
          memberId: member.id,
          phone: member.phone || null,
          quantityPurchased: row.quantityPurchased,
          at: new Date().toISOString(),
        }),
      );
      mode = member.phone ? "sms_logged" : "no_phone";
    } else if (row.channel === RecallNotificationChannel.WHATSAPP) {
      // Chapters already coordinate on WhatsApp — log until a provider is wired.
      console.log(
        JSON.stringify({
          type: "RECALL_WHATSAPP_LOGGED",
          recallId,
          memberId: member.id,
          phone: member.phone || null,
          quantityPurchased: row.quantityPurchased,
          at: new Date().toISOString(),
        }),
      );
      mode = member.phone ? "whatsapp_logged" : "no_phone";
    }

    if (mode !== "skipped" && !mode.startsWith("no_")) {
      await prisma.recallNotification.update({
        where: { id: row.id },
        data: { sentAt: new Date() },
      });
      sent += 1;
    }
    modes[mode] = (modes[mode] ?? 0) + 1;
  }

  await writeAuditLog({
    userId: actor.id,
    action: AuditAction.RECALL_NOTIFY,
    entityType: "Recall",
    entityId: recallId,
    after: { sent, modes, pending: pending.length },
    ipAddress: options?.ipAddress ?? null,
  });

  return { sent, modes };
}

export async function recordRecovery(
  actor: AuthUser,
  recallLotId: string,
  quantity: number,
  options?: { ipAddress?: string | null },
) {
  assertCoopAdmin(actor);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new AppError(400, "quantity must be a positive integer");
  }

  const rl = await prisma.recallLot.findUnique({
    where: { id: recallLotId },
    include: { recall: true },
  });
  if (!rl) throw new AppError(404, "RecallLot not found");
  if (rl.recall.status !== RecallStatus.ACTIVE) {
    throw new AppError(409, "Recovery only allowed on ACTIVE recalls");
  }

  const updated = await prisma.recallLot.update({
    where: { id: recallLotId },
    data: { quantityRecovered: { increment: quantity } },
  });

  await writeAuditLog({
    userId: actor.id,
    action: AuditAction.RECALL_RECOVERY,
    entityType: "RecallLot",
    entityId: recallLotId,
    after: { quantity, quantityRecovered: updated.quantityRecovered },
    ipAddress: options?.ipAddress ?? null,
  });

  return updated;
}

export async function recordDisposal(
  actor: AuthUser,
  recallLotId: string,
  quantity: number,
  options?: { ipAddress?: string | null },
) {
  assertCoopAdmin(actor);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new AppError(400, "quantity must be a positive integer");
  }

  const rl = await prisma.recallLot.findUnique({
    where: { id: recallLotId },
    include: { recall: true },
  });
  if (!rl) throw new AppError(404, "RecallLot not found");
  if (rl.recall.status !== RecallStatus.ACTIVE) {
    throw new AppError(409, "Disposal only allowed on ACTIVE recalls");
  }

  const updated = await prisma.recallLot.update({
    where: { id: recallLotId },
    data: { quantityDisposed: { increment: quantity } },
  });

  await writeAuditLog({
    userId: actor.id,
    action: AuditAction.RECALL_DISPOSAL,
    entityType: "RecallLot",
    entityId: recallLotId,
    after: { quantity, quantityDisposed: updated.quantityDisposed },
    ipAddress: options?.ipAddress ?? null,
  });

  return updated;
}

/**
 * Refund recalled purchases via existing refund path with restock=false.
 * Recalled goods must NEVER return to sellable stock.
 */
export async function refundRecalledPurchases(
  actor: AuthUser,
  recallId: string,
  options?: { ipAddress?: string | null },
): Promise<{ refundedSaleIds: string[]; errors: Array<{ saleId: string; error: string }> }> {
  assertCoopAdmin(actor);
  const impact = await previewRecallImpact(actor, recallId);
  const recall = await prisma.recall.findUnique({ where: { id: recallId } });
  if (!recall) throw new AppError(404, "Recall not found");
  if (recall.status !== RecallStatus.ACTIVE) {
    throw new AppError(409, "Refunds only for ACTIVE recalls");
  }

  const refundedSaleIds: string[] = [];
  const errors: Array<{ saleId: string; error: string }> = [];

  for (const saleId of impact.saleIds) {
    const sale = await prisma.sale.findUnique({ where: { id: saleId } });
    if (!sale) continue;
    if (sale.paymentStatus === "REFUNDED") {
      refundedSaleIds.push(saleId);
      continue;
    }
    try {
      await salesService.refundSale(saleId, sale.storeId, {
        restock: false,
        createdByUserId: actor.id,
        ipAddress: options?.ipAddress ?? null,
      });
      refundedSaleIds.push(saleId);
    } catch (error) {
      errors.push({
        saleId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { refundedSaleIds, errors };
}

export type RecallCloseReport = {
  recallId: string;
  recallNumber: string;
  timeline: {
    initiatedAt: Date;
    activatedAt: Date | null;
    regulatorNotifiedAt: Date | null;
    closedAt: Date;
  };
  membersNotified: number;
  notificationsSent: number;
  acknowledgements: number;
  acknowledgementRate: string;
  unitsSold: number;
  unitsRecovered: number;
  unitsDisposed: number;
  unitsWrittenOffAtActivate: number;
  disposalRecords: Array<{
    recallLotId: string;
    lotId: string;
    quantityDisposed: number;
    quantityRecovered: number;
  }>;
};

export async function closeRecall(
  actor: AuthUser,
  recallId: string,
  options?: { regulatorNotifiedAt?: Date | null; ipAddress?: string | null },
): Promise<RecallCloseReport> {
  assertCoopAdmin(actor);

  const recall = await prisma.recall.findUnique({
    where: { id: recallId },
    include: {
      lots: true,
      notifications: true,
    },
  });
  if (!recall) throw new AppError(404, "Recall not found");
  if (recall.status !== RecallStatus.ACTIVE) {
    throw new AppError(409, "Only ACTIVE recalls can be closed");
  }

  const impact = await previewRecallImpact(actor, recallId);
  const closedAt = new Date();
  const notificationsSent = recall.notifications.filter((n) => n.sentAt).length;
  const acknowledgements = recall.notifications.filter((n) => n.acknowledgedAt).length;
  const memberIds = new Set(recall.notifications.map((n) => n.memberId));
  const membersNotified = memberIds.size;
  const ackMembers = new Set(
    recall.notifications.filter((n) => n.acknowledgedAt).map((n) => n.memberId),
  );
  const acknowledgementRate =
    membersNotified === 0
      ? "0%"
      : `${((ackMembers.size / membersNotified) * 100).toFixed(1)}%`;

  const writeOffs = await prisma.inventoryWriteOff.aggregate({
    where: {
      reason: "RECALL",
      lotId: { in: recall.lots.map((l) => l.lotId) },
    },
    _sum: { quantity: true },
  });

  const report: RecallCloseReport = {
    recallId: recall.id,
    recallNumber: recall.recallNumber,
    timeline: {
      initiatedAt: recall.initiatedAt,
      activatedAt: recall.updatedAt,
      regulatorNotifiedAt: options?.regulatorNotifiedAt ?? recall.regulatorNotifiedAt,
      closedAt,
    },
    membersNotified,
    notificationsSent,
    acknowledgements,
    acknowledgementRate,
    unitsSold: impact.unitsSold,
    unitsRecovered: recall.lots.reduce((s, l) => s + l.quantityRecovered, 0),
    unitsDisposed: recall.lots.reduce((s, l) => s + l.quantityDisposed, 0),
    unitsWrittenOffAtActivate: writeOffs._sum.quantity ?? 0,
    disposalRecords: recall.lots.map((l) => ({
      recallLotId: l.id,
      lotId: l.lotId,
      quantityDisposed: l.quantityDisposed,
      quantityRecovered: l.quantityRecovered,
    })),
  };

  await prisma.recall.update({
    where: { id: recallId },
    data: {
      status: RecallStatus.COMPLETED,
      closedAt,
      regulatorNotifiedAt:
        options?.regulatorNotifiedAt ?? recall.regulatorNotifiedAt,
    },
  });

  await writeAuditLog({
    userId: actor.id,
    action: AuditAction.RECALL_CLOSE,
    entityType: "Recall",
    entityId: recallId,
    after: report as unknown as Prisma.InputJsonValue,
    ipAddress: options?.ipAddress ?? null,
  });

  return report;
}

export async function cancelRecall(
  actor: AuthUser,
  recallId: string,
  options?: { ipAddress?: string | null },
): Promise<Recall> {
  assertCoopAdmin(actor);
  const recall = await prisma.recall.findUnique({
    where: { id: recallId },
    include: { lots: { include: { lot: true } } },
  });
  if (!recall) throw new AppError(404, "Recall not found");
  if (recall.status !== RecallStatus.DRAFT) {
    throw new AppError(409, "Only DRAFT recalls can be cancelled (ACTIVE must be closed)");
  }

  // Return quarantined lots to ACTIVE and restore Product.stock rollup.
  await prisma.$transaction(async (tx) => {
    for (const rl of recall.lots) {
      const lot = rl.lot;
      if (lot.status === LotStatus.QUARANTINED) {
        await tx.lot.update({
          where: { id: lot.id },
          data: { status: LotStatus.ACTIVE },
        });
        if (lot.quantityRemaining > 0) {
          await tx.product.update({
            where: { id: lot.productId },
            data: { stock: { increment: lot.quantityRemaining } },
          });
        }
      }
    }
    await tx.recall.update({
      where: { id: recallId },
      data: { status: RecallStatus.CANCELLED, closedAt: new Date() },
    });
    await writeAuditLog(
      {
        userId: actor.id,
        action: AuditAction.RECALL_CANCEL,
        entityType: "Recall",
        entityId: recallId,
        after: { status: RecallStatus.CANCELLED },
        ipAddress: options?.ipAddress ?? null,
      },
      { tx },
    );
  });

  return prisma.recall.findUniqueOrThrow({ where: { id: recallId } });
}

export async function listRecalls(actor: AuthUser) {
  assertCoopAdmin(actor);
  return prisma.recall.findMany({
    orderBy: { initiatedAt: "desc" },
    include: {
      lots: {
        include: {
          lot: {
            select: {
              id: true,
              lotNumber: true,
              storeId: true,
              status: true,
              productId: true,
            },
          },
        },
      },
      _count: { select: { notifications: true } },
    },
  });
}

export async function getRecall(actor: AuthUser, recallId: string) {
  if (actor.role !== Role.COOP_ADMIN && actor.role !== Role.STORE_ADMIN) {
    throw new AppError(403, "Insufficient role");
  }
  const recall = await prisma.recall.findUnique({
    where: { id: recallId },
    include: {
      lots: { include: { lot: { include: { store: true, product: true } } } },
      notifications: { include: { member: true } },
      initiatedBy: { select: { id: true, email: true } },
    },
  });
  if (!recall) throw new AppError(404, "Recall not found");
  return recall;
}

/**
 * Store banner: ACTIVE (or DRAFT quarantined) recalls touching lots in this store.
 */
export async function listActiveRecallsForStore(
  actor: AuthUser,
  storeId: string,
): Promise<
  Array<{
    recallId: string;
    recallNumber: string;
    status: RecallStatus;
    severity: RecallSeverity;
    reason: string;
    lotNumbers: string[];
  }>
> {
  if (actor.role === Role.STORE_ADMIN || actor.role === Role.CASHIER) {
    if (actor.storeId !== storeId) {
      throw new AppError(403, "Cannot access another store's data");
    }
  } else if (actor.role !== Role.COOP_ADMIN) {
    throw new AppError(403, "Insufficient role");
  }

  const rows = await prisma.recallLot.findMany({
    where: {
      lot: { storeId },
      recall: { status: { in: [RecallStatus.DRAFT, RecallStatus.ACTIVE] } },
    },
    include: {
      recall: true,
      lot: { select: { lotNumber: true } },
    },
  });

  const byRecall = new Map<
    string,
    {
      recallId: string;
      recallNumber: string;
      status: RecallStatus;
      severity: RecallSeverity;
      reason: string;
      lotNumbers: string[];
    }
  >();

  for (const row of rows) {
    const existing = byRecall.get(row.recallId);
    if (existing) {
      if (!existing.lotNumbers.includes(row.lot.lotNumber)) {
        existing.lotNumbers.push(row.lot.lotNumber);
      }
    } else {
      byRecall.set(row.recallId, {
        recallId: row.recall.id,
        recallNumber: row.recall.recallNumber,
        status: row.recall.status,
        severity: row.recall.severity,
        reason: row.recall.reason,
        lotNumbers: [row.lot.lotNumber],
      });
    }
  }

  return [...byRecall.values()];
}

export async function acknowledgeNotification(
  actor: AuthUser,
  notificationId: string,
): Promise<void> {
  assertCoopAdmin(actor);
  const row = await prisma.recallNotification.findUnique({ where: { id: notificationId } });
  if (!row) throw new AppError(404, "Notification not found");
  await prisma.recallNotification.update({
    where: { id: notificationId },
    data: { acknowledgedAt: new Date() },
  });
}
