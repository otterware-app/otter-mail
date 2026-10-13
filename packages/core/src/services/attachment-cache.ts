/**
 * attachment-cache.ts
 *
 * Local-first byte cache for mail attachments (the app's attachment-cache/
 * folder). File names hash accountId:messageId:attachmentId — Gmail
 * attachment ids run far past filesystem name limits. getAttachmentBytes
 * writes through it, and mail-sync prefetches draft attachments so resuming a
 * draft is instant. Best-effort throughout: a cache failure must never break
 * the mail flow.
 */

import { sha256Hex, toBase64 } from "../bytes.js";
import { platform } from "../platform.js";
import { providerFor } from "../providers/index.js";
import { getStoredDraftRevision } from "./mail-store.js";

const DIR = "attachment-cache";
const MAX_CACHE_BYTES = 512 * 1024 * 1024;

async function pathFor(accountId: string, messageId: string, attachmentId: string) {
  let revision: string | null = null;
  try {
    revision = getStoredDraftRevision(accountId, messageId);
  } catch {
    /* Cache lookup remains best-effort. */
  }
  // Outlook reuses both the draft's message ID and MIME attachment indexes.
  const key = `${accountId}:${messageId}:${attachmentId}${revision ? `:${revision}` : ""}`;
  return `${DIR}/${await sha256Hex(key)}`;
}

export async function getCachedAttachment(
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array | null> {
  try {
    const bytes = await platform().files.read(await pathFor(accountId, messageId, attachmentId));
    return bytes && bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

export async function hasCachedAttachment(
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<boolean> {
  return (await getCachedAttachment(accountId, messageId, attachmentId)) !== null;
}

export async function putCachedAttachment(
  accountId: string,
  messageId: string,
  attachmentId: string,
  bytes: Uint8Array,
): Promise<void> {
  try {
    await platform().files.write(await pathFor(accountId, messageId, attachmentId), bytes);
  } catch {
    // best-effort
  }
}

/** Attachment bytes. Local-first: served from the cache when present, write-through otherwise. */
export async function getAttachmentBytes(
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const path = await pathFor(accountId, messageId, attachmentId);
  try {
    const cached = await platform().files.read(path);
    if (cached && cached.length > 0) return cached;
  } catch {
    /* Cache lookup is best-effort. */
  }
  const bytes = await providerFor(accountId).fetchAttachment(accountId, messageId, attachmentId);
  // Keep the revision captured at the start if a draft changes during the read.
  try {
    await platform().files.write(path, bytes);
  } catch {
    /* Cache writes are best-effort. */
  }
  return bytes;
}

/** Attachment bytes as standard base64 (for forwarding / in-memory use). */
export async function getAttachmentData(
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<{ base64: string; size: number }> {
  const bytes = await getAttachmentBytes(accountId, messageId, attachmentId);
  return { base64: toBase64(bytes), size: bytes.length };
}

/** Saves an attachment where the user chooses (a save dialog, or a download). */
export async function saveAttachment(
  accountId: string,
  messageId: string,
  attachmentId: string,
  filename: string,
): Promise<{ saved: boolean }> {
  const bytes = await getAttachmentBytes(accountId, messageId, attachmentId);
  return { saved: await platform().userFiles.save(filename, bytes) };
}

/** Drop oldest files once the cache passes the size cap (run at startup). */
export async function pruneAttachmentCache(): Promise<void> {
  try {
    const files = await platform().files.list(DIR);
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= MAX_CACHE_BYTES) return;
    files.sort((a, b) => a.modifiedAt - b.modifiedAt);
    for (const f of files) {
      if (total <= MAX_CACHE_BYTES) break;
      await platform()
        .files.remove(`${DIR}/${f.name}`)
        .catch(() => {});
      total -= f.size;
    }
  } catch {
    // best-effort
  }
}
