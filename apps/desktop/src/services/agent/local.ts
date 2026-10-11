/**
 * Where agents on this Mac work: Codex's and Claude's workspace, the absolute
 * paths of the attachments core stages in the app's files, and the files
 * Otter Mail's tools hand any agent here.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ATTACHMENTS_DIR,
  type ChatAttachment,
  type Platform,
  type ToolFiles,
  chatFile,
  chatFilePath,
  MAX_CHAT_FILE_BYTES,
} from "@otter-mail/core";

import { appInfo } from "../../backend-protocol.js";
import { requestMain } from "../../main-link.js";

/**
 * Codex threads started from Otter Mail run here (their cwd), so they're listable as ours.
 * Named when agents were "assistants": renaming it would orphan those threads.
 */
export async function agentWorkspace(): Promise<string> {
  const dir = path.join(appInfo().stateDir, "assistant-workspace");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Read agent output on this computer, resolving relative links in its workspace. */
export async function readAgentFile(href: string) {
  const file = chatFilePath(href);
  const resolved = file.startsWith("~/")
    ? path.join(os.homedir(), file.slice(2))
    : path.resolve(await agentWorkspace(), file);
  const handle = await fs.open(resolved, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("That link doesn't point to a file.");
    if (stat.size > MAX_CHAT_FILE_BYTES)
      throw new Error("That file is too large to preview (50 MB max).");
    return chatFile(path.basename(resolved), new Uint8Array(await handle.readFile()));
  } finally {
    await handle.close();
  }
}

export async function attachmentsDir(): Promise<string> {
  const dir = path.join(appInfo().stateDir, ATTACHMENTS_DIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function attachmentPath(attachment: ChatAttachment): string {
  return path.join(appInfo().stateDir, attachment.path);
}

/** The tools' files: attachments land in the attachments folder (Claude may read there). */
export const deviceFiles: ToolFiles = {
  async save(name, bytes) {
    const dir = path.join(await attachmentsDir(), "mail", randomUUID());
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, path.basename(name).replace(/^\.+/, "_") || "attachment");
    await fs.writeFile(file, bytes);
    return file;
  },
  async read(file) {
    const resolved = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
    if (!path.isAbsolute(resolved)) throw new Error(`Give the file's full path: ${file}`);
    return { name: path.basename(resolved), bytes: new Uint8Array(await fs.readFile(resolved)) };
  },
};

/**
 * Otter Code's attachment context, appended to the prompt for every
 * attachment (images too: tools can't read inlined pixels, but can read paths).
 */
export function withAttachmentPaths(text: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return text;
  const context = attachments
    .map((a) => `[Attached ${a.kind} "${a.name}" is saved at: ${attachmentPath(a)}]`)
    .join("\n");
  return text ? `${text}\n\n${context}` : context;
}

/** The Hermes key used to live in its own safeStorage file; it's a platform secret now. */
export async function migrateHermesKey(secrets: Platform["secrets"]): Promise<void> {
  const file = path.join(appInfo().stateDir, "assistant-chat.enc");
  const hex = await fs.readFile(file, "utf-8").catch(() => null);
  if (hex === null) return;
  try {
    const sealed = Buffer.from(hex.trim(), "hex").toString("base64");
    await secrets.set("assistant-hermes-key", await requestMain("unseal", { sealed }));
  } catch {
    // Unreadable: Hermes asks to connect again.
  }
  await fs.rm(file, { force: true });
}
