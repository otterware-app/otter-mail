/**
 * The mail tools: find, read, sort and write mail in any of the user's
 * mailboxes. Conversations are threads, labels are the vocabulary for every
 * provider (an IMAP folder is a label; archiving removes INBOX; read and
 * starred are UNREAD and STARRED), as everywhere else in core.
 */

import { toBase64 } from "../../../bytes.js";
import { providerFor } from "../../../providers/index.js";
import {
  ALL_MAIL_LABEL_ID,
  type ComposeAttachment,
  type GmailAccount,
  type GmailLabel,
  type GmailMessageDetail,
  type GmailMessageSummary,
} from "../../../types.js";
import { getAttachmentBytes } from "../../attachment-cache.js";
import * as mailStore from "../../mail-store.js";
import { turnedOffMailboxes } from "../../mail-sync.js";
import { splitAddressList } from "../../outgoing.js";
import {
  address,
  bodyText,
  decodeEntities,
  escapeHtml,
  fullDate,
  htmlToText,
  localTime,
  textToHtml,
  withoutQuote,
} from "./text.js";
import {
  invoke,
  listMailboxes,
  mailbox,
  mailboxes,
  optBool,
  optInt,
  optStr,
  str,
  strList,
  type AgentTool,
  type ToolArgs,
  type ToolContext,
} from "./tool.js";

// ── Labels ───────────────────────────────────────────────────────────────────

/** Names agents use for the labels every mailbox has. */
const LABEL_ALIASES: Record<string, string> = {
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  drafts: "DRAFT",
  spam: "SPAM",
  junk: "SPAM",
  trash: "TRASH",
  starred: "STARRED",
  unread: "UNREAD",
  important: "IMPORTANT",
  all: ALL_MAIL_LABEL_ID,
  "all mail": ALL_MAIL_LABEL_ID,
  archive: ALL_MAIL_LABEL_ID,
};

export function labelsOf(account: GmailAccount): Promise<GmailLabel[]> {
  return invoke<GmailLabel[]>("gmail:listLabels", { accountId: account.id });
}

/** A label's id from its name, id or alias. */
export function labelId(account: GmailAccount, labels: GmailLabel[], ref: string): string {
  const wanted = ref.trim().toLowerCase();
  if (LABEL_ALIASES[wanted]) return LABEL_ALIASES[wanted];
  const found = labels.find(
    (l) => l.id.toLowerCase() === wanted || l.name.toLowerCase() === wanted,
  );
  if (found) return found.id;
  const names = labels.filter((l) => l.type === "user").map((l) => l.name);
  throw new Error(
    `No label "${ref}" in ${account.email}. Its labels: inbox, sent, drafts, spam, trash, starred, unread${names.length ? `, ${names.join(", ")}` : ""}.`,
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** One conversation in a list, as agents get it. */
function threadRow(m: GmailMessageSummary, account: GmailAccount, labels: GmailLabel[]) {
  const names = new Map(labels.map((l) => [l.id, l.name]));
  const labelIds = (m.threadLabelIds ?? m.labelIds).filter(
    (id) => id !== "UNREAD" && id !== "STARRED",
  );
  return {
    account: account.email,
    threadId: m.threadId,
    messageId: m.id,
    date: localTime(m.date),
    from: address(m.fromName, m.fromEmail),
    to: m.to,
    subject: m.subject,
    snippet: decodeEntities(m.snippet),
    unread: m.threadUnread ?? m.unread,
    starred: m.threadStarred ?? m.starred,
    ...(m.threadCount && m.threadCount > 1 ? { messages: m.threadCount } : {}),
    ...(m.hasAttachments ? { attachments: true } : {}),
    labels: labelIds.map((id) => names.get(id) ?? id),
  };
}

/** Rows from several mailboxes (each row carries its accountId). */
async function threadRows(accounts: GmailAccount[], messages: GmailMessageSummary[]) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const labels = new Map<string, GmailLabel[]>();
  for (const id of new Set(messages.map((m) => m.accountId ?? ""))) {
    const account = byId.get(id);
    if (account) labels.set(id, await labelsOf(account));
  }
  return messages.flatMap((m) => {
    const account = byId.get(m.accountId ?? "");
    return account ? [threadRow(m, account, labels.get(account.id) ?? [])] : [];
  });
}

const BODY_LIMIT = 30_000;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[… cut: ${text.length} characters]` : text;
}

/** The subjects of some conversations, for approvals. */
function subjects(account: GmailAccount, threadIds: string[]): string {
  const shown = threadIds.slice(0, 5).map((id) => {
    const first = mailStore.getThreadMessages(account.id, id)[0];
    return first ? `“${first.subject || "(no subject)"}”` : id;
  });
  return shown.join(", ") + (threadIds.length > 5 ? ` and ${threadIds.length - 5} more` : "");
}

/** The conversations an argument names, each one known on this device. */
function threads(args: ToolArgs, account: GmailAccount): string[] {
  const ids = strList(args, "threadIds");
  if (!ids?.length) throw new Error(`"threadIds" is required.`);
  for (const id of ids) {
    if (mailStore.getThreadMessages(account.id, id).length === 0)
      throw new Error(`No conversation ${id} in ${account.email} on this device.`);
  }
  return ids;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ── Writing ──────────────────────────────────────────────────────────────────

type Composed = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  threadId?: string;
  replyToMessageId?: string;
  attachments: ComposeAttachment[];
};

const emailOf = (entry: string) => (entry.match(/<([^>]+)>/)?.[1] ?? entry).trim().toLowerCase();

/** Who a reply goes to, as the reader's Reply and Reply all work it out. */
function replyRecipients(source: GmailMessageDetail, ownEmail: string, all: boolean) {
  const own = ownEmail.toLowerCase();
  const sender = address(source.fromName, source.fromEmail);
  // Replying to your own message goes to its recipients instead.
  const fromSelf = source.fromEmail.toLowerCase() === own;
  if (!all) return { to: fromSelf ? source.to : sender, cc: undefined };
  const seen = new Set([own]);
  const to: string[] = [];
  const cc: string[] = [];
  if (!fromSelf) {
    to.push(sender);
    seen.add(source.fromEmail.toLowerCase());
  }
  for (const [list, into] of [
    [source.to, fromSelf ? to : cc],
    [source.cc ?? "", cc],
  ] as const) {
    for (const entry of splitAddressList(list)) {
      const email = emailOf(entry);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      into.push(entry);
    }
  }
  if (to.length === 0) to.push(sender);
  return { to: to.join(", "), cc: cc.length > 0 ? cc.join(", ") : undefined };
}

/** "Re: x" / "Fwd: x", without stacking prefixes. */
function prefixed(prefix: "Re" | "Fwd", subject: string): string {
  const already = prefix === "Re" ? /^re:/i : /^(fwd?|fw):/i;
  return already.test(subject.trim()) ? subject : `${prefix}: ${subject}`;
}

const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  ics: "text/calendar",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const mimeTypeOf = (name: string) =>
  MIME_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/**
 * A message from the tool's arguments, as the composer would write it: a
 * reply threads, answers the right people and quotes the message; a forward
 * carries the message and its attachments; the account's signature follows
 * the body.
 */
async function compose(args: ToolArgs, account: GmailAccount, ctx: ToolContext): Promise<Composed> {
  const replyTo = optStr(args, "replyTo");
  const forward = optStr(args, "forward");
  if (replyTo && forward) throw new Error(`Use "replyTo" or "forward", not both.`);
  const sourceId = replyTo ?? forward;
  const source = sourceId
    ? await invoke<GmailMessageDetail>("gmail:getMessage", {
        accountId: account.id,
        messageId: sourceId,
      })
    : null;

  let to = optStr(args, "to");
  let cc = optStr(args, "cc");
  let subject = optStr(args, "subject");
  let quoteText = "";
  let quoteHtml = "";
  const attachments: ComposeAttachment[] = [];

  if (source && replyTo) {
    const recipients = replyRecipients(source, account.email, optBool(args, "replyAll") ?? false);
    to ??= recipients.to;
    cc ??= recipients.cc;
    subject ??= prefixed("Re", source.subject);
    const intro = `On ${fullDate(source.date)}, ${address(source.fromName, source.fromEmail)} wrote:`;
    const quoted = bodyText(source);
    quoteText = `\n\n${intro}\n${quoted
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n")}`;
    quoteHtml =
      `<br><div class="gmail_quote"><div>${escapeHtml(intro)}</div>` +
      `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">` +
      `${source.bodyHtml ?? textToHtml(quoted)}</blockquote></div>`;
  }
  if (source && forward) {
    subject ??= prefixed("Fwd", source.subject);
    const head = [
      "---------- Forwarded message ----------",
      `From: ${address(source.fromName, source.fromEmail)}`,
      `Date: ${fullDate(source.date)}`,
      `Subject: ${source.subject}`,
      `To: ${source.to}`,
    ];
    quoteText = `\n\n${head.join("\n")}\n\n${bodyText(source)}`;
    quoteHtml =
      `<br><div class="gmail_quote">${head.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}` +
      `<br>${source.bodyHtml ?? textToHtml(bodyText(source))}</div>`;
    for (const a of source.attachments) {
      const bytes = await getAttachmentBytes(account.id, source.id, a.id);
      attachments.push({
        name: a.filename,
        mimeType: a.mimeType,
        size: bytes.length,
        base64: toBase64(bytes),
      });
    }
  }
  for (const path of strList(args, "attachments") ?? []) {
    if (!ctx.caller.files) throw new Error("Attaching files needs the Mac app.");
    const file = await ctx.caller.files.read(path);
    attachments.push({
      name: file.name,
      mimeType: mimeTypeOf(file.name),
      size: file.bytes.length,
      base64: toBase64(file.bytes),
    });
  }

  const body = typeof args.body === "string" ? args.body.trimEnd() : "";
  const signature = account.signature?.trim();
  return {
    to: to ?? "",
    cc,
    bcc: optStr(args, "bcc"),
    subject: subject ?? "",
    body: body + (signature ? `\n\n-- \n${htmlToText(signature)}` : "") + quoteText,
    ...(signature || quoteHtml
      ? {
          bodyHtml:
            textToHtml(body) +
            (signature ? `<br><br><div data-signature="">${signature}</div>` : "") +
            quoteHtml,
        }
      : {}),
    threadId: source && replyTo ? source.threadId : undefined,
    replyToMessageId: replyTo,
    attachments,
  };
}

/** The message as the approval shows it. */
function describeMail(account: GmailAccount, mail: Composed, body: string): string {
  return [
    `From: ${account.email}`,
    `To: ${mail.to || "(nobody yet)"}`,
    ...(mail.cc ? [`Cc: ${mail.cc}`] : []),
    ...(mail.bcc ? [`Bcc: ${mail.bcc}`] : []),
    `Subject: ${mail.subject || "(no subject)"}`,
    ...(mail.attachments.length
      ? [`Attachments: ${mail.attachments.map((a) => a.name).join(", ")}`]
      : []),
    "",
    clip(body.trim(), 600),
  ].join("\n");
}

const COMPOSE_INPUT = {
  account: { type: "string", description: "The mailbox to send from (its address)." },
  to: {
    type: "string",
    description: "Recipients, comma-separated. Replies fill it in when left out.",
  },
  cc: { type: "string" },
  bcc: { type: "string" },
  subject: { type: "string", description: "Replies and forwards fill it in when left out." },
  body: {
    type: "string",
    description:
      "Plain text. The mailbox's signature and, for replies and forwards, the original message are added below it.",
  },
  replyTo: {
    type: "string",
    description:
      "A messageId to reply to: the reply joins its conversation, goes to its sender (with replyAll, everyone on it) and quotes it.",
  },
  replyAll: { type: "boolean" },
  forward: {
    type: "string",
    description: "A messageId to forward, with its attachments. Needs `to`.",
  },
  attachments: {
    type: "array",
    items: { type: "string" },
    description: "Paths of files on this Mac to attach.",
  },
} as const;

// ── The tools ────────────────────────────────────────────────────────────────

const ACCOUNT = {
  type: "string",
  description: "The mailbox, by address. Optional when there's only one.",
} as const;

export const mailTools: AgentTool[] = [
  {
    name: "list_accounts",
    title: "List mailboxes",
    description:
      "The user's mailboxes (Gmail, IMAP, …) in Otter Mail: each one's address, provider, and whether it has a calendar. Every other tool names a mailbox by its address.",
    input: { type: "object", properties: {} },
    readOnly: true,
    async run() {
      const accounts = await listMailboxes();
      const off = turnedOffMailboxes();
      return {
        mailboxes: accounts.map((a) => ({
          account: a.email,
          name: a.displayName || a.name,
          provider: a.provider ?? "gmail",
          calendar: a.capabilities?.calendar ?? false,
          // IMAP: a message sits in one folder, so adding a label moves it.
          labels: a.capabilities?.multipleLabels ? "labels" : "folders",
          ...(a.signedOut ? { signedOut: true } : {}),
          // Turned off on this device: left out unless named.
          ...(off.has(a.id) ? { turnedOff: true } : {}),
        })),
      };
    },
  },
  {
    name: "list_labels",
    title: "List labels",
    description:
      "A mailbox's labels (IMAP: its folders), with unread and total counts. Tools take a label by name.",
    input: { type: "object", properties: { account: ACCOUNT } },
    readOnly: true,
    async run(args) {
      const account = await mailbox(args);
      const labels = await labelsOf(account);
      return {
        labels: labels.map((l) => ({
          name: l.name,
          type: l.type,
          ...(l.unread ? { unread: l.unread } : {}),
          ...(l.total !== undefined ? { total: l.total } : {}),
        })),
      };
    },
  },
  {
    name: "list_threads",
    title: "List conversations",
    description:
      "The newest conversations in a label (default the inbox), from every mailbox unless one is named. Reads what Otter Mail has on this device, filling in from the server as needed.",
    input: {
      type: "object",
      properties: {
        account: { type: "string", description: "One mailbox, by address; default every one." },
        label: {
          type: "string",
          description:
            "inbox (default), sent, drafts, starred, spam, trash, all, or a label's name.",
        },
        unreadOnly: { type: "boolean" },
        limit: { type: "number", description: "Default 25, at most 100." },
        cursor: { type: "string", description: "The previous page's cursor, for the next page." },
      },
    },
    readOnly: true,
    async run(args) {
      const accounts = optStr(args, "account") ? [await mailbox(args)] : await mailboxes({});
      const ref = optStr(args, "label") ?? "inbox";
      const unread = optBool(args, "unreadOnly") ? ["UNREAD"] : [];
      const rules = [];
      for (const account of accounts) {
        let id: string;
        try {
          id = labelId(account, await labelsOf(account), ref);
        } catch (error) {
          // A label only some mailboxes have lists theirs.
          if (accounts.length === 1) throw error;
          continue;
        }
        const all = id === ALL_MAIL_LABEL_ID;
        rules.push({
          accountId: account.id,
          allOf: all ? unread : [id, ...unread],
          noneOf: all ? ["SPAM", "TRASH"] : [],
        });
      }
      const page = await invoke<{ messages: GmailMessageSummary[]; nextPageToken?: string }>(
        "gmail:listCombinedMessages",
        { rules, maxResults: optInt(args, "limit", 100) ?? 25, pageToken: optStr(args, "cursor") },
      );
      return { threads: await threadRows(accounts, page.messages), cursor: page.nextPageToken };
    },
  },
  {
    name: "search_mail",
    title: "Search mail",
    description:
      "Searches every mailbox (or those named) and answers matching conversations, newest first, up to 50 per mailbox per page. Gmail's search syntax: words, and operators like from:, to:, subject:, has:attachment, is:unread, is:starred, in:inbox, label:, newer_than:7d, older_than:1y, after:2026/01/31, before:, -word. Gmail runs it on the server; mailboxes without server search run the same operators on what's on this device.",
    input: {
      type: "object",
      properties: {
        query: { type: "string" },
        accounts: {
          type: "array",
          items: { type: "string" },
          description: "Mailboxes to search, by address; default every one.",
        },
        cursor: { type: "string", description: "The previous page's cursor, for the next page." },
      },
      required: ["query"],
    },
    readOnly: true,
    async run(args) {
      const accounts = await mailboxes(args);
      const cursor = optStr(args, "cursor");
      const result = await invoke<{
        messages: GmailMessageSummary[];
        cursors?: Record<string, string | null>;
        estimate: number;
        offline?: boolean;
      }>("gmail:search", {
        q: str(args, "query"),
        accountIds: accounts.map((a) => a.id),
        cursors: cursor ? JSON.parse(cursor) : undefined,
      });
      return {
        threads: await threadRows(accounts, result.messages),
        estimate: result.estimate,
        ...(result.cursors ? { cursor: JSON.stringify(result.cursors) } : {}),
        ...(result.offline ? { note: "Offline: only mail on this device was searched." } : {}),
      };
    },
  },
  {
    name: "get_thread",
    title: "Read a conversation",
    description:
      "A whole conversation: every message's sender, recipients, date, text and attachments (oldest first). Quoted history is left out of each message unless includeQuoted is set, since the earlier messages are there. Reading doesn't mark it read.",
    input: {
      type: "object",
      properties: {
        account: ACCOUNT,
        threadId: { type: "string" },
        includeQuoted: { type: "boolean" },
      },
      required: ["threadId"],
    },
    readOnly: true,
    async run(args) {
      const account = await mailbox(args);
      const threadId = str(args, "threadId");
      let summaries = mailStore.getThreadMessages(account.id, threadId);
      const provider = providerFor(account.id);
      if (summaries.length === 0 && provider.getThread) {
        mailStore.upsertMessageDetails(account.id, await provider.getThread(account.id, threadId));
        summaries = mailStore.getThreadMessages(account.id, threadId);
      }
      if (summaries.length === 0)
        throw new Error(
          `No conversation ${threadId} in ${account.email}. Find it with search_mail.`,
        );
      const quoted = optBool(args, "includeQuoted") ?? false;
      const labels = await labelsOf(account);
      const messages = await Promise.all(
        summaries.map(async (m) => {
          const d = await invoke<GmailMessageDetail>("gmail:getMessage", {
            accountId: account.id,
            messageId: m.id,
          });
          const draft = d.labelIds.includes("DRAFT")
            ? (
                await invoke<{ draftId: string | null }>("gmail:getDraftForMessage", {
                  accountId: account.id,
                  messageId: d.id,
                  threadId,
                })
              ).draftId
            : null;
          const text = bodyText(d);
          return {
            messageId: d.id,
            date: localTime(d.date),
            from: address(d.fromName, d.fromEmail),
            to: d.to,
            ...(d.cc ? { cc: d.cc } : {}),
            ...(d.subject !== summaries[0].subject ? { subject: d.subject } : {}),
            ...(d.unread ? { unread: true } : {}),
            ...(draft ? { draftId: draft } : {}),
            body: clip(quoted ? text : withoutQuote(text), BODY_LIMIT),
            ...(d.attachments.length
              ? {
                  attachments: d.attachments.map((a) => ({
                    attachmentId: a.id,
                    filename: a.filename,
                    mimeType: a.mimeType,
                    size: a.size,
                  })),
                }
              : {}),
          };
        }),
      );
      // The conversation's labels: every message's (a thread is in the inbox if any message is).
      const row = threadRow(
        { ...summaries[0], threadLabelIds: [...new Set(summaries.flatMap((m) => m.labelIds))] },
        account,
        labels,
      );
      return {
        account: account.email,
        threadId,
        subject: summaries[0].subject,
        labels: row.labels,
        starred: summaries.some((m) => m.starred),
        messages,
      };
    },
  },
  {
    name: "get_attachment",
    title: "Download an attachment",
    description:
      "Saves one of a message's attachments (from get_thread) to a file on this device and answers its path. The connected agent also receives supported file content.",
    input: {
      type: "object",
      properties: {
        account: ACCOUNT,
        messageId: { type: "string" },
        attachmentId: { type: "string" },
      },
      required: ["messageId", "attachmentId"],
    },
    readOnly: true,
    needsFiles: true,
    async run(args, ctx) {
      const account = await mailbox(args);
      const messageId = str(args, "messageId");
      const attachmentId = str(args, "attachmentId");
      const detail = await invoke<GmailMessageDetail>("gmail:getMessage", {
        accountId: account.id,
        messageId,
      });
      const meta = detail.attachments.find((a) => a.id === attachmentId);
      if (!meta) throw new Error(`Message ${messageId} has no attachment ${attachmentId}.`);
      const bytes = await getAttachmentBytes(account.id, messageId, attachmentId);
      const path = await ctx.caller.files!.save(meta.filename || "attachment", bytes);
      return { path, filename: meta.filename, mimeType: meta.mimeType, size: bytes.length };
    },
  },
  {
    name: "update_threads",
    title: "Update conversations",
    description:
      "Archives, moves back to the inbox, marks read or unread, stars or unstars, and adds or removes labels on conversations of one mailbox. In IMAP mailboxes a message is in one folder: adding a label moves it there.",
    input: {
      type: "object",
      properties: {
        account: ACCOUNT,
        threadIds: { type: "array", items: { type: "string" } },
        archive: { type: "boolean", description: "Out of the inbox." },
        moveToInbox: { type: "boolean" },
        read: { type: "boolean", description: "true: mark read; false: mark unread." },
        starred: { type: "boolean" },
        addLabels: { type: "array", items: { type: "string" }, description: "Label names." },
        removeLabels: { type: "array", items: { type: "string" } },
      },
      required: ["threadIds"],
    },
    async run(args, ctx) {
      const account = await mailbox(args);
      const ids = threads(args, account);
      const labels = await labelsOf(account);
      const add = new Set<string>();
      const remove = new Set<string>();
      const done: string[] = [];
      const archive = optBool(args, "archive");
      const inbox = optBool(args, "moveToInbox");
      if (archive && inbox) throw new Error(`"archive" and "moveToInbox" contradict each other.`);
      if (archive) {
        remove.add("INBOX");
        done.push("archive");
      }
      if (inbox) {
        add.add("INBOX");
        done.push("move to the inbox");
      }
      const read = optBool(args, "read");
      if (read !== undefined) {
        (read ? remove : add).add("UNREAD");
        done.push(read ? "mark read" : "mark unread");
      }
      const starred = optBool(args, "starred");
      if (starred !== undefined) {
        (starred ? add : remove).add("STARRED");
        done.push(starred ? "star" : "unstar");
      }
      for (const [key, into, verb] of [
        ["addLabels", add, "label"],
        ["removeLabels", remove, "unlabel"],
      ] as const) {
        const names = strList(args, key) ?? [];
        for (const name of names) into.add(labelId(account, labels, name));
        if (names.length) done.push(`${verb} ${names.join(", ")}`);
      }
      if (add.size === 0 && remove.size === 0) throw new Error("Nothing to change.");
      const action = done.join(", ");
      await ctx.confirm(
        `${action[0].toUpperCase()}${action.slice(1)}: ${plural(ids.length, "conversation")} in ${account.email}\n${subjects(account, ids)}`,
      );
      for (const threadId of ids) {
        const title =
          mailStore.getThreadMessages(account.id, threadId)[0]?.subject || "(no subject)";
        await invoke("gmail:modifyThread", {
          accountId: account.id,
          threadId,
          addLabelIds: [...add],
          removeLabelIds: [...remove],
        });
        ctx.changed?.({
          action: "updated",
          title,
          target: { kind: "thread", id: threadId, accountId: account.id },
        });
      }
      return { updated: ids.length };
    },
  },
  {
    name: "trash_threads",
    title: "Move to Trash",
    description:
      "Moves conversations of one mailbox to the Trash (restore_threads brings them back).",
    input: {
      type: "object",
      properties: { account: ACCOUNT, threadIds: { type: "array", items: { type: "string" } } },
      required: ["threadIds"],
    },
    async run(args, ctx) {
      const account = await mailbox(args);
      const ids = threads(args, account);
      await ctx.confirm(
        `Move ${plural(ids.length, "conversation")} in ${account.email} to the Trash\n${subjects(account, ids)}`,
      );
      for (const threadId of ids) {
        const title =
          mailStore.getThreadMessages(account.id, threadId)[0]?.subject || "(no subject)";
        await invoke("gmail:trashThread", { accountId: account.id, threadId });
        ctx.changed?.({
          action: "trashed",
          title,
          target: { kind: "thread", id: threadId, accountId: account.id },
        });
      }
      return { trashed: ids.length };
    },
  },
  {
    name: "restore_threads",
    title: "Restore from Trash",
    description: "Takes conversations out of the Trash, back where they were.",
    input: {
      type: "object",
      properties: { account: ACCOUNT, threadIds: { type: "array", items: { type: "string" } } },
      required: ["threadIds"],
    },
    async run(args, ctx) {
      const account = await mailbox(args);
      const ids = threads(args, account);
      await ctx.confirm(
        `Restore ${plural(ids.length, "conversation")} in ${account.email} from the Trash\n${subjects(account, ids)}`,
      );
      for (const threadId of ids) {
        const title =
          mailStore.getThreadMessages(account.id, threadId)[0]?.subject || "(no subject)";
        await invoke("gmail:untrashThread", { accountId: account.id, threadId });
        ctx.changed?.({
          action: "restored",
          title,
          target: { kind: "thread", id: threadId, accountId: account.id },
        });
      }
      return { restored: ids.length };
    },
  },
  {
    name: "create_label",
    title: "Create a label",
    description: "Creates a label (IMAP: a folder). Nest with slashes: Projects/Otter.",
    input: {
      type: "object",
      properties: { account: ACCOUNT, name: { type: "string" } },
      required: ["name"],
    },
    async run(args, ctx) {
      const account = await mailbox(args);
      const name = str(args, "name");
      await ctx.confirm(`Create the label “${name}” in ${account.email}`);
      const label = await invoke<GmailLabel>("gmail:createLabel", { accountId: account.id, name });
      ctx.changed?.({
        action: "created",
        title: label.name,
        target: { kind: "label", id: label.id, accountId: account.id },
      });
      return { name: label.name };
    },
  },
  {
    name: "save_draft",
    title: "Save a draft",
    description:
      "Writes a message into the mailbox's Drafts without sending it, for the user to review and send from Otter Mail. The safe way to prepare mail. With draftId, replaces that draft.",
    input: {
      type: "object",
      properties: {
        ...COMPOSE_INPUT,
        account: { type: "string", description: "The mailbox the draft is in (its address)." },
        draftId: { type: "string", description: "The draft to replace." },
      },
    },
    // A draft sends nothing and is the user's to look at: no approval.
    async run(args, ctx) {
      const account = await mailbox(args);
      const mail = await compose(args, account, ctx);
      const saved = await invoke<{ draftId: string; threadId?: string }>("gmail:saveDraft", {
        accountId: account.id,
        draftId: optStr(args, "draftId"),
        to: mail.to,
        cc: mail.cc,
        bcc: mail.bcc,
        subject: mail.subject,
        body: mail.body,
        bodyHtml: mail.bodyHtml,
        threadId: mail.threadId,
        attachments: mail.attachments,
      });
      ctx.changed?.({
        action: optStr(args, "draftId") ? "updated" : "created",
        title: mail.subject || "(no subject)",
        target: { kind: "draft", id: saved.draftId, accountId: account.id },
      });
      return { draftId: saved.draftId, threadId: saved.threadId };
    },
  },
  {
    name: "delete_draft",
    title: "Delete a draft",
    permanent: true,
    description: "Deletes a draft (its draftId is in get_thread).",
    input: {
      type: "object",
      properties: { account: ACCOUNT, draftId: { type: "string" } },
      required: ["draftId"],
    },
    async run(args, ctx) {
      const account = await mailbox(args);
      const draftId = str(args, "draftId");
      await ctx.confirm(`Delete draft ${draftId} in ${account.email}`);
      await invoke("gmail:deleteDraft", { accountId: account.id, draftId });
      ctx.changed?.({
        action: "deleted",
        title: "Draft",
        target: { kind: "draft", id: draftId, accountId: account.id },
      });
      return { deleted: true };
    },
  },
  {
    name: "send_email",
    title: "Send email",
    permanent: true,
    description:
      "Sends a message: new, a reply (replyTo) or a forward (forward). Only when the user asked for it to be sent; otherwise use save_draft. With draftId, that draft is deleted once it's sent.",
    input: {
      type: "object",
      properties: {
        ...COMPOSE_INPUT,
        draftId: { type: "string", description: "A draft this message replaces." },
      },
    },
    async run(args, ctx) {
      const account = await mailbox(args);
      const mail = await compose(args, account, ctx);
      if (!mail.to) throw new Error(`"to" is required.`);
      const body = typeof args.body === "string" ? args.body : "";
      await ctx.confirm(describeMail(account, mail, body));
      const result = await invoke<{ pending?: boolean }>("gmail:sendMessage", {
        accountId: account.id,
        ...mail,
      });
      const draftId = optStr(args, "draftId");
      if (draftId) {
        await invoke("gmail:deleteDraft", { accountId: account.id, draftId })
          .then(() =>
            ctx.changed?.({
              action: "deleted",
              title: mail.subject || "Draft",
              target: { kind: "draft", id: draftId, accountId: account.id },
            }),
          )
          .catch(() => {});
      }
      return result.pending
        ? {
            sent: true,
            note: "Still uploading. If it fails, the message goes to Drafts and the user is told.",
          }
        : { sent: true };
    },
  },
];
