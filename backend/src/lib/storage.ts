/**
 * Binary object storage for Harvestlink documents.
 *
 * Local disk volume in development; S3-compatible object store in production (env).
 * Files are never publicly served — callers stream via authenticated routes.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;

export type AllowedDocumentMimeType = (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

/** Max upload size — 15 MB. */
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export type StoredObjectMeta = {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: AllowedDocumentMimeType;
};

export type StoredObject = StoredObjectMeta & {
  body: Readable;
};

function assertMime(mimeType: string): asserts mimeType is AllowedDocumentMimeType {
  if (!(ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new AppError(400, "Only PDF, JPEG, and PNG documents are accepted", {
      mimeType,
      allowed: ALLOWED_DOCUMENT_MIME_TYPES,
    });
  }
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^\w.\-()+ ]+/g, "_").trim();
  return base.slice(0, 180) || "document";
}

function buildStorageKey(fileName: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `documents/${yyyy}/${mm}/${randomUUID()}-${sanitizeFileName(fileName)}`;
}

function localRoot(): string {
  return path.resolve(env.STORAGE_LOCAL_DIR);
}

function localPathForKey(storageKey: string): string {
  const root = localRoot();
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new AppError(400, "Invalid storage key");
  }
  return full;
}

let s3Client: S3Client | null = null;

function getS3(): { client: S3Client; bucket: string } {
  if (!env.S3_BUCKET) {
    throw new AppError(500, "S3_BUCKET is required when STORAGE_DRIVER=s3");
  }
  if (!s3Client) {
    s3Client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            }
          : undefined,
    });
  }
  return { client: s3Client, bucket: env.S3_BUCKET };
}

/**
 * Store bytes under a new key. Validates MIME and size; records sha256.
 */
export async function putObject(input: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}): Promise<StoredObjectMeta> {
  assertMime(input.mimeType);
  if (input.buffer.byteLength <= 0) {
    throw new AppError(400, "Empty file");
  }
  if (input.buffer.byteLength > MAX_DOCUMENT_BYTES) {
    throw new AppError(400, "File exceeds 15 MB limit", {
      sizeBytes: input.buffer.byteLength,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
  }

  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const storageKey = buildStorageKey(input.fileName);

  if (env.STORAGE_DRIVER === "s3") {
    const { client, bucket } = getS3();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: input.buffer,
        ContentType: input.mimeType,
        ContentLength: input.buffer.byteLength,
      }),
    );
  } else {
    const full = localPathForKey(storageKey);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, input.buffer);
  }

  return {
    storageKey,
    sha256,
    sizeBytes: input.buffer.byteLength,
    mimeType: input.mimeType,
  };
}

/** Open a readable stream for an object. Caller must pipe/consume it. */
export async function getObject(storageKey: string): Promise<StoredObject> {
  if (env.STORAGE_DRIVER === "s3") {
    const { client, bucket } = getS3();
    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: storageKey }),
    );
    if (!result.Body) throw new AppError(404, "Stored object not found");
    const body = result.Body as Readable;
    const mimeType = (result.ContentType ?? "application/octet-stream") as AllowedDocumentMimeType;
    return {
      storageKey,
      body,
      sha256: "",
      sizeBytes: result.ContentLength ?? 0,
      mimeType,
    };
  }

  const full = localPathForKey(storageKey);
  try {
    const stat = await fs.stat(full);
    return {
      storageKey,
      body: createReadStream(full),
      sha256: "",
      sizeBytes: stat.size,
      mimeType: "application/pdf",
    };
  } catch {
    throw new AppError(404, "Stored object not found");
  }
}

/** Delete bytes from storage. Does not touch the Document DB row. */
export async function deleteObject(storageKey: string): Promise<void> {
  if (env.STORAGE_DRIVER === "s3") {
    const { client, bucket } = getS3();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    return;
  }
  const full = localPathForKey(storageKey);
  try {
    await fs.unlink(full);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}
