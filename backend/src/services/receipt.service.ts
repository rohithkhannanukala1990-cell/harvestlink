/**
 * Printable sale receipts for Harvestlink POS.
 * HTML is generated on demand (reprint-safe). Email uses optional SMTP when configured.
 */
import { PaymentStatus } from "@prisma/client";
import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

function money(value: { toFixed?: (n: number) => string } | string | number): string {
  if (typeof value === "number") return value.toFixed(2);
  if (typeof value === "string") return Number(value).toFixed(2);
  return value.toFixed?.(2) ?? String(value);
}

export async function buildReceiptHtml(saleId: string, storeId: string): Promise<string> {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, storeId },
    include: {
      items: true,
      store: true,
      member: true,
      cashier: { select: { email: true } },
    },
  });
  if (!sale) {
    throw new AppError(404, "Sale not found for this store");
  }
  if (sale.paymentStatus !== PaymentStatus.PAID && sale.paymentStatus !== PaymentStatus.REFUNDED && sale.paymentStatus !== PaymentStatus.REFUNDING) {
    throw new AppError(409, "Receipts are only available for paid (or refunded) sales", {
      paymentStatus: sale.paymentStatus,
    });
  }

  const lines = sale.items
    .map((item) => {
      const gross = Number(item.priceSnapshot) * item.quantity;
      return `<tr>
        <td>${escapeHtml(item.nameSnapshot)}</td>
        <td>${item.quantity}</td>
        <td>$${money(item.priceSnapshot)}</td>
        <td>$${money(item.discountAmount)}</td>
        <td>$${money(item.taxAmount)}</td>
        <td>$${money(gross - Number(item.discountAmount) + Number(item.taxAmount))}</td>
      </tr>`;
    })
    .join("");

  const paidAt = sale.paidAt ?? sale.createdAt;
  const last4 = sale.cardLast4 ? `····${sale.cardLast4}` : "—";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Receipt ${sale.id}</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; max-width: 28rem; margin: 1.5rem auto; color: #1c1917; }
    h1 { font-size: 1.35rem; margin: 0; }
    .muted { color: #57534e; font-size: 0.9rem; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.35rem 0.25rem; border-bottom: 1px solid #e7e5e4; }
    th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #78716c; }
    .totals td { border: 0; }
    .totals .label { text-align: right; padding-right: 0.75rem; }
    .policy { margin-top: 1.25rem; font-size: 0.8rem; color: #57534e; white-space: pre-wrap; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
  <h1>${escapeHtml(sale.store.name)}</h1>
  <p class="muted">${escapeHtml(sale.store.address)}</p>
  <p class="muted">Sale ${escapeHtml(sale.id)}<br/>${paidAt.toISOString()}<br/>Cashier ${escapeHtml(sale.cashier.email)}</p>
  <table>
    <thead>
      <tr><th>Item</th><th>Qty</th><th>Price</th><th>Disc</th><th>Tax</th><th>Amt</th></tr>
    </thead>
    <tbody>${lines}</tbody>
  </table>
  <table class="totals">
    <tr><td class="label">Subtotal (pre-tax)</td><td>$${money(sale.subtotal)}</td></tr>
    <tr><td class="label">Discounts</td><td>−$${money(sale.discountAmount)}</td></tr>
    <tr><td class="label">Tax</td><td>$${money(sale.taxAmount)}</td></tr>
    <tr><td class="label"><strong>Total</strong></td><td><strong>$${money(sale.total)}</strong></td></tr>
  </table>
  <p class="muted">
    Payment: ${escapeHtml(sale.paymentMethod ?? "—")}<br/>
    Card: ${escapeHtml(last4)}<br/>
    Member: ${sale.member ? escapeHtml(sale.member.memberNumber) : "—"}
  </p>
  <p class="policy">${escapeHtml(sale.store.refundPolicy)}</p>
  <script>/* printable */</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function emailReceipt(
  saleId: string,
  storeId: string,
  toEmail?: string | null,
): Promise<{ sent: boolean; to: string; mode: "smtp" | "logged" }> {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, storeId },
    include: { member: true, store: true },
  });
  if (!sale) {
    throw new AppError(404, "Sale not found for this store");
  }

  const to =
    toEmail?.trim() ||
    sale.member?.email ||
    null;
  if (!to) {
    throw new AppError(400, "No recipient email — pass email or attach a member with an email");
  }

  const html = await buildReceiptHtml(saleId, storeId);
  const subject = `Receipt from ${sale.store.name} — $${money(sale.total)}`;

  if (env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    await transporter.sendMail({
      from: env.SMTP_FROM || env.SMTP_USER || "noreply@harvestlink.local",
      to,
      subject,
      html,
    });
    return { sent: true, to, mode: "smtp" };
  }

  // Dev / unconfigured: log so ops can still verify the flow without SMTP.
  console.log(
    JSON.stringify({
      type: "RECEIPT_EMAIL_LOGGED",
      to,
      saleId,
      subject,
      at: new Date().toISOString(),
    }),
  );
  return { sent: false, to, mode: "logged" };
}
