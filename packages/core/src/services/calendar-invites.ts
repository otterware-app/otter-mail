/**
 * Calendar invitations in the reader: read the invite's .ics, show your
 * current answer, and RSVP in place — the way Gmail's Yes / No / Maybe do.
 *
 * RSVP goes through the account's calendar when its provider has one
 * (Google Calendar: your calendar updates and the organizer is notified).
 * Otherwise, and for Gmail accounts connected before the app asked for
 * calendar access, it's a standard iMIP REPLY email to the organizer (what
 * Apple Mail / Outlook send), which the organizer's calendar applies.
 */

import { logger } from "../logger.js";
import { fromBase64, toBase64, utf8Decode, utf8Encode } from "../bytes.js";
import { providerFor } from "../providers/index.js";
import { NoCalendarAccess, type RsvpResponse } from "../providers/provider.js";
import { getAccount } from "./account-store.js";
import { getAttachmentData } from "./attachment-cache.js";
import * as store from "./mail-store.js";

export type { RsvpResponse };

export type CalendarInvite = {
  uid: string;
  method: string;
  summary: string;
  /** ISO start/end; all-day events have date-only values. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  organizer: { name: string; email: string } | null;
  sequence: number;
  /** Your answer: from the calendar when readable, else the last one sent from here. */
  response: RsvpResponse | "needsAction";
  /** No calendar to answer in for this account (email replies are used). */
  calendarAccess: boolean;
  /** Link to the event in the calendar. */
  htmlLink: string | null;
  /** The invite was cancelled (METHOD:CANCEL). */
  cancelled: boolean;
};

// ---------------------------------------------------------------------------
// iCalendar parsing (just what an invitation needs)
// ---------------------------------------------------------------------------

type Prop = { name: string; params: Record<string, string>; value: string };

function unfold(ics: string): string[] {
  return ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function parseLine(line: string): Prop | null {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon < 0) return null;
  const [head, ...paramParts] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: head.toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

/** DTSTART/DTEND → ISO (UTC "Z", floating/TZID read as local wall time). */
function toIso(prop: Prop | undefined): { iso: string | null; allDay: boolean } {
  if (!prop) return { iso: null, allDay: false };
  const v = prop.value;
  const date = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (date || prop.params.VALUE === "DATE") {
    const [, y, m, d] = date ?? v.match(/^(\d{4})(\d{2})(\d{2})/)!;
    return { iso: `${y}-${m}-${d}`, allDay: true };
  }
  const dt = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!dt) return { iso: null, allDay: false };
  const [, y, m, d, hh, mm, ss, z] = dt;
  return { iso: `${y}-${m}-${d}T${hh}:${mm}:${ss}${z ? "Z" : ""}`, allDay: false };
}

type ParsedIcs = {
  method: string;
  event: Prop[];
  raw: string;
};

function parseIcs(ics: string): ParsedIcs | null {
  const lines = unfold(ics);
  let method = "";
  const event: Prop[] = [];
  let inEvent = false;
  for (const line of lines) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "METHOD" && !inEvent) method = prop.value.toUpperCase();
    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VEVENT") {
      if (event.length > 0) break; // first event only
      inEvent = true;
      continue;
    }
    if (prop.name === "END" && prop.value.toUpperCase() === "VEVENT") inEvent = false;
    else if (inEvent) event.push(prop);
  }
  return event.length > 0 ? { method, event, raw: ics } : null;
}

const get = (event: Prop[], name: string) => event.find((p) => p.name === name);
const mailto = (value: string) =>
  value
    .replace(/^mailto:/i, "")
    .trim()
    .toLowerCase();

// ---------------------------------------------------------------------------
// Invite lookup
// ---------------------------------------------------------------------------

const icsCache = new Map<string, ParsedIcs | null>();

async function inviteIcs(accountId: string, messageId: string): Promise<ParsedIcs | null> {
  const key = `${accountId}:${messageId}`;
  if (icsCache.has(key)) return icsCache.get(key)!;
  const detail =
    store.getMessageDetail(accountId, messageId) ??
    (await providerFor(accountId).getMessage(accountId, messageId));
  const part = detail.attachments.find(
    (a) => /text\/calendar|application\/ics/i.test(a.mimeType) || /\.ics$/i.test(a.filename),
  );
  let parsed: ParsedIcs | null = null;
  if (part) {
    const { base64 } = await getAttachmentData(accountId, messageId, part.id);
    parsed = parseIcs(utf8Decode(fromBase64(base64)));
  }
  icsCache.set(key, parsed);
  return parsed;
}

const kvKey = (accountId: string, uid: string) => `rsvp:${accountId}:${uid}`;

export async function getInvite(
  accountId: string,
  messageId: string,
): Promise<CalendarInvite | null> {
  const ics = await inviteIcs(accountId, messageId);
  if (!ics) return null;
  const { event, method } = ics;
  const uid = get(event, "UID")?.value;
  if (!uid) return null;
  const email = accountId.toLowerCase();
  const start = toIso(get(event, "DTSTART"));
  const end = toIso(get(event, "DTEND"));
  const organizerProp = get(event, "ORGANIZER");
  const mine = event.find((p) => p.name === "ATTENDEE" && mailto(p.value) === email);
  const icsStatus = mine?.params.PARTSTAT?.toLowerCase();
  const stored = store.getKv(kvKey(accountId, uid)) as RsvpResponse | null;

  let response: CalendarInvite["response"] =
    stored ??
    (icsStatus === "accepted" || icsStatus === "declined" || icsStatus === "tentative"
      ? icsStatus
      : "needsAction");
  const calendar = providerFor(accountId).calendar;
  let calendarAccess = Boolean(calendar);
  let htmlLink: string | null = null;
  try {
    const found = await calendar?.findEvent(accountId, uid);
    if (found) {
      response = found.response;
      htmlLink = found.htmlLink;
    }
  } catch (error) {
    if (error instanceof NoCalendarAccess) calendarAccess = false;
    else logger.info("calendar", "event lookup failed", { error: String(error) });
  }

  return {
    uid,
    method,
    summary: unescapeText(get(event, "SUMMARY")?.value ?? "(no title)"),
    start: start.iso,
    end: end.iso,
    allDay: start.allDay,
    location: get(event, "LOCATION") ? unescapeText(get(event, "LOCATION")!.value) : null,
    organizer: organizerProp
      ? { name: organizerProp.params.CN ?? "", email: mailto(organizerProp.value) }
      : null,
    sequence: Number(get(event, "SEQUENCE")?.value ?? 0) || 0,
    response,
    calendarAccess,
    htmlLink,
    cancelled: method === "CANCEL" || get(event, "STATUS")?.value.toUpperCase() === "CANCELLED",
  };
}

// ---------------------------------------------------------------------------
// RSVP
// ---------------------------------------------------------------------------

const PARTSTAT: Record<RsvpResponse, string> = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
};

const SUBJECT_PREFIX: Record<RsvpResponse, string> = {
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Tentatively accepted",
};

function icsStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** RFC 6047 iMIP REPLY: your PARTSTAT for the organizer's calendar. */
async function sendImipReply(
  accountId: string,
  messageId: string,
  ics: ParsedIcs,
  response: RsvpResponse,
): Promise<void> {
  const { event } = ics;
  const organizer = get(event, "ORGANIZER");
  if (!organizer) throw new Error("This invitation has no organizer to reply to.");
  const account = await getAccount(accountId);
  const me = account?.email ?? accountId;
  const name = account?.name ?? "";
  const summary = unescapeText(get(event, "SUMMARY")?.value ?? "");
  const keep = new Set(["UID", "SEQUENCE", "DTSTART", "DTEND", "RECURRENCE-ID", "SUMMARY"]);
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Otter Mail//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    ...event
      .filter((p) => keep.has(p.name))
      .map(
        (p) =>
          `${p.name}${Object.entries(p.params)
            .map(([k, v]) => `;${k}=${v}`)
            .join("")}:${p.value}`,
      ),
    `DTSTAMP:${icsStamp(new Date())}`,
    `ORGANIZER${organizer.params.CN ? `;CN="${organizer.params.CN}"` : ""}:${organizer.value}`,
    `ATTENDEE;PARTSTAT=${PARTSTAT[response]}${name ? `;CN="${name}"` : ""}:mailto:${me}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const calendar = lines.join("\r\n");
  const boundary = `otter-${Date.now().toString(36)}`;
  const subject = `${SUBJECT_PREFIX[response]}: ${summary}`;
  const text = `${name || me} has ${SUBJECT_PREFIX[response].toLowerCase()} this invitation.`;
  const raw = [
    `From: ${name ? `"${name}" <${me}>` : me}`,
    `To: ${mailto(organizer.value)}`,
    `Subject: =?UTF-8?B?${toBase64(utf8Encode(subject))}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
    `--${boundary}`,
    "Content-Type: text/calendar; charset=UTF-8; method=REPLY",
    "Content-Transfer-Encoding: base64",
    "",
    toBase64(utf8Encode(calendar)).replace(/.{76}/g, "$&\r\n"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const detail = store.getMessageDetail(accountId, messageId);
  await providerFor(accountId).sendRaw(accountId, raw, detail?.threadId);
}

export async function respondToInvite(
  accountId: string,
  messageId: string,
  response: RsvpResponse,
): Promise<CalendarInvite | null> {
  const ics = await inviteIcs(accountId, messageId);
  const uid = ics && get(ics.event, "UID")?.value;
  if (!ics || !uid) throw new Error("This message has no calendar invitation.");

  let viaCalendar = false;
  try {
    viaCalendar =
      (await providerFor(accountId).calendar?.respond(accountId, uid, response)) ?? false;
  } catch (error) {
    if (!(error instanceof NoCalendarAccess)) throw error;
  }
  if (!viaCalendar) await sendImipReply(accountId, messageId, ics, response);

  store.setKv(kvKey(accountId, uid), response);
  logger.info("calendar", "rsvp", { response, via: viaCalendar ? "calendar" : "email" });
  return getInvite(accountId, messageId);
}
