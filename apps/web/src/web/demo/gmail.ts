import { fakeTodoist } from "./todoist";
/**
 * Demo mode (`pnpm dev:demo`, built with VITE_DEMO=1): a pretend Gmail in the
 * backend's Worker, so the web app runs with no Google or Otter account.
 *
 * `installFakeGmail` wraps the Worker's fetch: calls to the Gmail REST API are
 * answered from the seeded mailboxes (@otter-mail/shared/demo-mailboxes), which live in the demo's own
 * files and change as the app archives, labels, sends and drafts. Each change
 * goes into a history feed like Gmail's, so incremental sync sees it. Other
 * Google APIs answer empty, the relay "signed out", and everything else goes
 * to the network. `demoGoogleAuth` signs the demo accounts in.
 */

import {
  accountStore,
  fromBase64,
  toBase64,
  type GmailAccount,
  type GoogleAuth,
  type Platform,
} from "@otter-mail/core";

import { DEMO_ACCOUNTS, type SeedAccount } from "@otter-mail/shared/demo-mailboxes";

/** A seeded file's text as Gmail sends attachment data: base64url. */
const attachmentData = (content: string) =>
  toBase64(new TextEncoder().encode(content))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const DEMO_RELAY_URL = "https://relay.demo.invalid";

type Header = { name: string; value: string };

type Attachment = {
  id: string;
  filename: string;
  mimeType: string;
  /** base64url, as Gmail sends it. */
  data: string;
  size: number;
  contentId?: string;
};

type Message = {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  headers: Header[];
  text: string | null;
  html: string | null;
  attachments: Attachment[];
};

type Label = {
  id: string;
  name: string;
  type: "system" | "user";
  color?: { backgroundColor: string; textColor: string };
};

type Ref = { message: { id: string; threadId: string; labelIds?: string[] } };
type HistoryRecord = {
  id: string;
  messagesAdded?: Ref[];
  messagesDeleted?: Ref[];
  labelsAdded?: (Ref & { labelIds: string[] })[];
  labelsRemoved?: (Ref & { labelIds: string[] })[];
};

type Mailbox = {
  email: string;
  name: string;
  historyId: number;
  nextId: number;
  idPrefix: string;
  labels: Label[];
  messages: Record<string, Message>;
  /** Draft id → the message backing it. */
  drafts: Record<string, string>;
  history: HistoryRecord[];
  signature: string;
};

const STATE_FILE = "demo-gmail.json";
const STATE_VERSION = 1;
/** Every answer waits this long, so the app sees a network, not a function call. */
const LATENCY_MS = 30;

const SYSTEM_LABELS = [
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];

// ── Seeding ──────────────────────────────────────────────────────────────────

function newId(box: Mailbox): string {
  return `${box.idPrefix}${(box.nextId++).toString(16).padStart(12, "0")}`;
}

/** `Name <email>`, quoted when the name needs it (Gmail's headers are decoded). */
function address(person: { name: string; email: string }): string {
  if (!person.name) return person.email;
  return /[",<>@;:]/.test(person.name)
    ? `"${person.name.replace(/"/g, '\\"')}" <${person.email}>`
    : `${person.name} <${person.email}>`;
}

const rfc2822 = (time: number) => new Date(time).toUTCString().replace("GMT", "+0000");

function seedMailbox(seed: SeedAccount, index: number, seededAt: number): Mailbox {
  const box: Mailbox = {
    email: seed.email,
    name: seed.name,
    historyId: 1000,
    nextId: 1,
    idPrefix: `19${index}`,
    labels: SYSTEM_LABELS.map((id) => ({ id, name: id, type: "system" })),
    messages: {},
    drafts: {},
    history: [],
    signature: seed.signature,
  };
  const me = { name: seed.name, email: seed.email };
  seed.labels.forEach((label, i) =>
    box.labels.push({ id: `Label_${i + 1}`, name: label.name, type: "user", color: label.color }),
  );
  const labelId = (name: string) => box.labels.find((l) => l.name === name || l.id === name)!.id;

  for (const thread of seed.threads(seededAt)) {
    const threadLabels = thread.labels.map(labelId);
    const firstSender = thread.messages.find((m) => m.from)?.from;
    const threadId = newId(box);
    const ids: string[] = [];
    thread.messages.forEach((seedMessage, i) => {
      const id = i === 0 ? threadId : newId(box);
      const mine = !seedMessage.from;
      const from = seedMessage.from ?? me;
      const to = seedMessage.to ?? (mine ? (firstSender ? [firstSender] : []) : [me]);
      const labels = seedMessage.draft
        ? ["DRAFT"]
        : mine
          ? [
              "SENT",
              ...threadLabels.filter(
                (l) => !["INBOX", "SPAM", "TRASH"].includes(l) && !l.startsWith("CATEGORY_"),
              ),
            ]
          : [...threadLabels];
      if (seedMessage.unread) labels.push("UNREAD");
      if (seedMessage.starred) labels.push("STARRED");
      const date = seededAt - seedMessage.hoursAgo * 3_600_000;
      const headers: Header[] = [
        { name: "From", value: address(from) },
        ...(to.length > 0 ? [{ name: "To", value: to.map(address).join(", ") }] : []),
        ...(seedMessage.cc?.length
          ? [{ name: "Cc", value: seedMessage.cc.map(address).join(", ") }]
          : []),
        {
          name: "Subject",
          value: i === 0 || /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`,
        },
        { name: "Date", value: rfc2822(date) },
        { name: "Message-ID", value: `<${id}@${seed.email.split("@")[1]}>` },
        ...(ids.length > 0
          ? [
              { name: "In-Reply-To", value: `<${ids.at(-1)}@${seed.email.split("@")[1]}>` },
              {
                name: "References",
                value: ids.map((ref) => `<${ref}@${seed.email.split("@")[1]}>`).join(" "),
              },
            ]
          : []),
        ...Object.entries(seedMessage.headers ?? {}).map(([name, value]) => ({ name, value })),
      ];
      ids.push(id);
      box.messages[id] = {
        id,
        threadId,
        labelIds: labels,
        internalDate: date,
        headers,
        text: seedMessage.text,
        html: seedMessage.html ?? null,
        attachments: (seedMessage.attachments ?? []).map((a, n) => {
          const data = attachmentData(a.content);
          return {
            id: `ANGjdJ_${id}_${n}`,
            filename: a.filename,
            mimeType: a.mimeType,
            data,
            size: fromBase64(data).length,
            contentId: a.contentId,
          };
        }),
      };
      if (seedMessage.draft) box.drafts[`r-${id}`] = id;
    });
  }
  return box;
}

// ── State ────────────────────────────────────────────────────────────────────

type State = { version: number; seededAt: number; mailboxes: Record<string, Mailbox> };

let state: State;
let files: Platform["files"];
let saving: ReturnType<typeof setTimeout> | null = null;

function save(): void {
  saving ??= setTimeout(() => {
    saving = null;
    void files.write(STATE_FILE, JSON.stringify(state));
  }, 200);
}

async function loadState(): Promise<void> {
  const bytes = await files.read(STATE_FILE);
  if (bytes) {
    const saved = JSON.parse(new TextDecoder().decode(bytes)) as State;
    if (saved.version === STATE_VERSION) {
      state = saved;
      return;
    }
  }
  const seededAt = Date.now();
  state = {
    version: STATE_VERSION,
    seededAt,
    mailboxes: Object.fromEntries(
      DEMO_ACCOUNTS.map((seed, i) => [seed.email, seedMailbox(seed, i, seededAt)]),
    ),
  };
  await files.write(STATE_FILE, JSON.stringify(state));
}

// ── Changes (recorded in the history feed) ───────────────────────────────────

const ref = (m: Message): Ref => ({
  message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds },
});

function record(box: Mailbox, entry: Omit<HistoryRecord, "id">): void {
  box.historyId += 1;
  box.history.push({ id: String(box.historyId), ...entry });
  if (box.history.length > 2000) box.history.splice(0, box.history.length - 2000);
  save();
}

function modify(box: Mailbox, m: Message, add: string[], remove: string[]): void {
  const added = [...new Set(add)].filter((l) => !m.labelIds.includes(l));
  const removed = [...new Set(remove)].filter((l) => m.labelIds.includes(l) && !add.includes(l));
  if (added.length === 0 && removed.length === 0) return;
  m.labelIds = [...m.labelIds.filter((l) => !removed.includes(l)), ...added];
  record(box, {
    ...(added.length ? { labelsAdded: [{ ...ref(m), labelIds: added }] } : {}),
    ...(removed.length ? { labelsRemoved: [{ ...ref(m), labelIds: removed }] } : {}),
  });
}

function addMessage(box: Mailbox, m: Message): void {
  box.messages[m.id] = m;
  record(box, { messagesAdded: [ref(m)] });
}

function deleteMessage(box: Mailbox, id: string): void {
  const m = box.messages[id];
  if (!m) return;
  delete box.messages[id];
  for (const [draftId, messageId] of Object.entries(box.drafts)) {
    if (messageId === id) delete box.drafts[draftId];
  }
  record(box, { messagesDeleted: [ref(m)] });
}

// ── MIME (what the app sends: messages.send and drafts) ──────────────────────

function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bB]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?[^?]+\?[bB]\?([^?]*)\?=/g, (_m, data: string) =>
      new TextDecoder().decode(fromBase64(data)),
    );
}

type Entity = { headers: Header[]; body: string };

function parseEntity(raw: string): Entity {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? "" : raw.slice(split).replace(/^\r?\n\r?\n/, "");
  const headers: Header[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) headers.at(-1)!.value += ` ${line.trim()}`;
    else {
      const colon = line.indexOf(":");
      if (colon > 0)
        headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
    }
  }
  return { headers, body };
}

const headerOf = (headers: Header[], name: string) =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** A raw RFC 822 message's headers, bodies and attachments (outlook.ts reads sendMail's with it too). */
export function parseMime(raw: string): Pick<Message, "headers" | "text" | "html" | "attachments"> {
  const out = {
    text: null as string | null,
    html: null as string | null,
    attachments: [] as Attachment[],
  };
  const walk = (entity: Entity) => {
    const type = headerOf(entity.headers, "Content-Type") || "text/plain";
    const mime = type.split(";")[0].trim().toLowerCase();
    const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
    if (mime.startsWith("multipart/") && boundary) {
      const parts = entity.body.split(`--${boundary}`).slice(1);
      for (const part of parts) {
        if (part.startsWith("--")) break;
        walk(parseEntity(part.replace(/^\r?\n/, "").replace(/\r?\n$/, "")));
      }
      return;
    }
    const base64 = /base64/i.test(headerOf(entity.headers, "Content-Transfer-Encoding"));
    const bytes = base64 ? fromBase64(entity.body) : new TextEncoder().encode(entity.body);
    const disposition = headerOf(entity.headers, "Content-Disposition");
    const extended = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const filename = extended
      ? decodeURIComponent(extended)
      : decodeWords(/(?:file)?name="([^"]*)"/i.exec(`${disposition};${type}`)?.[1] ?? "");
    if (filename || /attachment/i.test(disposition) || mime === "text/calendar") {
      out.attachments.push({
        id: "",
        filename: filename || (mime === "text/calendar" ? "invite.ics" : "attachment"),
        mimeType: mime,
        data: bytesToBase64Url(bytes),
        size: bytes.length,
      });
    } else if (mime === "text/html" && out.html === null) {
      out.html = new TextDecoder().decode(bytes);
    } else if (mime === "text/plain" && out.text === null) {
      out.text = new TextDecoder().decode(bytes);
    }
  };
  const top = parseEntity(raw);
  walk(top);
  const keep = new Set([
    "from",
    "to",
    "cc",
    "bcc",
    "subject",
    "in-reply-to",
    "references",
    "message-id",
  ]);
  return {
    ...out,
    headers: top.headers
      .filter((h) => keep.has(h.name.toLowerCase()))
      .map((h) => ({ name: h.name, value: decodeWords(h.value) })),
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A message from the app's raw RFC 822 (messages.send, drafts). */
function fromRaw(box: Mailbox, raw: string, threadId: string | undefined, labels: string[]) {
  const id = newId(box);
  const parsed = parseMime(new TextDecoder().decode(fromBase64(raw)));
  const now = Date.now();
  const headers = parsed.headers;
  if (!headerOf(headers, "Message-ID"))
    headers.push({ name: "Message-ID", value: `<${id}@${box.email.split("@")[1]}>` });
  headers.push({ name: "Date", value: rfc2822(now) });
  const toMe = [headerOf(headers, "To"), headerOf(headers, "Cc")]
    .join(",")
    .toLowerCase()
    .includes(box.email);
  const message: Message = {
    id,
    threadId:
      threadId && Object.values(box.messages).some((m) => m.threadId === threadId) ? threadId : id,
    labelIds: labels[0] === "SENT" && toMe ? [...labels, "INBOX", "UNREAD"] : labels,
    internalDate: now,
    headers,
    text: parsed.text,
    html: parsed.html,
    attachments: parsed.attachments.map((a, n) => ({ ...a, id: `ANGjdJ_${id}_${n}` })),
  };
  return message;
}

// ── Reading ──────────────────────────────────────────────────────────────────

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function plainText(m: Message): string {
  if (m.text !== null) return m.text;
  return (m.html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");
}

const snippet = (m: Message) => escapeHtml(plainText(m).replace(/\s+/g, " ").trim().slice(0, 180));

const bodyPart = (mimeType: string, text: string) => {
  const bytes = new TextEncoder().encode(text);
  return {
    mimeType,
    filename: "",
    headers: [{ name: "Content-Type", value: `${mimeType}; charset="UTF-8"` }],
    body: { size: bytes.length, data: bytesToBase64Url(bytes) },
  };
};

function payload(m: Message): object {
  const text = m.text !== null ? bodyPart("text/plain", m.text) : null;
  const html = m.html !== null ? bodyPart("text/html", m.html) : null;
  let body: object =
    text && html
      ? { mimeType: "multipart/alternative", filename: "", body: { size: 0 }, parts: [text, html] }
      : (html ?? text ?? bodyPart("text/plain", ""));
  if (m.attachments.length > 0) {
    body = {
      mimeType: "multipart/mixed",
      filename: "",
      body: { size: 0 },
      parts: [
        body,
        ...m.attachments.map((a) => ({
          mimeType: a.mimeType,
          filename: a.filename,
          headers: [
            { name: "Content-Type", value: `${a.mimeType}; name="${a.filename}"` },
            {
              name: "Content-Disposition",
              value: `${a.contentId ? "inline" : "attachment"}; filename="${a.filename}"`,
            },
            ...(a.contentId ? [{ name: "Content-ID", value: `<${a.contentId}>` }] : []),
          ],
          body: { attachmentId: a.id, size: a.size },
        })),
      ],
    };
  }
  return { partId: "", ...body, headers: m.headers };
}

function messageResource(box: Mailbox, m: Message, url: URL): object {
  const format = url.searchParams.get("format") ?? "full";
  const base = {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds,
    snippet: snippet(m),
    historyId: String(box.historyId),
    internalDate: String(m.internalDate),
    sizeEstimate: 2000 + m.attachments.reduce((sum, a) => sum + a.size, 0),
  };
  if (format === "minimal") return base;
  if (format === "metadata") {
    const wanted = url.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase());
    const headers = wanted.length
      ? m.headers.filter((h) => wanted.includes(h.name.toLowerCase()))
      : m.headers;
    return { ...base, payload: { mimeType: "multipart/mixed", headers } };
  }
  return { ...base, payload: payload(m) };
}

// ── Search (a small subset of Gmail's operators) ─────────────────────────────

const IN: Record<string, string> = {
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  drafts: "DRAFT",
  spam: "SPAM",
  trash: "TRASH",
  starred: "STARRED",
  important: "IMPORTANT",
  chats: "CHAT",
};
const IS: Record<string, string> = { unread: "UNREAD", starred: "STARRED", important: "IMPORTANT" };
const CATEGORY: Record<string, string> = {
  primary: "CATEGORY_PERSONAL",
  personal: "CATEGORY_PERSONAL",
  social: "CATEGORY_SOCIAL",
  promotions: "CATEGORY_PROMOTIONS",
  updates: "CATEGORY_UPDATES",
  forums: "CATEGORY_FORUMS",
};
const slug = (name: string) => name.toLowerCase().replace(/[\s/]+/g, "-");
const AGE: Record<string, number> = { d: 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 };

function matchesTerm(box: Mailbox, m: Message, term: string): boolean {
  const colon = term.indexOf(":");
  const op = colon > 0 ? term.slice(0, colon).toLowerCase() : "";
  const value = (colon > 0 ? term.slice(colon + 1) : term).replace(/^"|"$/g, "").toLowerCase();
  const has = (label: string) => m.labelIds.includes(label);
  const header = (name: string) => headerOf(m.headers, name).toLowerCase();
  switch (op) {
    case "in":
      return value === "anywhere" || has(IN[value] ?? "");
    case "is":
      return value === "read" ? !has("UNREAD") : has(IS[value] ?? "");
    case "category":
      return has(CATEGORY[value] ?? "");
    case "label": {
      const label = box.labels.find((l) => slug(l.name) === slug(value) || slug(l.id) === value);
      return !!label && has(label.id);
    }
    case "from":
    case "to":
    case "cc":
    case "subject":
      return header(op).includes(value);
    case "has":
      return value === "attachment" && m.attachments.length > 0;
    case "filename":
      return m.attachments.some((a) => a.filename.toLowerCase().includes(value));
    case "older_than":
    case "newer_than": {
      const age = /^(\d+)([dmy])$/.exec(value);
      if (!age) return true;
      const cutoff = Date.now() - Number(age[1]) * AGE[age[2]];
      return op === "older_than" ? m.internalDate < cutoff : m.internalDate > cutoff;
    }
    case "after":
    case "before": {
      const time = new Date(value.replace(/\//g, "-")).getTime();
      if (Number.isNaN(time)) return true;
      return op === "after" ? m.internalDate >= time : m.internalDate < time;
    }
    default:
      return [header("subject"), header("from"), header("to"), plainText(m).toLowerCase()].some(
        (text) => text.includes(value),
      );
  }
}

function matchesQuery(box: Mailbox, m: Message, q: string): boolean {
  const terms = q.match(/-?(?:[\w]+:)?(?:"[^"]*"|\S+)/g) ?? [];
  return terms.every((term) => {
    if (term === "OR" || term === "AND") return true;
    const negated = term.startsWith("-") && term.length > 1;
    const hit = matchesTerm(box, m, negated ? term.slice(1) : term);
    return negated ? !hit : hit;
  });
}

// ── The API ──────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const notFound = () =>
  json(
    { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } },
    404,
  );
const badRequest = (message: string) =>
  json({ error: { code: 400, message, status: "INVALID_ARGUMENT" } }, 400);

function labelResource(box: Mailbox, label: Label): object {
  const messages = Object.values(box.messages).filter((m) => m.labelIds.includes(label.id));
  const unread = messages.filter((m) => m.labelIds.includes("UNREAD"));
  return {
    ...label,
    messageListVisibility: "show",
    labelListVisibility: "labelShow",
    messagesTotal: messages.length,
    messagesUnread: unread.length,
    threadsTotal: new Set(messages.map((m) => m.threadId)).size,
    threadsUnread: new Set(unread.map((m) => m.threadId)).size,
  };
}

function listMessages(box: Mailbox, url: URL): Response {
  const labelIds = url.searchParams.getAll("labelIds");
  const q = url.searchParams.get("q") ?? "";
  const includeSpamTrash =
    url.searchParams.get("includeSpamTrash") === "true" ||
    labelIds.some((l) => l === "SPAM" || l === "TRASH");
  const maxResults = Number(url.searchParams.get("maxResults") ?? 100);
  const offset = Number(url.searchParams.get("pageToken") ?? 0);
  const all = Object.values(box.messages)
    .filter(
      (m) =>
        (includeSpamTrash || !m.labelIds.some((l) => l === "SPAM" || l === "TRASH")) &&
        labelIds.every((l) => m.labelIds.includes(l)) &&
        matchesQuery(box, m, q),
    )
    .sort((a, b) => b.internalDate - a.internalDate);
  const page = all.slice(offset, offset + maxResults);
  return json({
    ...(page.length ? { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}),
    ...(offset + maxResults < all.length ? { nextPageToken: String(offset + maxResults) } : {}),
    resultSizeEstimate: all.length,
  });
}

function checkLabels(box: Mailbox, ids: string[]): string | null {
  const unknown = ids.find((id) => !box.labels.some((l) => l.id === id));
  return unknown ? `Invalid label: ${unknown}` : null;
}

function draftResource(box: Mailbox, draftId: string): object {
  const m = box.messages[box.drafts[draftId]];
  return { id: draftId, message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds } };
}

function gmail(box: Mailbox, method: string, url: URL, body: Record<string, unknown>): Response {
  const path = url.pathname.replace(/^\/gmail\/v1\/users\/me\/?/, "").split("/");
  const [collection, id, action] = path.map(decodeURIComponent);
  const thread = (threadId: string) =>
    Object.values(box.messages).filter((m) => m.threadId === threadId);

  switch (collection) {
    case "profile":
      return json({
        emailAddress: box.email,
        messagesTotal: Object.keys(box.messages).length,
        threadsTotal: new Set(Object.values(box.messages).map((m) => m.threadId)).size,
        historyId: String(box.historyId),
      });

    case "watch":
      return json({
        historyId: String(box.historyId),
        expiration: String(Date.now() + 7 * 86_400_000),
      });

    case "history": {
      const start = Number(url.searchParams.get("startHistoryId"));
      // A cursor from before a reset: Gmail's answer for an expired one.
      if (!(start <= box.historyId)) return notFound();
      return json({
        history: box.history.filter((h) => Number(h.id) > start),
        historyId: String(box.historyId),
      });
    }

    case "labels": {
      if (!id) {
        if (method === "POST") {
          const name = String(body.name ?? "").trim();
          if (!name) return badRequest("Invalid label name");
          if (box.labels.some((l) => l.name.toLowerCase() === name.toLowerCase()))
            return json({ error: { code: 409, message: "Label name exists or conflicts" } }, 409);
          const label: Label = { id: `Label_${newId(box)}`, name, type: "user" };
          box.labels.push(label);
          save();
          return json(labelResource(box, label));
        }
        return json({ labels: box.labels.map(({ id, name, type }) => ({ id, name, type })) });
      }
      const label = box.labels.find((l) => l.id === id);
      if (!label) return notFound();
      if (method === "DELETE") {
        if (label.type === "system") return badRequest("Invalid delete request");
        box.labels = box.labels.filter((l) => l !== label);
        for (const m of Object.values(box.messages)) {
          if (m.labelIds.includes(id)) modify(box, m, [], [id]);
        }
        save();
        return json({}, 204);
      }
      if (method === "PATCH" || method === "PUT") {
        if (typeof body.name === "string") label.name = body.name;
        if (body.color) label.color = body.color as Label["color"];
        save();
      }
      return json(labelResource(box, label));
    }

    case "messages": {
      if (!id) return method === "GET" ? listMessages(box, url) : notFound();
      if (id === "send" && method === "POST") {
        const m = fromRaw(box, String(body.raw ?? ""), body.threadId as string, ["SENT"]);
        addMessage(box, m);
        return json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
      }
      if (id === "batchDelete" && method === "POST") {
        for (const messageId of (body.ids as string[]) ?? []) deleteMessage(box, messageId);
        return json({}, 204);
      }
      const m = box.messages[id];
      if (!m) return notFound();
      if (action === "attachments") {
        const attachment = m.attachments.find((a) => a.id === path[3]);
        return attachment ? json({ size: attachment.size, data: attachment.data }) : notFound();
      }
      if (action === "modify") {
        const add = (body.addLabelIds as string[]) ?? [];
        const invalid = checkLabels(box, add);
        if (invalid) return badRequest(invalid);
        modify(box, m, add, (body.removeLabelIds as string[]) ?? []);
      } else if (action === "trash") modify(box, m, ["TRASH"], ["SPAM"]);
      else if (action === "untrash") modify(box, m, [], ["TRASH"]);
      else if (method === "DELETE") {
        deleteMessage(box, id);
        return json({}, 204);
      }
      return json(messageResource(box, m, url));
    }

    case "threads": {
      const messages = id ? thread(id) : [];
      if (messages.length === 0) return notFound();
      if (method === "DELETE") {
        for (const m of messages) deleteMessage(box, m.id);
        return json({}, 204);
      }
      if (action === "modify") {
        const add = (body.addLabelIds as string[]) ?? [];
        const invalid = checkLabels(box, add);
        if (invalid) return badRequest(invalid);
        for (const m of messages) modify(box, m, add, (body.removeLabelIds as string[]) ?? []);
      } else if (action === "trash") {
        for (const m of messages) modify(box, m, ["TRASH"], ["SPAM"]);
      } else if (action === "untrash") {
        for (const m of messages) modify(box, m, [], ["TRASH"]);
      }
      return json({
        id,
        historyId: String(box.historyId),
        messages: messages.map((m) => messageResource(box, m, new URL("x:?format=minimal"))),
      });
    }

    case "drafts": {
      if (!id) {
        if (method === "POST") {
          const message = (body.message ?? {}) as { raw?: string; threadId?: string };
          const m = fromRaw(box, message.raw ?? "", message.threadId, ["DRAFT"]);
          const draftId = `r-${m.id}`;
          box.drafts[draftId] = m.id;
          addMessage(box, m);
          return json(draftResource(box, draftId));
        }
        const drafts = Object.keys(box.drafts)
          .filter((draftId) => box.messages[box.drafts[draftId]])
          .map((draftId) => draftResource(box, draftId));
        return json({ drafts, resultSizeEstimate: drafts.length });
      }
      const current = box.messages[box.drafts[id]];
      if (!current) return notFound();
      if (method === "DELETE") {
        deleteMessage(box, current.id);
        return json({}, 204);
      }
      if (method === "PUT") {
        const message = (body.message ?? {}) as { raw?: string };
        // Like Gmail, every edit is a new message in the same thread.
        const m = fromRaw(box, message.raw ?? "", current.threadId, ["DRAFT"]);
        deleteMessage(box, current.id);
        box.drafts[id] = m.id;
        addMessage(box, m);
      }
      return json(draftResource(box, id));
    }

    case "settings": {
      // settings/sendAs[/{email}]
      const sendAs = {
        sendAsEmail: box.email,
        displayName: box.name,
        isPrimary: true,
        isDefault: true,
        signature: box.signature,
      };
      if (path[2]) {
        if (decodeURIComponent(path[2]).toLowerCase() !== box.email) return notFound();
        if (typeof body.signature === "string") {
          box.signature = body.signature;
          save();
        }
        return json({ ...sendAs, signature: box.signature });
      }
      return json({ sendAs: [sendAs] });
    }
  }
  return notFound();
}

// ── The fetch shim ───────────────────────────────────────────────────────────

function answer(url: URL, method: string, headers: Headers, rawBody: unknown): Response | null {
  if (url.origin === DEMO_RELAY_URL) {
    return json({ error: "Demo mode has no Otter account." }, 401);
  }
  if (url.hostname === "gmail.googleapis.com" && url.pathname.startsWith("/gmail/v1/users/me")) {
    const account = /^Bearer demo:(.+)$/.exec(headers.get("Authorization") ?? "")?.[1];
    const box = account ? state.mailboxes[account] : undefined;
    if (!box) return json({ error: { code: 401, message: "Not a demo account." } }, 401);
    const body = typeof rawBody === "string" && rawBody ? JSON.parse(rawBody) : {};
    return gmail(box, method, url, body as Record<string, unknown>);
  }
  // Calendar: no event found, so an RSVP goes out as an email reply.
  if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/calendar/")) {
    return json({ items: [] });
  }
  // The account's name and picture, as Google keeps them.
  if (url.hostname === "www.googleapis.com" && url.pathname === "/oauth2/v3/userinfo") {
    const account = /^Bearer demo:(.+)$/.exec(headers.get("Authorization") ?? "")?.[1];
    const seed = DEMO_ACCOUNTS.find((s) => s.email === account);
    if (!seed) return json({ error: "Not a demo account." }, 401);
    return json({ email: seed.email, name: seed.name, picture: seed.picture });
  }
  if (url.hostname === "people.googleapis.com") return json({ results: [] });
  // Avatars: the demo's people have no photos or favicons to find.
  if (
    url.hostname === "www.gravatar.com" ||
    url.hostname === "icons.duckduckgo.com" ||
    (url.hostname === "www.google.com" && url.pathname.startsWith("/s2/favicons"))
  ) {
    return new Response(null, { status: 404 });
  }
  // The seed's made-up domains (one-click unsubscribe, links).
  if (url.hostname.endsWith(".example") || url.hostname === "example.com") {
    return new Response(null, { status: 200 });
  }
  return null;
}

/** Loads (or seeds) the demo mailboxes and puts the fake Gmail in front of fetch. */
export async function installFakeGmail(demoFiles: Platform["files"]): Promise<void> {
  files = demoFiles;
  await loadState();
  const todoist = await fakeTodoist(demoFiles);
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    if (url.origin === "https://api.todoist.com") return todoist(url, init);
    const response = answer(
      url,
      (init?.method ?? request?.method ?? "GET").toUpperCase(),
      new Headers(init?.headers ?? request?.headers),
      init?.body,
    );
    if (!response) return realFetch(input, init);
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
    return response;
  };
}

// ── Sign-in ──────────────────────────────────────────────────────────────────

function demoAccount(seed: SeedAccount): GmailAccount {
  return {
    id: seed.email,
    email: seed.email,
    name: seed.name,
    displayName: seed.displayName,
    color: seed.color,
    picture: seed.picture,
  };
}

/** Every demo mailbox is signed in; "adding an account" brings back one that was removed. */
export function demoGoogleAuth(): GoogleAuth {
  const isDemo = (accountId: string) => DEMO_ACCOUNTS.some((seed) => seed.email === accountId);
  return {
    async load() {
      if ((await accountStore.listAccounts()).length > 0) return;
      for (const seed of DEMO_ACCOUNTS) await accountStore.addAccount(demoAccount(seed));
    },
    async addAccount(loginHint) {
      const present = new Set((await accountStore.listAccounts()).map((a) => a.id));
      const seed =
        DEMO_ACCOUNTS.find((s) => s.email === loginHint) ??
        DEMO_ACCOUNTS.find((s) => !present.has(s.email));
      if (!seed) throw new Error("Every demo mailbox is already here.");
      const account = demoAccount(seed);
      await accountStore.addAccount(account);
      return account;
    },
    cancelSignIn() {},
    isSignedIn: isDemo,
    getAccessToken: async (accountId) => `demo:${accountId}`,
    async getIdToken() {
      throw new Error("Demo mailboxes can't sign in to an Otter account.");
    },
    async removeTokens() {},
  };
}
