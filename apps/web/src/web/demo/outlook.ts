/**
 * Demo mode's Outlook (`pnpm dev:fake`): a pretend Microsoft Graph in the
 * backend's Worker, beside the pretend Gmail (gmail.ts).
 *
 * `installFakeOutlook` wraps the Worker's fetch: calls to Graph are answered
 * from the seeded mailbox (@otter-mail/shared/demo-mailboxes'
 * DEMO_OUTLOOK_ACCOUNT), which lives in the demo's own files and changes as
 * the app moves, flags, categorizes, drafts and sends. Every change takes the
 * mailbox's next change number, and every message leaving a folder is
 * logged, so a folder's delta link (the number it was issued at) answers what
 * changed since. `demoMicrosoftAuth` signs the mailbox in.
 */

import {
  accountStore,
  fromBase64,
  toBase64,
  type GmailAccount,
  type MicrosoftAuth,
  type Platform,
} from "@otter-mail/core";

import {
  DEMO_OUTLOOK_ACCOUNT,
  type OutlookSeedAccount,
  type OutlookSeedFolder,
} from "@otter-mail/shared/demo-mailboxes";

import { parseMime } from "./gmail";

const GRAPH_HOST = "graph.microsoft.com";
const GRAPH = `https://${GRAPH_HOST}/v1.0`;
const TOKEN_PREFIX = "outlook-demo:";
const STATE_FILE = "demo-outlook.json";
const STATE_VERSION = 1;
/** Every answer waits this long, so the app sees a network, not a function call. */
const LATENCY_MS = 30;
/** Graph's page when the request doesn't say: small, so paging gets exercised. */
const DEFAULT_PAGE = 10;
/** Folder departures kept for delta links; an older link is expired (410). */
const DEPARTURES_KEPT = 2000;

type Person = { name: string; email: string };
type Recipient = { emailAddress: { name: string; address: string } };

type Attachment = {
  id: string;
  name: string;
  contentType: string;
  /** base64, as Graph sends it. */
  contentBytes: string;
  size: number;
  isInline: boolean;
  contentId?: string;
};

type Message = {
  id: string;
  conversationId: string;
  folderId: string;
  subject: string;
  body: { contentType: "html" | "text"; content: string };
  from: Recipient;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  received: number;
  sent: number | null;
  isRead: boolean;
  isDraft: boolean;
  flagged: boolean;
  importance: "low" | "normal" | "high";
  categories: string[];
  internetMessageId: string;
  inReplyTo?: string;
  references?: string;
  /** More headers its source carries (List-Unsubscribe). */
  headers: { name: string; value: string }[];
  attachments: Attachment[];
  /** The change number it last changed at. */
  version: number;
};

type Folder = { id: string; displayName: string; parentFolderId: string; wellKnown?: string };
type Category = { id: string; displayName: string; color: string };

type CalendarEvent = {
  id: string;
  iCalUId: string;
  subject: string;
  body: string;
  start: number;
  end: number;
  isAllDay: boolean;
  location: string;
  organizer: Recipient;
  attendees: (Recipient & { type: string; status: { response: string } })[];
  isOrganizer: boolean;
  /** Your answer, in Graph's words (notResponded, accepted, …, organizer). */
  response: string;
  isCancelled: boolean;
};

type Mailbox = {
  email: string;
  name: string;
  /** The last change number given out. */
  counter: number;
  nextId: number;
  rootId: string;
  folders: Folder[];
  categories: Category[];
  messages: Record<string, Message>;
  /** Messages that left a folder (moved or deleted), at which change. */
  departures: { id: string; folderId: string; at: number }[];
  /** Delta links from before this change are expired (their departures are gone). */
  departureFloor: number;
  events: Record<string, CalendarEvent>;
  subscriptions: string[];
};

type State = {
  version: number;
  seededAt: number;
  /** The mailbox was added to the app's accounts once (removing it keeps it removed). */
  introduced: boolean;
  signedIn: string[];
  mailboxes: Record<string, Mailbox>;
};

// ── Seeding ──────────────────────────────────────────────────────────────────

/** An opaque, URL-safe id, like Graph's immutable ones. */
function newId(box: Mailbox, kind: string): string {
  return `AAMkADdlbW8${kind}${(box.nextId++).toString(36).padStart(6, "0")}AAA`;
}

const recipient = (person: Person): Recipient => ({
  emailAddress: { name: person.name, address: person.email },
});

const domainOf = (email: string) => email.split("@")[1] ?? "contoso.example";

const WELL_KNOWN: [OutlookSeedFolder | "outbox" | "conversationhistory", string][] = [
  ["inbox", "Inbox"],
  ["drafts", "Drafts"],
  ["sentitems", "Sent Items"],
  ["deleteditems", "Deleted Items"],
  ["junkemail", "Junk Email"],
  ["archive", "Archive"],
  ["outbox", "Outbox"],
  ["conversationhistory", "Conversation History"],
];

function seedMailbox(seed: OutlookSeedAccount, seededAt: number): Mailbox {
  const box: Mailbox = {
    email: seed.email,
    name: seed.name,
    counter: 0,
    nextId: 1,
    rootId: "",
    folders: [],
    categories: [],
    messages: {},
    departures: [],
    departureFloor: 0,
    events: {},
    subscriptions: [],
  };
  box.rootId = newId(box, "Fo");
  const folderOf = new Map<string, string>();
  for (const [wellKnown, displayName] of WELL_KNOWN) {
    const id = newId(box, "Fo");
    box.folders.push({ id, displayName, parentFolderId: box.rootId, wellKnown });
    folderOf.set(wellKnown, id);
  }
  for (const folder of seed.folders) {
    const id = newId(box, "Fo");
    const parentFolderId = folder.parent ? folderOf.get(folder.parent)! : box.rootId;
    box.folders.push({ id, displayName: folder.name, parentFolderId });
    folderOf.set(folder.key, id);
  }
  box.categories = seed.categories.map((c) => ({
    id: newId(box, "Ca"),
    displayName: c.name,
    color: c.color,
  }));

  const me = { name: seed.name, email: seed.email };
  const conversations = new Map<string, { id: string; firstSender?: Person; last?: Message }>();
  // Oldest first, so each message replies to the one before it.
  const seeded = seed.messages(seededAt).sort((a, b) => b.hoursAgo - a.hoursAgo);
  for (const s of seeded) {
    let conversation = conversations.get(s.conversation);
    if (!conversation) {
      conversation = { id: newId(box, "Cv") };
      conversations.set(s.conversation, conversation);
    }
    if (s.from) conversation.firstSender ??= s.from;
    const from = s.from ?? me;
    const to = s.to ?? (s.from ? [me] : conversation.firstSender ? [conversation.firstSender] : []);
    const previous = conversation.last;
    const time = seededAt - s.hoursAgo * 3_600_000;
    const id = newId(box, "Ms");
    const message: Message = {
      id,
      conversationId: conversation.id,
      folderId: folderOf.get(s.folder)!,
      subject: previous && !/^(re|fw):/i.test(s.subject) ? `RE: ${s.subject}` : s.subject,
      body: s.html
        ? { contentType: "html", content: s.html }
        : { contentType: "text", content: s.text },
      from: recipient(from),
      to: to.map(recipient),
      cc: (s.cc ?? []).map(recipient),
      bcc: [],
      received: time,
      sent: s.folder === "drafts" ? null : time,
      isRead: !s.unread,
      isDraft: s.folder === "drafts",
      flagged: s.flagged === true,
      importance: s.importance ?? "normal",
      categories: s.categories ?? [],
      internetMessageId: `<${id}@${domainOf(from.email)}>`,
      ...(previous
        ? {
            inReplyTo: previous.internetMessageId,
            references: [previous.references, previous.internetMessageId].filter(Boolean).join(" "),
          }
        : {}),
      headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })),
      attachments: (s.attachments ?? []).map((a) => {
        const bytes = new TextEncoder().encode(a.content);
        return {
          id: newId(box, "At"),
          name: a.filename,
          contentType: a.mimeType,
          contentBytes: toBase64(bytes),
          size: bytes.length,
          isInline: a.contentId !== undefined,
          contentId: a.contentId,
        };
      }),
      version: ++box.counter,
    };
    box.messages[id] = message;
    conversation.last = message;
  }

  for (const e of seed.events(seededAt)) {
    const id = newId(box, "Ev");
    box.events[id] = {
      id,
      iCalUId: e.uid,
      subject: e.subject,
      body: e.description,
      start: e.start,
      end: e.start + e.minutes * 60_000,
      isAllDay: e.allDay === true,
      location: e.location,
      organizer: recipient(e.organizer),
      attendees: e.attendees
        .filter((a) => a.email !== e.organizer.email)
        .map((a) => ({
          ...recipient(a),
          type: "required",
          status: { response: a.email === seed.email ? e.response : "none" },
        })),
      isOrganizer: e.response === "organizer",
      response: e.response,
      isCancelled: false,
    };
  }
  return box;
}

// ── State ────────────────────────────────────────────────────────────────────

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
  const seed = DEMO_OUTLOOK_ACCOUNT;
  state = {
    version: STATE_VERSION,
    seededAt,
    introduced: false,
    signedIn: [seed.email],
    mailboxes: { [seed.email]: seedMailbox(seed, seededAt) },
  };
  await files.write(STATE_FILE, JSON.stringify(state));
}

// ── Changes ──────────────────────────────────────────────────────────────────

function touch(box: Mailbox, m: Message): void {
  m.version = ++box.counter;
  save();
}

function depart(box: Mailbox, id: string, folderId: string): void {
  box.departures.push({ id, folderId, at: ++box.counter });
  if (box.departures.length > DEPARTURES_KEPT) {
    const dropped = box.departures.splice(0, box.departures.length - DEPARTURES_KEPT);
    box.departureFloor = dropped.at(-1)!.at;
  }
}

function moveTo(box: Mailbox, m: Message, folderId: string): void {
  if (m.folderId === folderId) return;
  depart(box, m.id, m.folderId);
  m.folderId = folderId;
  touch(box, m);
}

function addMessage(box: Mailbox, m: Message): void {
  box.messages[m.id] = m;
  touch(box, m);
}

function deleteMessage(box: Mailbox, m: Message): void {
  delete box.messages[m.id];
  depart(box, m.id, m.folderId);
  save();
}

const wellKnown = (box: Mailbox, name: string) => box.folders.find((f) => f.wellKnown === name)!.id;

/** A message sent to the mailbox itself lands in its inbox too, unread. */
function deliverToSelf(box: Mailbox, m: Message): void {
  const all = [...m.to, ...m.cc, ...m.bcc];
  if (!all.some((r) => r.emailAddress.address.toLowerCase() === box.email)) return;
  addMessage(box, {
    ...structuredClone(m),
    id: newId(box, "Ms"),
    folderId: wellKnown(box, "inbox"),
    isRead: false,
    isDraft: false,
  });
}

// ── Resources ────────────────────────────────────────────────────────────────

const iso = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
const rfc2822 = (time: number) => new Date(time).toUTCString().replace("GMT", "+0000");
const utf8 = (text: string) => new TextEncoder().encode(text);

function plainText(m: Message): string {
  if (m.body.contentType === "text") return m.body.content;
  return m.body.content
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const isMine = (box: Mailbox, m: Message) =>
  m.isDraft || m.folderId === wellKnown(box, "sentitems");

/** The headers a received message arrived with (Graph has none for drafts and sent mail). */
function receivedHeaders(m: Message): { name: string; value: string }[] {
  return [
    { name: "From", value: addressHeader([m.from]) },
    { name: "To", value: addressHeader(m.to) },
    ...(m.cc.length ? [{ name: "Cc", value: addressHeader(m.cc) }] : []),
    { name: "Subject", value: m.subject },
    { name: "Date", value: rfc2822(m.sent ?? m.received) },
    { name: "Message-ID", value: m.internetMessageId },
    ...(m.inReplyTo ? [{ name: "In-Reply-To", value: m.inReplyTo }] : []),
    ...(m.references ? [{ name: "References", value: m.references }] : []),
    ...m.headers,
  ];
}

function messageResource(box: Mailbox, m: Message): Record<string, unknown> {
  return {
    "@odata.etag": `W/"${m.version}"`,
    id: m.id,
    createdDateTime: iso(m.received),
    lastModifiedDateTime: iso(m.received),
    changeKey: String(m.version),
    categories: m.categories,
    receivedDateTime: iso(m.received),
    sentDateTime: m.sent === null ? null : iso(m.sent),
    hasAttachments: m.attachments.some((a) => !a.isInline && a.contentType !== "text/calendar"),
    internetMessageId: m.internetMessageId,
    subject: m.subject,
    bodyPreview: plainText(m).replace(/\s+/g, " ").trim().slice(0, 255),
    importance: m.importance,
    parentFolderId: m.folderId,
    conversationId: m.conversationId,
    isRead: m.isRead,
    isDraft: m.isDraft,
    webLink: `https://outlook.office.com/mail/deeplink/read/${m.id}`,
    inferenceClassification: "focused",
    body: m.body,
    sender: m.from,
    from: m.from,
    toRecipients: m.to,
    ccRecipients: m.cc,
    bccRecipients: m.bcc,
    replyTo: [],
    flag: { flagStatus: m.flagged ? "flagged" : "notFlagged" },
    ...(isMine(box, m) ? {} : { internetMessageHeaders: receivedHeaders(m) }),
  };
}

/** `$select`'s fields (and the id); everything but the headers without one, as Graph answers. */
function pick(resource: Record<string, unknown>, select: string | null): Record<string, unknown> {
  if (!select) {
    const { internetMessageHeaders: _, ...rest } = resource;
    return rest;
  }
  const out: Record<string, unknown> = {};
  for (const key of ["@odata.etag", "@odata.type", "id", ...select.split(",")]) {
    const field = key.trim();
    if (field in resource) out[field] = resource[field];
  }
  return out;
}

function folderResource(box: Mailbox, f: Folder): Record<string, unknown> {
  const messages = Object.values(box.messages).filter((m) => m.folderId === f.id);
  return {
    id: f.id,
    displayName: f.displayName,
    parentFolderId: f.parentFolderId,
    childFolderCount: box.folders.filter((c) => c.parentFolderId === f.id).length,
    unreadItemCount: messages.filter((m) => !m.isRead && !m.isDraft).length,
    totalItemCount: messages.length,
    isHidden: false,
  };
}

function attachmentResource(a: Attachment, withBytes: boolean): Record<string, unknown> {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    id: a.id,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    isInline: a.isInline,
    contentId: a.contentId ?? null,
    lastModifiedDateTime: iso(Date.now()),
    ...(withBytes ? { contentBytes: a.contentBytes } : {}),
  };
}

/** Graph's times: UTC, without a zone, seven decimals. */
const graphTime = (time: number) => ({
  dateTime: new Date(time).toISOString().replace("Z", "0000"),
  timeZone: "UTC",
});
const parseTime = (time: unknown) =>
  Date.parse(`${String((time as { dateTime?: string })?.dateTime ?? "").replace(/\.\d+$/, "")}Z`);

const SHOW_AS: Record<string, string> = {
  accepted: "busy",
  organizer: "busy",
  tentativelyAccepted: "tentative",
  notResponded: "tentative",
  declined: "free",
};

function eventResource(e: CalendarEvent): Record<string, unknown> {
  return {
    id: e.id,
    iCalUId: e.iCalUId,
    subject: e.subject,
    bodyPreview: e.body.slice(0, 255),
    body: { contentType: "text", content: e.body },
    start: graphTime(e.start),
    end: graphTime(e.end),
    isAllDay: e.isAllDay,
    isCancelled: e.isCancelled,
    isOrganizer: e.isOrganizer,
    showAs: SHOW_AS[e.response] ?? "busy",
    location: { displayName: e.location },
    organizer: e.organizer,
    attendees: e.attendees,
    responseStatus: { response: e.response, time: iso(Date.now()) },
    onlineMeeting: null,
    onlineMeetingUrl: null,
    webLink: `https://outlook.office.com/calendar/item/${e.id}`,
    type: "singleInstance",
    seriesMasterId: null,
  };
}

// ── MIME (a message's source, /$value) ───────────────────────────────────────

const CRLF = "\r\n";
const encodeWord = (text: string) =>
  /[^\x20-\x7e]/.test(text) ? `=?UTF-8?B?${toBase64(utf8(text))}?=` : text;

function addressHeader(list: Recipient[]): string {
  return list
    .map(({ emailAddress: { name, address } }) => {
      if (!name || name === address) return address;
      const display = /[^\x20-\x7e]/.test(name)
        ? encodeWord(name)
        : /[",<>@;:.()]/.test(name)
          ? `"${name.replace(/"/g, '\\"')}"`
          : name;
      return `${display} <${address}>`;
    })
    .join(", ");
}

type Entity = { headers: string[]; body: string };

const render = (e: Entity) => `${e.headers.join(CRLF)}${CRLF}${CRLF}${e.body}`;

const leaf = (contentType: string, bytes: Uint8Array, headers: string[] = []): Entity => ({
  headers: [`Content-Type: ${contentType}`, "Content-Transfer-Encoding: base64", ...headers],
  body: toBase64(bytes).replace(/.{76}/g, `$&${CRLF}`),
});

const multipart = (subtype: string, boundary: string, parts: Entity[]): Entity => ({
  headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
  body: `${parts.map((p) => `--${boundary}${CRLF}${render(p)}`).join(CRLF)}${CRLF}--${boundary}--`,
});

function attachmentEntity(a: Attachment): Entity {
  const bytes = fromBase64(a.contentBytes);
  const name = encodeWord(a.name);
  const method =
    a.contentType === "text/calendar"
      ? /^METHOD:(\w+)/m.exec(new TextDecoder().decode(bytes))?.[1]
      : undefined;
  return leaf(`${a.contentType}; name="${name}"${method ? `; method=${method}` : ""}`, bytes, [
    `Content-Disposition: ${a.isInline ? "inline" : "attachment"}; filename="${name}"`,
    ...(a.contentId ? [`Content-ID: <${a.contentId}>`] : []),
  ]);
}

function mimeSource(m: Message): Uint8Array {
  let entity = leaf(
    `text/${m.body.contentType === "html" ? "html" : "plain"}; charset="UTF-8"`,
    utf8(m.body.content),
  );
  const inline = m.attachments.filter((a) => a.isInline);
  const attached = m.attachments.filter((a) => !a.isInline);
  if (inline.length > 0) {
    entity = multipart("related", `related_${m.id}`, [entity, ...inline.map(attachmentEntity)]);
  }
  if (attached.length > 0) {
    entity = multipart("mixed", `mixed_${m.id}`, [entity, ...attached.map(attachmentEntity)]);
  }
  const headers = [
    `From: ${addressHeader([m.from])}`,
    ...(m.to.length ? [`To: ${addressHeader(m.to)}`] : []),
    ...(m.cc.length ? [`Cc: ${addressHeader(m.cc)}`] : []),
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${rfc2822(m.sent ?? m.received)}`,
    `Message-ID: ${m.internetMessageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    ...m.headers.map((h) => `${h.name}: ${h.value}`),
    "MIME-Version: 1.0",
    ...entity.headers,
  ];
  return utf8(render({ headers, body: entity.body }));
}

/** "Ann <a@b>, c@d" (headers decoded) → Graph's recipients. */
function parseAddresses(header: string): Recipient[] {
  const entries = header.match(/(?:"[^"]*"|<[^>]*>|[^,])+/g) ?? [];
  return entries.flatMap((entry) => {
    const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(entry);
    const address = (match?.[2] ?? entry).trim();
    if (!address.includes("@")) return [];
    return [{ emailAddress: { name: match?.[1]?.trim() || address, address } }];
  });
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** `$filter`'s conditions, joined by `and` (what core asks for); null when one isn't known. */
function parseFilter<T>(
  filter: string,
  fields: Record<string, (item: T, value: string) => boolean>,
): ((item: T) => boolean) | null {
  const clauses = [...filter.matchAll(/([\w/]+)(?:\(\w+:\w+)? eq (?:'((?:[^']|'')*)'|(\w+))\)?/g)];
  if (clauses.length === 0) return null;
  const tests: ((item: T) => boolean)[] = [];
  for (const [, field, quoted, bare] of clauses) {
    const test = fields[field];
    if (!test) return null;
    const value = quoted !== undefined ? quoted.replace(/''/g, "'") : bare;
    tests.push((item) => test(item, value));
  }
  return (item) => tests.every((test) => test(item));
}

const MESSAGE_FILTERS: Record<string, (m: Message, value: string) => boolean> = {
  id: (m, v) => m.id === v,
  isRead: (m, v) => m.isRead === (v === "true"),
  isDraft: (m, v) => m.isDraft === (v === "true"),
  "flag/flagStatus": (m, v) => (m.flagged ? "flagged" : "notFlagged") === v,
  importance: (m, v) => m.importance === v,
  "categories/any": (m, v) => m.categories.includes(v),
  conversationId: (m, v) => m.conversationId === v,
  internetMessageId: (m, v) => m.internetMessageId === v,
  parentFolderId: (m, v) => m.folderId === v,
};

const people = (list: Recipient[]) =>
  list.map((r) => `${r.emailAddress.name} ${r.emailAddress.address}`.toLowerCase()).join(" ");

/** `$search`'s KQL, simply: words anywhere, `from:` `to:` `cc:` `subject:` `hasattachments:` and `received`. */
function searchTest(raw: string): (m: Message) => boolean {
  const q = raw
    .trim()
    .replace(/^"([\s\S]*)"$/, "$1")
    .replace(/\\"/g, '"');
  const terms = [...q.matchAll(/(NOT\s+)?(?:(\w+)(:|>=|<=|>|<)("[^"]*"|\S+)|("[^"]*"|\S+))/g)];
  const unquote = (value: string) => value.replace(/^"|"$/g, "").toLowerCase();
  const matches = (m: Message, key: string, op: string, value: string) => {
    switch (key) {
      case "from":
        return people([m.from]).includes(value);
      case "to":
        return people(m.to).includes(value);
      case "cc":
        return people(m.cc).includes(value);
      case "bcc":
        return people(m.bcc).includes(value);
      case "subject":
        return m.subject.toLowerCase().includes(value);
      case "body":
        return plainText(m).toLowerCase().includes(value);
      case "hasattachments":
        return m.attachments.some((a) => !a.isInline) === (value === "true");
      case "received": {
        const day = Date.parse(value);
        if (Number.isNaN(day)) return true;
        if (op === ">=") return m.received >= day;
        if (op === ">") return m.received >= day + 86_400_000;
        if (op === "<") return m.received < day;
        if (op === "<=") return m.received < day + 86_400_000;
        return m.received >= day && m.received < day + 86_400_000;
      }
      default:
        return true;
    }
  };
  return (m) =>
    terms.every(([, not, key, op, value, word]) => {
      if (word && /^(AND|OR)$/.test(word)) return true;
      const hit = key
        ? matches(m, key.toLowerCase(), op, unquote(value))
        : [
            m.subject.toLowerCase(),
            plainText(m).toLowerCase(),
            people([m.from]),
            people(m.to),
          ].some((text) => text.includes(unquote(word)));
      return not ? !hit : hit;
    });
}

const pageSize = (prefer: string, top: string | null) =>
  Number(top) || Number(/odata\.maxpagesize=(\d+)/.exec(prefer)?.[1]) || DEFAULT_PAGE;

/** A page of a collection, and the link to the next (`$skip`). */
function page<T>(req: Req, items: T[], map: (item: T) => unknown): Answer {
  const size = Math.min(pageSize(req.prefer, req.url.searchParams.get("$top")), 1000);
  const skip = Number(req.url.searchParams.get("$skip")) || 0;
  const next = new URL(req.url);
  next.searchParams.set("$skip", String(skip + size));
  return ok({
    value: items.slice(skip, skip + size).map(map),
    ...(skip + size < items.length ? { "@odata.nextLink": next.toString() } : {}),
  });
}

// ── The API ──────────────────────────────────────────────────────────────────

type Req = {
  method: string;
  url: URL;
  path: string[];
  body: unknown;
  prefer: string;
};
type Answer = { status: number; body?: unknown; bytes?: Uint8Array; contentType?: string };

const ok = (body?: unknown, status = 200): Answer => ({ status, body });
const graphError = (status: number, code: string, message: string): Answer => ({
  status,
  body: { error: { code, message } },
});
const notFound = () =>
  graphError(404, "ErrorItemNotFound", "The specified object was not found in the store.");
const badRequest = (message: string) => graphError(400, "ErrorInvalidRequest", message);
const fields = (req: Req) => (req.body ?? {}) as Record<string, unknown>;
const select = (req: Req) => req.url.searchParams.get("$select");

function resolveFolder(box: Mailbox, ref: string): Folder | undefined {
  if (ref.toLowerCase() === "msgfolderroot" || ref === box.rootId) {
    return { id: box.rootId, displayName: "Top of Information Store", parentFolderId: "" };
  }
  return box.folders.find((f) => f.id === ref || f.wellKnown === ref.toLowerCase());
}

function newFolder(box: Mailbox, parentFolderId: string, req: Req): Answer {
  const displayName = String(fields(req).displayName ?? "").trim();
  if (!displayName) return badRequest("A folder needs a name.");
  if (box.folders.some((f) => f.parentFolderId === parentFolderId && f.displayName === displayName))
    return graphError(409, "ErrorFolderExists", "A folder with the specified name already exists.");
  const folder: Folder = { id: newId(box, "Fo"), displayName, parentFolderId };
  box.folders.push(folder);
  save();
  return ok(folderResource(box, folder), 201);
}

/** A folder and the folders in it, all the way down. */
function subtree(box: Mailbox, id: string): string[] {
  return [
    id,
    ...box.folders.filter((f) => f.parentFolderId === id).flatMap((f) => subtree(box, f.id)),
  ];
}

function mailFolders(box: Mailbox, req: Req, rest: string[]): Answer {
  const [ref, action, ...more] = rest;
  if (!ref) {
    if (req.method === "POST") return newFolder(box, box.rootId, req);
    const top = box.folders.filter((f) => f.parentFolderId === box.rootId);
    return page(req, top, (f) => pick(folderResource(box, f), select(req)));
  }
  const folder = resolveFolder(box, ref);
  if (!folder)
    return graphError(
      404,
      "ErrorItemNotFound",
      "The specified folder could not be found in the store.",
    );
  switch (action) {
    case undefined:
      if (req.method === "PATCH") {
        if (folder.wellKnown) return badRequest("Outlook's own folders can't be renamed.");
        const name = fields(req).displayName;
        if (typeof name === "string" && name.trim()) folder.displayName = name.trim();
        save();
      } else if (req.method === "DELETE") {
        if (folder.wellKnown || folder.id === box.rootId)
          return badRequest("Can't delete this folder.");
        folder.parentFolderId = wellKnown(box, "deleteditems");
        save();
        return ok(undefined, 204);
      }
      return ok(pick(folderResource(box, folder), select(req)));
    case "childFolders": {
      if (req.method === "POST") return newFolder(box, folder.id, req);
      const children = box.folders.filter((f) => f.parentFolderId === folder.id);
      return page(req, children, (f) => pick(folderResource(box, f), select(req)));
    }
    case "move": {
      const to = resolveFolder(box, String(fields(req).destinationId ?? ""));
      if (!to || subtree(box, folder.id).includes(to.id)) return notFound();
      folder.parentFolderId = to.id;
      save();
      return ok(folderResource(box, folder), 201);
    }
    case "permanentDelete": {
      if (folder.wellKnown) return badRequest("Can't delete this folder.");
      const gone = new Set(subtree(box, folder.id));
      for (const m of Object.values(box.messages)) if (gone.has(m.folderId)) deleteMessage(box, m);
      box.folders = box.folders.filter((f) => !gone.has(f.id));
      save();
      return ok(undefined, 204);
    }
    case "messages":
      if (more[0] === "delta") return delta(box, req, folder);
      if (more.length > 0) return messages(box, req, more);
      if (req.method === "POST") return newMessage(box, req, folder.id);
      return listMessages(box, req, folder.id);
  }
  return badRequest(`Resource not found for the segment '${action}'.`);
}

function listMessages(box: Mailbox, req: Req, folderId: string | null): Answer {
  const params = req.url.searchParams;
  let list = Object.values(box.messages).filter((m) => !folderId || m.folderId === folderId);
  const filter = params.get("$filter");
  if (filter) {
    const test = parseFilter(filter, MESSAGE_FILTERS);
    if (!test) return badRequest(`Invalid filter clause: ${filter}`);
    list = list.filter(test);
  }
  const search = params.get("$search");
  if (search) list = list.filter(searchTest(search));
  const ascending = /receivedDateTime asc/i.test(params.get("$orderby") ?? "");
  list.sort((a, b) => (ascending ? a.received - b.received : b.received - a.received));
  return page(req, list, (m) => pick(messageResource(box, m), select(req)));
}

/**
 * A folder's delta: the first call lists the folder; a delta link answers
 * what came in or changed since its change number, and `@removed` for what
 * left. Tokens: `$skiptoken=<since>.<upto>.<offset>` while paging, then
 * `$deltatoken=<upto>`.
 */
function delta(box: Mailbox, req: Req, folder: Folder): Answer {
  const params = req.url.searchParams;
  const fieldList = select(req);
  let since = 0;
  let upto = box.counter;
  let offset = 0;
  const skipToken = params.get("$skiptoken");
  const deltaToken = params.get("$deltatoken");
  if (skipToken) [since, upto, offset] = skipToken.split(".").map(Number);
  else if (deltaToken !== null) since = Number(deltaToken);
  if ([since, upto, offset].some((n) => !Number.isFinite(n)))
    return badRequest("The delta token isn't valid.");
  if (since > 0 && since < box.departureFloor)
    return graphError(410, "SyncStateNotFound", "The sync state generation is not found.");

  const present = Object.values(box.messages)
    .filter((m) => m.folderId === folder.id && m.version <= upto && m.version > since)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const removed =
    since === 0
      ? []
      : [
          ...new Set(
            box.departures
              .filter((d) => d.folderId === folder.id && d.at > since && d.at <= upto)
              .map((d) => d.id),
          ),
        ].filter((id) => box.messages[id]?.folderId !== folder.id);
  const items = [
    ...present.map((m) => pick(messageResource(box, m), fieldList)),
    ...removed.map((id) => ({ id, "@removed": { reason: "deleted" } })),
  ];
  const size = pageSize(req.prefer, null);
  const link = (token: Record<string, string>) =>
    `${GRAPH}/me/mailFolders/${encodeURIComponent(folder.id)}/messages/delta?${new URLSearchParams({
      ...token,
      ...(fieldList ? { $select: fieldList } : {}),
    }).toString()}`;
  return ok({
    value: items.slice(offset, offset + size),
    ...(offset + size < items.length
      ? { "@odata.nextLink": link({ $skiptoken: `${since}.${upto}.${offset + size}` }) }
      : { "@odata.deltaLink": link({ $deltatoken: String(upto) }) }),
  });
}

/** A message's writable fields from a request body (PATCH, a new draft). */
function applyFields(m: Message, body: Record<string, unknown>): void {
  if (typeof body.isRead === "boolean") m.isRead = body.isRead;
  if (body.flag && typeof body.flag === "object")
    m.flagged = (body.flag as { flagStatus?: string }).flagStatus === "flagged";
  if (body.importance === "low" || body.importance === "normal" || body.importance === "high")
    m.importance = body.importance;
  if (Array.isArray(body.categories)) m.categories = body.categories.map(String);
  if (typeof body.subject === "string") m.subject = body.subject;
  if (body.body && typeof body.body === "object") {
    const b = body.body as { contentType?: string; content?: string };
    m.body = {
      contentType: b.contentType?.toLowerCase() === "html" ? "html" : "text",
      content: b.content ?? "",
    };
  }
  const list = (value: unknown) => (Array.isArray(value) ? (value as Recipient[]) : null);
  const named = (rs: Recipient[]) =>
    rs.map((r) => ({
      emailAddress: {
        name: r.emailAddress?.name || r.emailAddress?.address,
        address: r.emailAddress?.address,
      },
    }));
  const to = list(body.toRecipients);
  const cc = list(body.ccRecipients);
  const bcc = list(body.bccRecipients);
  if (to) m.to = named(to);
  if (cc) m.cc = named(cc);
  if (bcc) m.bcc = named(bcc);
}

function draft(box: Mailbox, fields: Partial<Message>): Message {
  const id = newId(box, "Ms");
  return {
    id,
    conversationId: newId(box, "Cv"),
    folderId: wellKnown(box, "drafts"),
    subject: "",
    body: { contentType: "html", content: "" },
    from: recipient({ name: box.name, email: box.email }),
    to: [],
    cc: [],
    bcc: [],
    received: Date.now(),
    sent: null,
    isRead: true,
    isDraft: true,
    flagged: false,
    importance: "normal",
    categories: [],
    internetMessageId: `<${id}@${domainOf(box.email)}>`,
    headers: [],
    attachments: [],
    version: 0,
    ...fields,
  };
}

function newMessage(box: Mailbox, req: Req, folderId?: string): Answer {
  const m = draft(box, folderId ? { folderId } : {});
  applyFields(m, fields(req));
  addMessage(box, m);
  return ok(messageResource(box, m), 201);
}

function sendDraft(box: Mailbox, m: Message): Answer {
  if (!m.isDraft) return graphError(400, "ErrorInvalidOperation", "This message was already sent.");
  if (m.to.length + m.cc.length + m.bcc.length === 0) {
    return graphError(400, "ErrorInvalidRecipients", "At least one recipient isn't valid.");
  }
  const now = Date.now();
  m.isDraft = false;
  m.isRead = true;
  m.sent = now;
  m.received = now;
  moveTo(box, m, wellKnown(box, "sentitems"));
  deliverToSelf(box, m);
  return ok(undefined, 202);
}

function reply(box: Mailbox, m: Message, kind: "createReply" | "createReplyAll" | "createForward") {
  const forward = kind === "createForward";
  const prefix = forward ? "FW: " : "RE: ";
  const others = (list: Recipient[]) =>
    list.filter((r) => r.emailAddress.address.toLowerCase() !== box.email);
  const to = forward
    ? []
    : kind === "createReplyAll"
      ? [...others([m.from]), ...others(m.to)]
      : m.from.emailAddress.address.toLowerCase() === box.email
        ? m.to
        : [m.from];
  const quoted = plainText(m)
    .split("\n")
    .map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;"))
    .join("<br>");
  const created = draft(box, {
    conversationId: m.conversationId,
    subject: /^(re|fw):/i.test(m.subject) ? m.subject : `${prefix}${m.subject}`,
    body: {
      contentType: "html",
      content: `<div><br></div><hr><div><b>From:</b> ${m.from.emailAddress.name}<br><b>Sent:</b> ${rfc2822(m.sent ?? m.received)}<br><b>Subject:</b> ${m.subject}</div><div>${quoted}</div>`,
    },
    to,
    cc: kind === "createReplyAll" ? others(m.cc) : [],
    inReplyTo: m.internetMessageId,
    references: [m.references, m.internetMessageId].filter(Boolean).join(" "),
    attachments: forward ? structuredClone(m.attachments) : [],
  });
  addMessage(box, created);
  return ok(messageResource(box, created), 201);
}

const uploads = new Map<
  string,
  {
    email: string;
    messageId: string;
    name: string;
    contentType: string;
    bytes: Uint8Array;
    received: number;
  }
>();

function attachments(box: Mailbox, req: Req, m: Message, rest: string[]): Answer {
  const [id, action] = rest;
  if (!id) {
    if (req.method === "POST") {
      const body = fields(req);
      const bytes = fromBase64(String(body.contentBytes ?? ""));
      const attachment: Attachment = {
        id: newId(box, "At"),
        name: String(body.name ?? "attachment"),
        contentType: String(body.contentType ?? "application/octet-stream"),
        contentBytes: toBase64(bytes),
        size: bytes.length,
        isInline: body.isInline === true,
        contentId: typeof body.contentId === "string" ? body.contentId : undefined,
      };
      m.attachments.push(attachment);
      touch(box, m);
      return ok(attachmentResource(attachment, false), 201);
    }
    return ok({
      value: m.attachments.map((a) => pick(attachmentResource(a, !select(req)), select(req))),
    });
  }
  if (id === "createUploadSession" && req.method === "POST") {
    const item = (fields(req).AttachmentItem ?? {}) as {
      name?: string;
      size?: number;
      contentType?: string;
    };
    const token = newId(box, "Up");
    uploads.set(token, {
      email: box.email,
      messageId: m.id,
      name: item.name ?? "attachment",
      contentType: item.contentType ?? "application/octet-stream",
      bytes: new Uint8Array(item.size ?? 0),
      received: 0,
    });
    return ok(
      {
        uploadUrl: `https://${GRAPH_HOST}/demo-upload/${token}`,
        expirationDateTime: iso(Date.now() + 3_600_000),
        nextExpectedRanges: ["0-"],
      },
      201,
    );
  }
  const attachment = m.attachments.find((a) => a.id === id);
  if (!attachment) return notFound();
  if (req.method === "DELETE") {
    m.attachments = m.attachments.filter((a) => a !== attachment);
    touch(box, m);
    return ok(undefined, 204);
  }
  if (action === "$value") {
    return {
      status: 200,
      bytes: fromBase64(attachment.contentBytes),
      contentType: attachment.contentType,
    };
  }
  return ok(pick(attachmentResource(attachment, true), select(req)));
}

/** An upload session's chunk (no bearer: the URL is the authorization). */
function upload(url: URL, method: string, headers: Headers, raw: unknown): Answer {
  const token = url.pathname.split("/")[2] ?? "";
  const session = uploads.get(token);
  if (!session) return notFound();
  if (method === "DELETE") {
    uploads.delete(token);
    return ok(undefined, 204);
  }
  const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers.get("Content-Range") ?? "");
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : typeof raw === "string"
          ? utf8(raw)
          : new Uint8Array();
  if (!range) return badRequest("Content-Range is missing.");
  const [start, end, total] = range.slice(1).map(Number);
  if (total !== session.bytes.length || end - start + 1 !== bytes.length) {
    return badRequest("The chunk doesn't match its Content-Range.");
  }
  session.bytes.set(bytes, start);
  session.received += bytes.length;
  if (session.received < total) {
    return ok({
      expirationDateTime: iso(Date.now() + 3_600_000),
      nextExpectedRanges: [`${end + 1}-`],
    });
  }
  uploads.delete(token);
  const box = state.mailboxes[session.email];
  const m = box?.messages[session.messageId];
  if (!box || !m) return notFound();
  m.attachments.push({
    id: newId(box, "At"),
    name: session.name,
    contentType: session.contentType,
    contentBytes: toBase64(session.bytes),
    size: total,
    isInline: false,
  });
  touch(box, m);
  return ok(undefined, 201);
}

function messages(box: Mailbox, req: Req, rest: string[]): Answer {
  const [id, action, ...more] = rest;
  if (!id) return req.method === "POST" ? newMessage(box, req) : listMessages(box, req, null);
  const m = box.messages[id];
  if (!m) return notFound();
  switch (action) {
    case undefined:
      if (req.method === "PATCH") {
        applyFields(m, fields(req));
        touch(box, m);
      } else if (req.method === "DELETE") {
        moveTo(box, m, wellKnown(box, "deleteditems"));
        return ok(undefined, 204);
      }
      return ok(pick(messageResource(box, m), select(req)));
    case "$value":
      return { status: 200, bytes: mimeSource(m), contentType: "message/rfc822" };
    case "move":
    case "copy": {
      const to = resolveFolder(box, String(fields(req).destinationId ?? ""));
      if (!to || to.id === box.rootId) return notFound();
      if (action === "move") {
        moveTo(box, m, to.id);
        return ok(messageResource(box, m), 201);
      }
      const copy = { ...structuredClone(m), id: newId(box, "Ms"), folderId: to.id };
      addMessage(box, copy);
      return ok(messageResource(box, copy), 201);
    }
    case "permanentDelete":
      deleteMessage(box, m);
      return ok(undefined, 204);
    case "createReply":
    case "createReplyAll":
    case "createForward":
      return reply(box, m, action);
    case "send":
      return sendDraft(box, m);
    case "attachments":
      return attachments(box, req, m, more);
  }
  return badRequest(`Resource not found for the segment '${action}'.`);
}

/** `sendMail`: a base64 MIME message (what core sends), or Graph's JSON message. */
function sendMail(box: Mailbox, req: Req): Answer {
  if (typeof req.body !== "string") {
    const m = draft(box, {});
    applyFields(m, ((req.body ?? {}) as { message?: Record<string, unknown> }).message ?? {});
    addMessage(box, m);
    return sendDraft(box, m);
  }
  const parsed = parseMime(new TextDecoder().decode(fromBase64(req.body.trim())));
  const header = (name: string) =>
    parsed.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  const inReplyTo = header("in-reply-to") || undefined;
  const original = inReplyTo
    ? Object.values(box.messages).find((m) => m.internetMessageId === inReplyTo)
    : undefined;
  const m = draft(box, {
    ...(original ? { conversationId: original.conversationId } : {}),
    subject: header("subject"),
    body:
      parsed.html !== null
        ? { contentType: "html", content: parsed.html }
        : { contentType: "text", content: parsed.text ?? "" },
    to: parseAddresses(header("to")),
    cc: parseAddresses(header("cc")),
    bcc: parseAddresses(header("bcc")),
    ...(header("message-id") ? { internetMessageId: header("message-id") } : {}),
    inReplyTo,
    references: header("references") || undefined,
    attachments: parsed.attachments.map((a) => ({
      id: newId(box, "At"),
      name: a.filename,
      contentType: a.mimeType,
      contentBytes: toBase64(fromBase64(a.data)),
      size: a.size,
      isInline: false,
    })),
  });
  addMessage(box, m);
  return sendDraft(box, m);
}

function categories(box: Mailbox, req: Req, id: string | undefined): Answer {
  if (!id) {
    if (req.method === "POST") {
      const body = fields(req);
      const displayName = String(body.displayName ?? "").trim();
      if (!displayName) return badRequest("A category needs a name.");
      if (box.categories.some((c) => c.displayName.toLowerCase() === displayName.toLowerCase())) {
        return graphError(
          409,
          "ErrorDuplicateCategory",
          "A category with this name already exists.",
        );
      }
      const category = {
        id: newId(box, "Ca"),
        displayName,
        color: typeof body.color === "string" ? body.color : "none",
      };
      box.categories.push(category);
      save();
      return ok(category, 201);
    }
    return ok({ value: box.categories });
  }
  const category = box.categories.find((c) => c.id === id);
  if (!category) return notFound();
  if (req.method === "DELETE") {
    box.categories = box.categories.filter((c) => c !== category);
    save();
    return ok(undefined, 204);
  }
  if (req.method === "PATCH") {
    const color = fields(req).color;
    if (typeof color === "string") category.color = color;
    save();
  }
  return ok(category);
}

function eventFields(e: CalendarEvent, body: Record<string, unknown>): void {
  if (typeof body.subject === "string") e.subject = body.subject;
  if (body.body && typeof body.body === "object") {
    e.body = String((body.body as { content?: string }).content ?? "");
  }
  if (body.location && typeof body.location === "object") {
    e.location = String((body.location as { displayName?: string }).displayName ?? "");
  }
  if (typeof body.isAllDay === "boolean") e.isAllDay = body.isAllDay;
  const start = parseTime(body.start);
  const end = parseTime(body.end);
  if (Number.isFinite(start)) e.start = start;
  if (Number.isFinite(end)) e.end = end;
  if (e.end <= e.start) e.end = e.start + (e.isAllDay ? 86_400_000 : 3_600_000);
  if (Array.isArray(body.attendees)) {
    e.attendees = (body.attendees as Recipient[]).map((a) => ({
      emailAddress: {
        name: a.emailAddress?.name ?? a.emailAddress?.address,
        address: a.emailAddress?.address,
      },
      type: "required",
      status: { response: "none" },
    }));
  }
}

const RSVP: Record<string, string> = {
  accept: "accepted",
  decline: "declined",
  tentativelyAccept: "tentativelyAccepted",
};

function events(box: Mailbox, req: Req, rest: string[]): Answer {
  const [id, action] = rest;
  if (!id) {
    if (req.method === "POST") {
      const eventId = newId(box, "Ev");
      const event: CalendarEvent = {
        id: eventId,
        iCalUId: `${eventId}@${domainOf(box.email)}`,
        subject: "",
        body: "",
        start: Date.now(),
        end: Date.now() + 3_600_000,
        isAllDay: false,
        location: "",
        organizer: recipient({ name: box.name, email: box.email }),
        attendees: [],
        isOrganizer: true,
        response: "organizer",
        isCancelled: false,
      };
      eventFields(event, fields(req));
      box.events[eventId] = event;
      save();
      return ok(eventResource(event), 201);
    }
    let list = Object.values(box.events);
    const filter = req.url.searchParams.get("$filter");
    if (filter) {
      const test = parseFilter<CalendarEvent>(filter, {
        iCalUId: (e, v) => e.iCalUId === v,
        subject: (e, v) => e.subject === v,
      });
      if (!test) return badRequest(`Invalid filter clause: ${filter}`);
      list = list.filter(test);
    }
    list.sort((a, b) => a.start - b.start);
    return page(req, list, (e) => pick(eventResource(e), select(req)));
  }
  const event = box.events[id];
  if (!event) return notFound();
  if (!action) {
    if (req.method === "DELETE") {
      delete box.events[id];
      save();
      return ok(undefined, 204);
    }
    if (req.method === "PATCH") {
      eventFields(event, fields(req));
      save();
    }
    return ok(pick(eventResource(event), select(req)));
  }
  if (action === "cancel") {
    if (!event.isOrganizer) return badRequest("Only the organizer can cancel a meeting.");
    delete box.events[id];
    save();
    return ok(undefined, 202);
  }
  const response = RSVP[action];
  if (!response) return badRequest(`Resource not found for the segment '${action}'.`);
  if (event.isOrganizer) return badRequest("You can't respond to a meeting you organized.");
  event.response = response;
  for (const a of event.attendees) {
    if (a.emailAddress.address.toLowerCase() === box.email) a.status = { response };
  }
  save();
  return ok(undefined, 202);
}

function calendarView(box: Mailbox, req: Req): Answer {
  const from = Date.parse(req.url.searchParams.get("startDateTime") ?? "");
  const to = Date.parse(req.url.searchParams.get("endDateTime") ?? "");
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return badRequest("calendarView needs startDateTime and endDateTime.");
  }
  const list = Object.values(box.events)
    .filter((e) => e.start < to && e.end > from)
    .sort((a, b) => a.start - b.start);
  return page(req, list, (e) => pick(eventResource(e), select(req)));
}

function subscriptions(box: Mailbox, req: Req, id: string | undefined): Answer {
  if (!id) {
    if (req.method !== "POST") return ok({ value: box.subscriptions.map((s) => ({ id: s })) });
    const subscription = newId(box, "Su");
    box.subscriptions.push(subscription);
    save();
    return ok({ id: subscription, ...fields(req) }, 201);
  }
  if (!box.subscriptions.includes(id)) return notFound();
  if (req.method === "DELETE") {
    box.subscriptions = box.subscriptions.filter((s) => s !== id);
    save();
    return ok(undefined, 204);
  }
  return ok({ id, ...fields(req) });
}

function route(box: Mailbox, req: Req): Answer {
  const [root, collection, ...rest] = req.path;
  if (root === "$batch" && req.method === "POST") return batch(box, req);
  if (root === "subscriptions") return subscriptions(box, req, collection);
  if (root !== "me") return badRequest(`Resource not found for the segment '${root}'.`);
  switch (collection) {
    case undefined:
      return ok(
        pick(
          {
            id: `demo-${box.email}`,
            displayName: box.name,
            mail: box.email,
            userPrincipalName: box.email,
          },
          select(req),
        ),
      );
    case "photo":
    case "photos":
      return graphError(404, "ImageNotFound", "The photo wasn't found.");
    case "mailFolders":
      return mailFolders(box, req, rest);
    case "outlook":
      return rest[0] === "masterCategories"
        ? categories(box, req, rest[1])
        : badRequest(`Resource not found for the segment '${rest[0]}'.`);
    case "messages":
      return messages(box, req, rest);
    case "sendMail":
      return sendMail(box, req);
    case "events":
      return events(box, req, rest);
    case "calendarView":
      return calendarView(box, req);
  }
  return badRequest(`Resource not found for the segment '${collection}'.`);
}

/** A request's path segments after the version (`/v1.0/me/messages/…` → me, messages, …). */
const segments = (url: URL) =>
  url.pathname
    .replace(/^\/v1\.0\/?/, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

/** `$batch`: up to 20 requests with URLs relative to the version, answered together. */
function batch(box: Mailbox, req: Req): Answer {
  const requests =
    (
      fields(req) as {
        requests?: {
          id: string;
          method: string;
          url: string;
          headers?: Record<string, string>;
          body?: unknown;
        }[];
      }
    ).requests ?? [];
  if (requests.length > 20) return badRequest("A batch takes at most 20 requests.");
  return ok({
    responses: requests.map((r) => {
      const url = new URL(`${GRAPH}${r.url.startsWith("/") ? "" : "/"}${r.url}`);
      const answer = route(box, {
        method: r.method.toUpperCase(),
        url,
        path: segments(url),
        body: r.body,
        prefer: r.headers?.Prefer ?? "",
      });
      return {
        id: r.id,
        status: answer.status,
        headers: { "Content-Type": answer.contentType ?? "application/json" },
        ...(answer.bytes
          ? { body: toBase64(answer.bytes) }
          : answer.body !== undefined
            ? { body: answer.body }
            : {}),
      };
    }),
  });
}

function answer(url: URL, method: string, headers: Headers, raw: unknown): Answer {
  if (url.pathname.startsWith("/demo-upload/")) return upload(url, method, headers, raw);
  const account = /^Bearer (.+)$/.exec(headers.get("Authorization") ?? "")?.[1] ?? "";
  const email = account.startsWith(TOKEN_PREFIX) ? account.slice(TOKEN_PREFIX.length) : "";
  const box = state.mailboxes[email];
  if (!box || !state.signedIn.includes(email)) {
    return graphError(401, "InvalidAuthenticationToken", "Access token is empty or invalid.");
  }
  let body: unknown = raw;
  if (typeof raw === "string" && /json/i.test(headers.get("Content-Type") ?? "")) {
    try {
      body = JSON.parse(raw);
    } catch {
      return badRequest("The body isn't JSON.");
    }
  }
  return route(box, {
    method,
    url,
    path: segments(url),
    body,
    prefer: headers.get("Prefer") ?? "",
  });
}

function toResponse(answer: Answer): Response {
  if (answer.bytes) {
    return new Response(answer.bytes as BodyInit, {
      status: answer.status,
      headers: { "Content-Type": answer.contentType ?? "application/octet-stream" },
    });
  }
  const empty = answer.body === undefined || answer.status === 204;
  return new Response(empty ? null : JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Loads (or seeds) the demo's Outlook mailbox and puts the pretend Graph in
 * front of fetch; everything else goes on to the fetch it wraps (the fake
 * Gmail's, when that's installed first).
 */
export async function installFakeOutlook(demoFiles: Platform["files"]): Promise<void> {
  files = demoFiles;
  await loadState();
  const next = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    if (url.hostname !== GRAPH_HOST) return next(input, init);
    const raw = init?.body ?? (request ? new Uint8Array(await request.arrayBuffer()) : undefined);
    const response = answer(
      url,
      (init?.method ?? request?.method ?? "GET").toUpperCase(),
      new Headers(init?.headers ?? request?.headers),
      raw,
    );
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
    return toResponse(response);
  };
}

// ── Sign-in ──────────────────────────────────────────────────────────────────

function demoAccount(seed: OutlookSeedAccount): GmailAccount {
  return {
    id: seed.email,
    email: seed.email,
    name: seed.name,
    provider: "outlook",
    displayName: seed.displayName,
    color: seed.color,
    picture: seed.picture,
    signature: `<div>${seed.name}<br>Contoso Design</div>`,
  };
}

/** The demo's Outlook mailbox is signed in; "adding an Outlook mailbox" brings it back. */
export function demoMicrosoftAuth(): MicrosoftAuth {
  const seed = DEMO_OUTLOOK_ACCOUNT;
  return {
    available: async () => true,
    // The mailbox appears beside the Gmail ones the first time the demo opens.
    async load() {
      if (state.introduced) return;
      state.introduced = true;
      save();
      if (!(await accountStore.getAccount(seed.email))) {
        await accountStore.addAccount(demoAccount(seed));
      }
    },
    async addAccount() {
      if (!state.signedIn.includes(seed.email)) state.signedIn.push(seed.email);
      save();
      return { email: seed.email, name: seed.name };
    },
    cancelSignIn() {},
    isSignedIn: (accountId) => state.signedIn.includes(accountId),
    getAccessToken: async (accountId) => `${TOKEN_PREFIX}${accountId}`,
    getIdToken: async () => "demo-microsoft-id-token",
    async removeTokens(accountId) {
      state.signedIn = state.signedIn.filter((email) => email !== accountId);
      save();
    },
  };
}
