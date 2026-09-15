/**
 * Encrypts member PII at rest (taxIdLast4) using AES-256-GCM.
 * Key is derived from MEMBER_PII_KEY or JWT_SECRET — rotate carefully.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

function keyBytes(): Buffer {
  const secret = process.env.MEMBER_PII_KEY || env.JWT_SECRET;
  return createHash("sha256").update(secret).digest();
}

/** Encrypts a short string (e.g. last-4 SSN). Returns base64(iv|tag|ciphertext). */
export function encryptTaxIdLast4(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptTaxIdLast4(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
