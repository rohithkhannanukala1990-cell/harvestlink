/**
 * Full recall path: receive → sell to 3 members → initiate → activate/notify → POS blocked → no-restock refund.
 */
import { PaymentMethod, Prisma, RecallSeverity } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as purchasing from "../src/services/purchasing.service.js";
import * as recallService from "../src/services/recall.service.js";
import * as salesService from "../src/services/sales.service.js";
import { prisma } from "./helpers/db.js";
import {
  asAuthUser,
  createMember,
  createProduct,
  seedCashierStore,
} from "./helpers/factories.js";

describe("recall workflow", () => {
  it("notifies three buyers, blocks remaining stock at POS, and refunds without restock", async () => {
    const { store, cashier, storeAdmin, coopAdmin } = await seedCashierStore();

    const product = await createProduct(store.id, { stock: 0, cost: 2, price: 8, skipLot: true });
    const supplier = await purchasing.createSupplier(asAuthUser(storeAdmin), {
      name: "Recall Farms",
    });
    const po = await purchasing.createPurchaseOrder(asAuthUser(storeAdmin), {
      supplierId: supplier.id,
      storeId: store.id,
      lines: [{ productId: product.id, orderedQty: 10, unitCost: 2 }],
    });
    await purchasing.submitPurchaseOrder(asAuthUser(storeAdmin), po.id);
    await purchasing.receiveGoods(asAuthUser(storeAdmin), po.id, {
      invoiceNumber: "INV-RECALL",
      lines: [
        {
          poLineId: po.lines[0]!.id,
          quantityReceived: 10,
          unitCostActual: 2,
          lotNumber: "RECALL-BATCH-1",
        },
      ],
    });

    const lot = await prisma.lot.findFirstOrThrow({
      where: { productId: product.id, lotNumber: "RECALL-BATCH-1" },
    });
    expect(lot.status).toBe("ACTIVE");
    expect(lot.quantityRemaining).toBe(10);

    await prisma.cashDrawer.create({
      data: {
        storeId: store.id,
        openedByUserId: storeAdmin.id,
        openingFloat: new Prisma.Decimal(100),
      },
    });

    const m1 = await createMember({ email: "r1@test.local" });
    const m2 = await createMember({ email: "r2@test.local" });
    const m3 = await createMember({ email: "r3@test.local" });

    for (const member of [m1, m2, m3]) {
      await salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        memberId: member.id,
        paymentMethod: PaymentMethod.CASH,
      });
    }

    const afterSales = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(afterSales.quantityRemaining).toBe(7);

    const initiated = await recallService.initiateRecall(asAuthUser(coopAdmin), {
      lotIds: [lot.id],
      reason: "Possible contamination",
      severity: RecallSeverity.MANDATORY,
      publicNotice: "Return product immediately.",
    });
    expect(initiated.status).toBe("DRAFT");

    const quarantined = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(quarantined.status).toBe("QUARANTINED");

    // Remaining shelf stock must not sell while recall is being prepared.
    await expect(
      salesService.createSale(store.id, asAuthUser(cashier), {
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: PaymentMethod.CASH,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Product unavailable — stock is quarantined or recalled",
    });

    const impact = await recallService.previewRecallImpact(asAuthUser(coopAdmin), initiated.id);
    expect(impact.affectedMembers).toHaveLength(3);
    expect(impact.unitsSold).toBe(3);
    expect(impact.unitsOnShelves).toBe(7);

    const activated = await recallService.activateRecall(asAuthUser(coopAdmin), initiated.id);
    expect(activated.notificationsCreated).toBe(9); // 3 members × 3 channels
    expect(activated.unitsWrittenOff).toBe(7);

    const recalledLot = await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(recalledLot.status).toBe("RECALLED");
    expect(recalledLot.quantityRemaining).toBe(0);

    const notifications = await prisma.recallNotification.findMany({
      where: { recallId: initiated.id },
    });
    const memberIds = [...new Set(notifications.map((n) => n.memberId))].sort();
    expect(memberIds).toEqual([m1.id, m2.id, m3.id].sort());

    const dispatch = await recallService.dispatchRecallNotifications(
      asAuthUser(coopAdmin),
      initiated.id,
    );
    expect(dispatch.sent).toBeGreaterThanOrEqual(3);

    const emailSent = await prisma.recallNotification.findMany({
      where: { recallId: initiated.id, channel: "EMAIL", sentAt: { not: null } },
    });
    expect(emailSent).toHaveLength(3);

    const stockBeforeRefund = (
      await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    ).stock;

    const refunds = await recallService.refundRecalledPurchases(
      asAuthUser(coopAdmin),
      initiated.id,
    );
    expect(refunds.refundedSaleIds).toHaveLength(3);
    expect(refunds.errors).toHaveLength(0);

    const stockAfterRefund = (
      await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    ).stock;
    // restock=false — recalled goods must never return to sellable stock
    expect(stockAfterRefund).toBe(stockBeforeRefund);

    const writeOffs = await prisma.inventoryWriteOff.findMany({
      where: { reason: "REFUND_NO_RESTOCK", productId: product.id },
    });
    expect(writeOffs.reduce((s, w) => s + w.quantity, 0)).toBe(3);

    await recallService.recordRecovery(asAuthUser(coopAdmin), initiated.lots[0]!.id, 2);
    await recallService.recordDisposal(asAuthUser(coopAdmin), initiated.lots[0]!.id, 2);

    const report = await recallService.closeRecall(asAuthUser(coopAdmin), initiated.id);
    expect(report.membersNotified).toBe(3);
    expect(report.unitsSold).toBe(3);
    expect(report.unitsRecovered).toBe(2);
    expect(report.unitsDisposed).toBe(2);

    const audits = await prisma.auditLog.findMany({
      where: { entityId: initiated.id },
    });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("RECALL_INITIATE");
    expect(actions).toContain("RECALL_ACTIVATE");
    expect(actions).toContain("RECALL_NOTIFY");
    expect(actions).toContain("RECALL_CLOSE");
  });
});
