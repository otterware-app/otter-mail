/**
 * The RSVP bar above a calendar invitation, like Gmail's: what, when,
 * where, who invited you, and Yes / No / Maybe answered in place (Google
 * Calendar API; email reply to the organizer for accounts without calendar
 * access). Google's own Yes / No / Maybe links in the body route here too.
 */

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "./toast";
import { useCapabilities } from "./capabilities";
import { CalendarIcon, CheckIcon, ExternalLinkIcon, MapPinIcon } from "lucide-react";
import { gmailApi, type CalendarInvite, type RsvpResponse } from "./api";
import { HintTooltip, IconBtn, cn } from "./ui";
import { openLink } from "../browser/store";
import { isModClick } from "../keybindings/keys";

const inviteKey = (accountId: string, messageId: string) => [
  "calendar-invite",
  accountId,
  messageId,
];

/** Google Calendar's RESPOND links carry rst=1 (yes) / 2 (no) / 3 (maybe). */
export function rsvpFromGoogleLink(url: string): RsvpResponse | null {
  if (!/calendar\.google\.com\/calendar\/.*action=RESPOND/i.test(url)) return null;
  const rst = url.match(/[?&]rst=(\d)/)?.[1];
  return rst === "1" ? "accepted" : rst === "2" ? "declined" : rst === "3" ? "tentative" : null;
}

/** Event-wide hook for body links: the reader's frame reports clicks here. */
const listeners = new Set<(messageId: string, response: RsvpResponse) => void>();
export function requestRsvp(messageId: string, response: RsvpResponse): void {
  for (const l of listeners) l(messageId, response);
}

function formatWhen(invite: CalendarInvite): string | null {
  if (!invite.start) return null;
  const start = new Date(invite.allDay ? `${invite.start}T00:00:00` : invite.start);
  const end = invite.end ? new Date(invite.allDay ? `${invite.end}T00:00:00` : invite.end) : null;
  const day = (d: Date) =>
    d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (invite.allDay) {
    // DTEND of an all-day event is exclusive.
    const last = end ? new Date(end.getTime() - 86_400_000) : start;
    return last > start ? `${day(start)} – ${day(last)}` : day(start);
  }
  if (!end) return `${day(start)}, ${time(start)}`;
  return start.toDateString() === end.toDateString()
    ? `${day(start)}, ${time(start)} – ${time(end)}`
    : `${day(start)}, ${time(start)} – ${day(end)}, ${time(end)}`;
}

const CHOICES: { value: RsvpResponse; label: string }[] = [
  { value: "accepted", label: "Yes" },
  { value: "declined", label: "No" },
  { value: "tentative", label: "Maybe" },
];

const DONE: Record<RsvpResponse, string> = {
  accepted: "You're going",
  declined: "You declined",
  tentative: "You might go",
};

export function InviteCard({ accountId, messageId }: { accountId: string; messageId: string }) {
  const qc = useQueryClient();
  // Without a calendar (IMAP) answers always go out by email.
  const { calendar } = useCapabilities(accountId);
  const query = useQuery({
    queryKey: inviteKey(accountId, messageId),
    queryFn: () => gmailApi.getCalendarInvite(accountId, messageId),
    staleTime: 60_000,
  });
  const invite = query.data;

  const respond = useMutation({
    mutationFn: (response: RsvpResponse) =>
      gmailApi.respondToInvite(accountId, messageId, response),
    onMutate: async (response) => {
      // Optimistic: the chosen answer shows at once.
      await qc.cancelQueries({ queryKey: inviteKey(accountId, messageId) });
      const previous = qc.getQueryData<CalendarInvite | null>(inviteKey(accountId, messageId));
      if (previous) qc.setQueryData(inviteKey(accountId, messageId), { ...previous, response });
      return { previous };
    },
    onSuccess: (next, response) => {
      if (next) qc.setQueryData(inviteKey(accountId, messageId), next);
      toast.success(
        next?.calendarAccess === false
          ? `${DONE[response]} — reply sent to the organizer`
          : `${DONE[response]}`,
      );
    },
    onError: (error, _response, context) => {
      if (context?.previous) qc.setQueryData(inviteKey(accountId, messageId), context.previous);
      toast.error(
        `Couldn't send your answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  // Google's own Yes / No / Maybe links in the body answer here.
  useEffect(() => {
    const onRequest = (id: string, response: RsvpResponse) => {
      if (id === messageId && !respond.isPending) respond.mutate(response);
    };
    listeners.add(onRequest);
    return () => {
      listeners.delete(onRequest);
    };
  }, [messageId, respond]);

  if (!invite || invite.method === "REPLY") return null;
  const when = formatWhen(invite);
  const answered = invite.response !== "needsAction" ? invite.response : null;

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-border/60 bg-card p-3">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-surface">
          <CalendarIcon className="size-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "text-sm font-medium text-foreground",
              invite.cancelled && "line-through",
            )}
          >
            {invite.summary}
          </div>
          {when ? <div className="text-[13px] text-muted-foreground">{when}</div> : null}
          {invite.location ? (
            <div className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground">
              <MapPinIcon className="size-3 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{invite.location}</span>
            </div>
          ) : null}
          {invite.organizer ? (
            <div className="text-[13px] text-muted-foreground">
              Organizer: {invite.organizer.name || invite.organizer.email}
            </div>
          ) : null}
        </div>
        {invite.htmlLink ? (
          <HintTooltip label="Open in Google Calendar">
            <IconBtn
              label="Open in Google Calendar"
              onClick={(e) => openLink(invite.htmlLink!, { flip: isModClick(e) })}
            >
              <ExternalLinkIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
        ) : null}
      </div>
      {invite.cancelled ? (
        <div className="pl-13 text-sm text-muted-foreground">This event was cancelled.</div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 pl-13">
          <span className="text-sm text-muted-foreground">
            {answered ? DONE[answered] : "Going?"}
          </span>
          <div className="inline-flex overflow-hidden rounded-full border border-border/60">
            {CHOICES.map((choice, i) => {
              const active = invite.response === choice.value;
              return (
                <button
                  key={choice.value}
                  type="button"
                  disabled={respond.isPending}
                  aria-pressed={active}
                  onClick={() => !active && respond.mutate(choice.value)}
                  className={cn(
                    "inline-flex h-7 cursor-pointer items-center gap-1 px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring disabled:opacity-60",
                    i > 0 && "border-l border-border/60",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground hover:bg-accent-surface",
                  )}
                >
                  {active ? <CheckIcon className="size-3" /> : null}
                  {choice.label}
                </button>
              );
            })}
          </div>
          {!invite.calendarAccess ? (
            <span className="text-xs text-muted-foreground">
              {calendar
                ? "Answers are emailed to the organizer — re-add this account to update your calendar too."
                : "Answers are emailed to the organizer."}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
