/**
 * The calendar tools: the calendar of every mailbox whose provider has one
 * (`capabilities.calendar`; Google Calendar's primary calendar for Gmail).
 */

import { providerFor } from "../../../providers/index.js";
import {
  NoCalendarAccess,
  type CalendarEvent,
  type EventInput,
  type MailProvider,
  type RsvpResponse,
} from "../../../providers/provider.js";
import type { MailAccount } from "../../../types.js";
import {
  mailbox,
  mailboxes,
  optBool,
  optInt,
  optStr,
  str,
  strList,
  type AgentTool,
  type ToolArgs,
} from "./tool.js";

type Calendar = NonNullable<MailProvider["calendar"]>;

/** The mailbox's calendar; calls that it may not make say how to allow them. */
async function calendarOf<T>(
  account: MailAccount,
  work: (calendar: Calendar) => Promise<T>,
): Promise<T> {
  const calendar = account.capabilities?.calendar ? providerFor(account.id).calendar : undefined;
  if (!calendar) throw new Error(`${account.email} has no calendar in Otter Mail.`);
  try {
    return await work(calendar);
  } catch (error) {
    if (error instanceof NoCalendarAccess)
      throw new Error(
        `Otter Mail may not use ${account.email}'s calendar yet: the user can allow it by signing in to the mailbox again (Settings → Mailboxes).`,
        { cause: error },
      );
    throw error;
  }
}

/** An ISO date or date-time argument; a date alone is midnight here. */
function instant(value: string, key: string): Date {
  const time = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00`) : new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`"${key}" must be an ISO date or date-time.`);
  return time;
}

const RESPONSES: RsvpResponse[] = ["accepted", "declined", "tentative"];

/** The fields of an event to create or change. */
function eventInput(args: ToolArgs): EventInput {
  for (const key of ["start", "end"]) {
    const value = optStr(args, key);
    if (value && !optBool(args, "allDay")) instant(value, key);
  }
  const input: EventInput = {
    title: optStr(args, "title"),
    start: optStr(args, "start"),
    end: optStr(args, "end"),
    allDay: optBool(args, "allDay"),
    timeZone: optStr(args, "timeZone"),
    location: optStr(args, "location"),
    description: typeof args.description === "string" ? args.description : undefined,
    attendees: strList(args, "attendees"),
    videoCall: optBool(args, "videoCall"),
  };
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as EventInput;
}

/** An event as approvals show it. */
function describeEvent(event: Pick<CalendarEvent, "title" | "start" | "end">): string {
  return `“${event.title}”, ${event.start} – ${event.end}`;
}

/** What an input sets, one line each, for approvals. */
function describeInput(input: EventInput): string {
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join("\n");
}

const notifyNote = (notify: boolean) => (notify ? "Attendees are told." : "Attendees aren't told.");

const ACCOUNT = {
  type: "string",
  description: "The mailbox whose calendar it is, by address. Optional when there's only one.",
} as const;

const EVENT_FIELDS = {
  title: { type: "string" },
  start: {
    type: "string",
    description:
      "ISO date-time (2026-10-01T14:00, this device's time zone unless it has an offset), or a date for all-day events.",
  },
  end: {
    type: "string",
    description:
      "Same form as start. All-day events end the day after their last day. Left out: an hour (or a day) after the start; when moving an event, its length stays.",
  },
  allDay: { type: "boolean" },
  timeZone: { type: "string", description: "IANA zone for the times (Europe/Paris)." },
  location: { type: "string" },
  description: { type: "string" },
  attendees: {
    type: "array",
    items: { type: "string" },
    description: "Every attendee's address (replaces the list when changing an event).",
  },
  videoCall: { type: "boolean", description: "Adds a video call link (Google Meet)." },
  notify: { type: "boolean", description: "Email the attendees about it (default true)." },
} as const;

export const calendarTools: AgentTool[] = [
  {
    name: "list_events",
    title: "List events",
    description:
      "Events in the calendars of every mailbox that has one (or those named), soonest first; recurring events as their occurrences. Default: the next 7 days.",
    input: {
      type: "object",
      properties: {
        accounts: { type: "array", items: { type: "string" }, description: "By address." },
        from: { type: "string", description: "ISO date or date-time; default now." },
        to: { type: "string", description: "Default 7 days after `from`." },
        query: { type: "string", description: "Words to find in the events." },
        limit: { type: "number", description: "Per calendar; default 50, at most 250." },
      },
    },
    readOnly: true,
    async run(args) {
      const named = Boolean(strList(args, "accounts")?.length);
      const accounts = (await mailboxes(args)).filter(
        (a) => named || (a.capabilities?.calendar && !a.signedOut),
      );
      const fromArg = optStr(args, "from");
      const toArg = optStr(args, "to");
      const from = fromArg ? instant(fromArg, "from") : new Date();
      const to = toArg ? instant(toArg, "to") : new Date(from.getTime() + 7 * 86_400_000);
      const limit = optInt(args, "limit", 250) ?? 50;
      const lists = await Promise.allSettled(
        accounts.map((account) =>
          calendarOf(account, (calendar) =>
            calendar.listEvents(account.id, {
              from: from.toISOString(),
              to: to.toISOString(),
              query: optStr(args, "query"),
              limit,
            }),
          ).then((events) => events.map((e) => ({ account: account.email, ...e }))),
        ),
      );
      // One calendar it can't read doesn't hide the others.
      const errors = lists.flatMap((l) =>
        l.status === "rejected"
          ? [l.reason instanceof Error ? l.reason.message : String(l.reason)]
          : [],
      );
      if (errors.length > 0 && errors.length === lists.length) throw new Error(errors.join("\n"));
      return {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(errors.length ? { errors } : {}),
        events: lists
          .flatMap((l) => (l.status === "fulfilled" ? l.value : []))
          .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
          .map((e) => ({
            ...e,
            description: e.description && e.description.slice(0, 1_000),
          })),
      };
    },
  },
  {
    name: "get_event",
    title: "Read an event",
    description: "One event, whole: its time, place, description, attendees and their answers.",
    input: {
      type: "object",
      properties: { account: ACCOUNT, eventId: { type: "string" } },
      required: ["eventId"],
    },
    readOnly: true,
    async run(args) {
      const account = await mailbox(args);
      return calendarOf(account, (calendar) => calendar.getEvent(account.id, str(args, "eventId")));
    },
  },
  {
    name: "create_event",
    title: "Add an event",
    permanent: true,
    description: "Adds an event to the mailbox's calendar, inviting any attendees.",
    input: {
      type: "object",
      properties: { account: ACCOUNT, ...EVENT_FIELDS },
      required: ["title", "start"],
    },
    async run(args, ctx) {
      const account = await mailbox(args);
      const input = eventInput(args);
      if (!input.title || !input.start) throw new Error(`"title" and "start" are required.`);
      const notify = optBool(args, "notify") ?? true;
      return calendarOf(account, async (calendar) => {
        await ctx.confirm(
          `Add to ${account.email}'s calendar\n${describeInput(input)}${input.attendees?.length ? `\n${notifyNote(notify)}` : ""}`,
        );
        const saved = await calendar.createEvent(account.id, input, notify);
        ctx.changed?.({
          action: "created",
          title: saved.title,
          target: { kind: "event", id: saved.id, accountId: account.id, url: saved.htmlLink },
        });
        return saved;
      });
    },
  },
  {
    name: "update_event",
    title: "Change an event",
    permanent: true,
    description: "Changes an event: only the fields given change.",
    input: {
      type: "object",
      properties: { account: ACCOUNT, eventId: { type: "string" }, ...EVENT_FIELDS },
      required: ["eventId"],
    },
    async run(args, ctx) {
      const account = await mailbox(args);
      const eventId = str(args, "eventId");
      const input = eventInput(args);
      if (Object.keys(input).length === 0) throw new Error("Nothing to change.");
      const notify = optBool(args, "notify") ?? true;
      return calendarOf(account, async (calendar) => {
        const event = await calendar.getEvent(account.id, eventId);
        await ctx.confirm(
          `Change ${describeEvent(event)} in ${account.email}'s calendar\n${describeInput(input)}${event.attendees.length ? `\n${notifyNote(notify)}` : ""}`,
        );
        const saved = await calendar.updateEvent(account.id, eventId, input, notify);
        ctx.changed?.({
          action: "updated",
          title: saved.title,
          target: { kind: "event", id: saved.id, accountId: account.id, url: saved.htmlLink },
        });
        return saved;
      });
    },
  },
  {
    name: "delete_event",
    title: "Delete an event",
    permanent: true,
    description:
      "Deletes an event from the mailbox's calendar (for an invitation, decline it instead).",
    input: {
      type: "object",
      properties: {
        account: ACCOUNT,
        eventId: { type: "string" },
        notify: EVENT_FIELDS.notify,
      },
      required: ["eventId"],
    },
    async run(args, ctx) {
      const account = await mailbox(args);
      const eventId = str(args, "eventId");
      const notify = optBool(args, "notify") ?? true;
      return calendarOf(account, async (calendar) => {
        const event = await calendar.getEvent(account.id, eventId);
        await ctx.confirm(
          `Delete ${describeEvent(event)} from ${account.email}'s calendar${event.attendees.length ? `\n${notifyNote(notify)}` : ""}`,
        );
        await calendar.deleteEvent(account.id, eventId, notify);
        ctx.changed?.({
          action: "deleted",
          title: event.title,
          target: { kind: "event", id: event.id, accountId: account.id, url: event.htmlLink },
        });
        return { deleted: true };
      });
    },
  },
  {
    name: "respond_to_event",
    title: "Answer an invitation",
    permanent: true,
    description: "Accepts, declines or tentatively accepts an invitation; the organizer is told.",
    input: {
      type: "object",
      properties: {
        account: ACCOUNT,
        eventId: { type: "string" },
        response: { type: "string", enum: RESPONSES },
      },
      required: ["eventId", "response"],
    },
    async run(args, ctx) {
      const account = await mailbox(args);
      const eventId = str(args, "eventId");
      const response = str(args, "response") as RsvpResponse;
      if (!RESPONSES.includes(response))
        throw new Error(`"response" must be one of ${RESPONSES.join(", ")}.`);
      return calendarOf(account, async (calendar) => {
        const event = await calendar.getEvent(account.id, eventId);
        await ctx.confirm(`Answer ${describeEvent(event)} in ${account.email}: ${response}`);
        const saved = await calendar.respondToEvent(account.id, eventId, response);
        ctx.changed?.({
          action: "updated",
          title: saved.title,
          target: { kind: "event", id: saved.id, accountId: account.id, url: saved.htmlLink },
        });
        return saved;
      });
    },
  },
];
