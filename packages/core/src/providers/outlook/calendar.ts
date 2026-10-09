/**
 * The mailbox's Outlook calendar (its default one), through Graph:
 * invitations answered in place (the organizer is told), and its events for
 * the agents' tools. Times come back in UTC (`Prefer: outlook.timezone`); a
 * sign-in that may not use the calendar gets NoCalendarAccess, and
 * services/calendar-invites.ts replies by email instead.
 */

import {
  NoCalendarAccess,
  type CalendarEvent,
  type EventInput,
  type RsvpResponse,
} from "../provider.js";
import { GraphError, graph, isNotFound, type GraphInit } from "./graph.js";

const UTC = 'outlook.timezone="UTC"';

async function calendarGraph<T>(accountId: string, path: string, init: GraphInit = {}) {
  try {
    return await graph<T>(accountId, path, { ...init, prefer: [UTC, ...(init.prefer ?? [])] });
  } catch (err) {
    // Only a sign-in without calendar access; not a suspended account or the like.
    if (
      err instanceof GraphError &&
      err.status === 403 &&
      /AccessDenied|Authorization_RequestDenied|scope|privilege/i.test(`${err.code} ${err.message}`)
    ) {
      throw new NoCalendarAccess(err.message);
    }
    throw err;
  }
}

type ApiTime = { dateTime: string; timeZone?: string };
type ApiAttendee = {
  emailAddress?: { address?: string; name?: string };
  status?: { response?: string };
};

type ApiEvent = {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: ApiTime;
  end?: ApiTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  showAs?: string;
  location?: { displayName?: string };
  organizer?: { emailAddress?: { address?: string; name?: string } };
  attendees?: ApiAttendee[];
  responseStatus?: { response?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  webLink?: string;
  type?: string;
  seriesMasterId?: string | null;
};

const EVENT_FIELDS =
  "id,subject,bodyPreview,start,end,isAllDay,isCancelled,isOrganizer,showAs,location,organizer,attendees,responseStatus,onlineMeeting,onlineMeetingUrl,webLink,type,seriesMasterId";

function asResponse(response: string | undefined): RsvpResponse | "needsAction" {
  if (response === "accepted" || response === "organizer") return "accepted";
  if (response === "declined") return "declined";
  if (response === "tentativelyAccepted") return "tentative";
  return "needsAction";
}

const ACTION: Record<RsvpResponse, string> = {
  accepted: "accept",
  declined: "decline",
  tentative: "tentativelyAccept",
};

const eventPath = (id: string) => `/me/events/${encodeURIComponent(id)}`;

async function lookup(accountId: string, uid: string): Promise<ApiEvent | null> {
  const filter = encodeURIComponent(`iCalUId eq '${uid.replace(/'/g, "''")}'`);
  const found = await calendarGraph<{ value?: ApiEvent[] }>(
    accountId,
    `/me/events?$filter=${filter}&$select=${EVENT_FIELDS}&$top=1`,
  );
  return found.value?.[0] ?? null;
}

export async function findEvent(
  accountId: string,
  uid: string,
): Promise<{ response: RsvpResponse | "needsAction"; htmlLink: string | null } | null> {
  const found = await lookup(accountId, uid);
  if (!found) return null;
  return { response: asResponse(found.responseStatus?.response), htmlLink: found.webLink ?? null };
}

async function answer(accountId: string, eventId: string, response: RsvpResponse) {
  await calendarGraph(accountId, `${eventPath(eventId)}/${ACTION[response]}`, {
    method: "POST",
    body: { sendResponse: true },
  });
}

export async function respond(
  accountId: string,
  uid: string,
  response: RsvpResponse,
): Promise<boolean> {
  const found = await lookup(accountId, uid);
  if (!found) return false;
  await answer(accountId, found.id, response);
  return true;
}

// ── Events, for the agents' tools ───────────────────────────────────────────

/** Graph's UTC times ("2026-10-09T14:00:00.0000000") as ISO; all-day ones as dates. */
function isoTime(time: ApiTime | undefined, allDay: boolean): string {
  if (!time?.dateTime) return "";
  if (allDay) return time.dateTime.slice(0, 10);
  return new Date(`${time.dateTime.replace(/\.\d+$/, "")}Z`).toISOString();
}

function toEvent(e: ApiEvent): CalendarEvent {
  const allDay = e.isAllDay === true;
  return {
    id: e.id,
    title: e.subject || "(no title)",
    start: isoTime(e.start, allDay),
    end: isoTime(e.end, allDay),
    allDay,
    location: e.location?.displayName || null,
    description: e.bodyPreview || null,
    status: e.isCancelled ? "cancelled" : e.showAs === "tentative" ? "tentative" : "confirmed",
    organizer: e.organizer?.emailAddress?.address ?? null,
    attendees: (e.attendees ?? [])
      .filter((a) => a.emailAddress?.address)
      .map((a) => ({
        email: a.emailAddress!.address!,
        ...(a.emailAddress?.name ? { name: a.emailAddress.name } : {}),
        response: asResponse(a.status?.response),
      })),
    response: e.isOrganizer ? null : asResponse(e.responseStatus?.response),
    meetingLink: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? null,
    htmlLink: e.webLink ?? null,
    recurring: e.type !== undefined ? e.type !== "singleInstance" : Boolean(e.seriesMasterId),
  };
}

const DAY_MS = 86_400_000;

/** An input time as Graph wants it: all-day events start and end at midnight in their zone. */
function apiTime(value: string, allDay: boolean, timeZone: string): ApiTime {
  if (allDay) return { dateTime: `${value.slice(0, 10)}T00:00:00`, timeZone };
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`Not a date-time: ${value}`);
  return { dateTime: time.toISOString().slice(0, 19), timeZone: "UTC" };
}

/** How long an event lasts, in ms; an hour (or a day) when there's none. */
function duration(event: ApiEvent | undefined): number {
  const start = event?.start?.dateTime;
  const end = event?.end?.dateTime;
  const ms = start && end ? Date.parse(`${end}Z`) - Date.parse(`${start}Z`) : NaN;
  return ms > 0 ? ms : event?.isAllDay ? DAY_MS : 3_600_000;
}

function apiBody(input: EventInput, current?: ApiEvent): Record<string, unknown> {
  const allDay = input.allDay ?? current?.isAllDay ?? false;
  const timeZone = input.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.subject = input.title;
  if (input.location !== undefined) body.location = { displayName: input.location };
  if (input.description !== undefined) {
    body.body = { contentType: "text", content: input.description };
  }
  if (input.attendees !== undefined) {
    body.attendees = input.attendees.map((address) => ({
      emailAddress: { address },
      type: "required",
    }));
  }
  if (input.allDay !== undefined) body.isAllDay = input.allDay;
  if (input.start !== undefined) {
    body.start = apiTime(input.start, allDay, timeZone);
    const length = current ? duration(current) : allDay ? DAY_MS : 3_600_000;
    const end =
      input.end ??
      (allDay
        ? new Date(Date.parse(`${input.start.slice(0, 10)}T00:00:00Z`) + length)
            .toISOString()
            .slice(0, 10)
        : new Date(new Date(input.start).getTime() + length).toISOString());
    body.end = apiTime(end, allDay, timeZone);
  } else if (input.end !== undefined) {
    body.end = apiTime(input.end, allDay, timeZone);
  }
  if (input.videoCall) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = "teamsForBusiness";
  }
  return body;
}

async function fetchEvent(accountId: string, eventId: string): Promise<ApiEvent> {
  return calendarGraph<ApiEvent>(accountId, `${eventPath(eventId)}?$select=${EVENT_FIELDS}`);
}

export async function listEvents(
  accountId: string,
  range: { from: string; to: string; query?: string; limit: number },
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    startDateTime: new Date(range.from).toISOString(),
    endDateTime: new Date(range.to).toISOString(),
    $orderby: "start/dateTime",
    $select: EVENT_FIELDS,
    // calendarView can't search: look through more, then keep the matches.
    $top: String(range.query ? Math.max(range.limit, 250) : range.limit),
  });
  const data = await calendarGraph<{ value?: ApiEvent[] }>(
    accountId,
    `/me/calendarView?${params.toString()}`,
  );
  const query = range.query?.toLowerCase();
  return (data.value ?? [])
    .filter(
      (e) =>
        !query ||
        [e.subject, e.location?.displayName, e.bodyPreview].some((text) =>
          text?.toLowerCase().includes(query),
        ),
    )
    .slice(0, range.limit)
    .map(toEvent);
}

export async function getEvent(accountId: string, eventId: string): Promise<CalendarEvent> {
  return toEvent(await fetchEvent(accountId, eventId));
}

/**
 * Outlook always tells attendees of a new or changed meeting; `notify` only
 * decides whether a deleted one is cancelled with them or just removed here.
 */
export async function createEvent(
  accountId: string,
  input: EventInput,
  _notify: boolean,
): Promise<CalendarEvent> {
  const body = apiBody(input);
  try {
    return toEvent(
      await calendarGraph<ApiEvent>(accountId, "/me/events", { method: "POST", body }),
    );
  } catch (err) {
    // Personal accounts can't make Teams meetings: the event without one.
    if (!(err instanceof GraphError) || err.status !== 400 || !body.isOnlineMeeting) throw err;
    delete body.isOnlineMeeting;
    delete body.onlineMeetingProvider;
    return toEvent(
      await calendarGraph<ApiEvent>(accountId, "/me/events", { method: "POST", body }),
    );
  }
}

export async function updateEvent(
  accountId: string,
  eventId: string,
  patch: EventInput,
  _notify: boolean,
): Promise<CalendarEvent> {
  const current = patch.start || patch.end ? await fetchEvent(accountId, eventId) : undefined;
  await calendarGraph(accountId, eventPath(eventId), {
    method: "PATCH",
    body: apiBody(patch, current),
  });
  return getEvent(accountId, eventId);
}

export async function deleteEvent(
  accountId: string,
  eventId: string,
  notify: boolean,
): Promise<void> {
  try {
    const event = await fetchEvent(accountId, eventId);
    if (notify && event.isOrganizer && (event.attendees?.length ?? 0) > 0) {
      await calendarGraph(accountId, `${eventPath(eventId)}/cancel`, {
        method: "POST",
        body: { comment: "" },
      });
      return;
    }
    await calendarGraph(accountId, eventPath(eventId), { method: "DELETE" });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

export async function respondToEvent(
  accountId: string,
  eventId: string,
  response: RsvpResponse,
): Promise<CalendarEvent> {
  await answer(accountId, eventId, response);
  return getEvent(accountId, eventId);
}
