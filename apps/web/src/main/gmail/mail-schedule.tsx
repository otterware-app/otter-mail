import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClockIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { gmailApi } from "./api";
import { HintTooltip, IconBtn } from "./ui";
import { NewRow } from "./sidebar-ui";
import { toast } from "./toast";

const NOTE =
  "If this device sleeps or you close Otter Mail, scheduled sends and snoozed emails wait until the app resumes here. A suspended browser tab can also delay them.";

function localTime(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function tomorrowMorning(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

export function TimePicker({
  title,
  disabled,
  onChoose,
}: {
  title: string;
  disabled?: boolean;
  onChoose: (time: number) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HintTooltip label={title}>
        <IconBtn label={title} disabled={disabled} onClick={() => setOpen(true)}>
          <ClockIcon className="size-4" />
        </IconBtn>
      </HintTooltip>
      {open && (
        <TimePickerDialog title={title} onChoose={onChoose} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function TimePickerDialog({
  title,
  onChoose,
  onClose,
}: {
  title: string;
  onChoose: (time: number) => Promise<unknown>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() => localTime(new Date(tomorrowMorning())));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choose = async (time: number) => {
    if (busy) return;
    if (!Number.isFinite(time) || time <= Date.now()) {
      setError("Choose a time in the future.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onChoose(time);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!busy && !next) onClose();
      }}
    >
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            <strong className="font-medium text-foreground">
              Keep this device awake and online with Otter Mail open.
            </strong>{" "}
            {NOTE}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 pb-6">
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void choose(Date.now() + 3_600_000)}>
              In one hour
            </Button>
            <Button disabled={busy} onClick={() => void choose(tomorrowMorning())}>
              Tomorrow at 9 AM
            </Button>
          </div>
          <label className="block space-y-2 text-sm">
            Pick a date and time
            <input
              aria-label="Date and time"
              type="datetime-local"
              value={value}
              min={localTime(new Date())}
              onChange={(e) => setValue(e.target.value)}
              className="block w-full rounded-lg border border-border bg-transparent p-2 text-foreground"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {new Intl.DateTimeFormat().resolvedOptions().timeZone}
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          )}
          <Button
            variant="accent"
            disabled={busy || !value}
            onClick={() => void choose(new Date(value).getTime())}
          >
            {busy ? "Saving…" : title}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

async function snooze(accountId: string, threadId: string, time: number): Promise<void> {
  await gmailApi.snoozeThread(accountId, threadId, time);
  toast.success("Snoozed", {
    description: `Returns to your inbox ${new Date(time).toLocaleString()}.`,
  });
}

type SnoozeProps = { accountId: string; threadId: string; onDone?: () => void };

export function SnoozeButton({ accountId, threadId, onDone }: SnoozeProps) {
  return (
    <TimePicker
      title="Snooze"
      onChoose={async (time) => {
        await snooze(accountId, threadId, time);
        onDone?.();
      }}
    />
  );
}

export function SnoozeDialog({
  accountId,
  threadId,
  onDone,
  onClose,
}: SnoozeProps & { onClose: () => void }) {
  return (
    <TimePickerDialog
      title="Snooze"
      onClose={onClose}
      onChoose={async (time) => {
        await snooze(accountId, threadId, time);
        onDone?.();
      }}
    />
  );
}

export function ScheduledMailButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["gmail:schedules"],
    queryFn: gmailApi.listSchedules,
    refetchInterval: 15_000,
  });
  useEffect(
    () =>
      window.desktopBridge.on("gmail:schedule-changed", () => {
        void qc.invalidateQueries({ queryKey: ["gmail:schedules"] });
      }),
    [qc],
  );
  const entries = query.data ?? [];
  return (
    <>
      {entries.length > 0 && (
        <NewRow
          icon={<ClockIcon />}
          label={`Scheduled & snoozed (${entries.length})`}
          onClick={() => setOpen(true)}
        />
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Scheduled & snoozed</DialogTitle>
            <DialogDescription>
              <strong className="font-medium text-foreground">
                Keep this device awake and online with Otter Mail open.
              </strong>{" "}
              {NOTE}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 overflow-y-auto px-6 pb-6">
            {query.isLoading && <p className="text-sm">Loading…</p>}
            {query.isError && <p role="alert">Couldn’t load scheduled mail.</p>}
            {!query.isLoading && !query.isError && !entries.length && (
              <p className="text-sm text-muted-foreground">
                No scheduled sends or snoozed conversations.
              </p>
            )}
            {entries.map((entry) => (
              <div key={entry.id} className="space-y-2 rounded-xl border border-border p-3">
                <p className="truncate text-sm font-medium">{entry.subject || "(no subject)"}</p>
                <p className="text-xs text-muted-foreground">
                  {entry.accountId} · {entry.kind === "send" ? "Send" : "Return to inbox"}{" "}
                  {new Date(entry.dueAt).toLocaleString()}
                </p>
                {entry.state === "failed" && (
                  <p role="alert" className="text-sm text-destructive-foreground">
                    {entry.error}{" "}
                    {entry.kind === "send"
                      ? "Check Sent before sending again."
                      : "Return it to the inbox to recover."}
                  </p>
                )}
                <Button
                  size="small"
                  disabled={busy !== null || entry.state === "running"}
                  onClick={() => {
                    setBusy(entry.id);
                    void gmailApi
                      .cancelSchedule(entry.id)
                      .then(
                        () =>
                          toast.success(
                            entry.kind === "send"
                              ? "Schedule cancelled — restored to Drafts"
                              : "Returned to Inbox",
                          ),
                        (error) => toast.error(String(error)),
                      )
                      .finally(() => {
                        setBusy(null);
                        void query.refetch();
                      });
                  }}
                >
                  {busy === entry.id || entry.state === "running"
                    ? "Working…"
                    : entry.kind === "send"
                      ? "Cancel & move to Drafts"
                      : "Return to Inbox"}
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
