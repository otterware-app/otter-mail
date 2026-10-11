import { toBase64 } from "../../bytes.js";
import type { ChatFile } from "./types.js";

export const MAX_CHAT_FILE_BYTES = 50 * 1024 * 1024;

/** Agent file links may use a file URL, a sandbox URL, or a plain path. */
export function chatFilePath(href: string): string {
  let path = href;
  if (/^file:/i.test(path)) {
    const url = new URL(path);
    if (url.host && url.host !== "localhost") throw new Error("That file is on another computer.");
    path = url.pathname;
  } else if (/^sandbox:/i.test(path)) path = path.slice("sandbox:".length);
  return decodeURIComponent(path).replace(/:\d+(?:-\d+)?$/, "");
}

export function chatFile(name: string, bytes: Uint8Array, mimeType?: string): ChatFile {
  if (bytes.length > MAX_CHAT_FILE_BYTES)
    throw new Error("That file is too large to preview (50 MB max).");
  return {
    name,
    mimeType: mimeType || "application/octet-stream",
    size: bytes.length,
    data: toBase64(bytes),
  };
}

/** Downloads a provider-issued URL without forwarding the provider's credentials. */
export async function downloadChatFile(url: string): Promise<ChatFile> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body)
    throw new Error(`Couldn't load the file (HTTP ${response.status}).`);
  if (Number(response.headers.get("content-length")) > MAX_CHAT_FILE_BYTES)
    throw new Error("That file is too large to preview (50 MB max).");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_CHAT_FILE_BYTES) {
      await reader.cancel();
      throw new Error("That file is too large to preview (50 MB max).");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return chatFile(
    decodeURIComponent(new URL(url).pathname.split("/").pop() || "Image"),
    bytes,
    response.headers.get("content-type") ?? undefined,
  );
}
