import type { TodoistPage, TodoistTask } from "@otter-mail/contracts/todoist";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { CheckIcon, ExternalLinkIcon, RefreshCwIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../mail/select";
import { todoistApi } from "./api";
import { Btn, IconBtn } from "../../mail/ui";
import { toast } from "../../mail/toast";

export function useTodoistStatus() {
  return useQuery({ queryKey: ["todoist", "status"], queryFn: todoistApi.todoistStatus });
}

function useTodoistProjects(enabled: boolean) {
  return useQuery({
    queryKey: ["todoist", "projects"],
    queryFn: todoistApi.todoistProjects,
    enabled,
    retry: false,
  });
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const taskUrl = (id: string) => `https://app.todoist.com/app/task/${encodeURIComponent(id)}`;

type EmailTask = { accountId: string; messageId: string; subject: string };
type Request =
  | { kind: "browse" }
  | { kind: "create"; email?: EmailTask }
  | { kind: "edit"; task: TodoistTask };
const listeners = new Set<(request: Request) => void>();
export function browseTodoist(): void {
  for (const listener of listeners) listener({ kind: "browse" });
}
export function addEmailToTodoist(email: EmailTask): void {
  for (const listener of listeners) listener({ kind: "create", email });
}

/** Mounted once so menu actions work from both the list and reader. */
export function TodoistDialogs() {
  const [request, setRequest] = useState<Request | null>(null);
  const qc = useQueryClient();
  useEffect(() => {
    listeners.add(setRequest);
    const off = window.desktopBridge.on("todoist:changed", () => {
      setRequest(null);
      void qc.resetQueries({ queryKey: ["todoist"] });
    });
    const offTasks = window.desktopBridge.on("todoist:tasksChanged", (payload: unknown) => {
      const completedId = (payload as { completedId?: string } | undefined)?.completedId;
      if (completedId)
        qc.setQueriesData<InfiniteData<TodoistPage>>({ queryKey: ["todoist", "tasks"] }, (data) =>
          data
            ? {
                ...data,
                pages: data.pages.map((page) => ({
                  ...page,
                  results: page.results.filter((task) => task.id !== completedId),
                })),
              }
            : data,
        );
      void qc.invalidateQueries({ queryKey: ["todoist", "tasks"] });
    });
    return () => {
      listeners.delete(setRequest);
      off();
      offTasks();
    };
  }, [qc]);
  if (!request) return null;
  return request.kind === "browse" ? (
    <TodoistBrowser
      onClose={() => setRequest(null)}
      onCreate={() => setRequest({ kind: "create" })}
      onEdit={(task) => setRequest({ kind: "edit", task })}
    />
  ) : (
    <TodoistCreate
      email={request.kind === "create" ? request.email : undefined}
      task={request.kind === "edit" ? request.task : undefined}
      onOpenSettings={() => setRequest(null)}
      onClose={() => setRequest({ kind: "browse" })}
    />
  );
}

function ConnectTodoist({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="flex items-center justify-between gap-3">
      <p>Connect your Todoist account to get started.</p>
      <Btn
        size="sm"
        onClick={() => {
          onClose();
          void navigate({ to: "/settings/$pane", params: { pane: "integrations" } });
        }}
      >
        Open settings
      </Btn>
    </div>
  );
}

function ProjectSelect({
  value,
  onChange,
  projects,
  all = false,
  defaultInbox = true,
}: {
  value: string;
  onChange: (value: string) => void;
  projects: { id: string; name: string }[];
  all?: boolean;
  defaultInbox?: boolean;
}) {
  return (
    <Select
      value={value || "__default__"}
      onValueChange={(next) => onChange(next === "__default__" ? "" : next)}
    >
      <SelectTrigger aria-label="Todoist project">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {all || defaultInbox ? (
          <SelectItem value="__default__">{all ? "All projects" : "Inbox (default)"}</SelectItem>
        ) : null}
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TodoistCreate({
  email,
  task,
  onClose,
  onOpenSettings,
}: {
  email?: EmailTask;
  task?: TodoistTask;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const status = useTodoistStatus();
  const projects = useTodoistProjects(status.data?.connected === true);
  const [content, setContent] = useState(task?.content ?? email?.subject.slice(0, 500) ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [project, setProject] = useState(task?.project_id ?? "");
  const [due, setDue] = useState(task?.due?.string || task?.due?.date || "");
  const [priority, setPriority] = useState(String(task?.priority ?? 1));
  const [section, setSection] = useState(task?.section_id ?? "");
  const [assignee, setAssignee] = useState(task?.responsible_uid ?? "");
  const [labels, setLabels] = useState((task?.labels ?? []).join(", "));
  const labelOptions = useQuery({
    queryKey: ["todoist", "labels"],
    queryFn: todoistApi.todoistLabels,
    enabled: status.data?.connected === true,
  });
  const sections = useQuery({
    queryKey: ["todoist", "sections", project],
    queryFn: () => todoistApi.todoistSections(project),
    enabled: !!project,
  });
  const collaborators = useQuery({
    queryKey: ["todoist", "collaborators", project],
    queryFn: () => todoistApi.todoistCollaborators(project),
    enabled: !!project,
  });
  const [pending, setPending] = useState(false);
  const [reminderPending, setReminderPending] = useState(false);
  const attempt = useRef<{ payload: string; id: string; moveId: string } | null>(null);
  const connected = status.data?.connected === true;
  return (
    <Dialog
      open
      title={task ? "Edit Todoist task" : email ? "Add email to Todoist" : "New Todoist task"}
      size="large"
      description={
        email
          ? "A link to this conversation will be included. Only the title, notes and link are sent to Todoist."
          : task
            ? "Update this task in Todoist. Clear the due date to remove its schedule."
            : "Create a task in your Todoist account."
      }
      onOpenChange={(open) => {
        if (!open && !pending && !reminderPending) onClose();
      }}
      confirmLabel={task ? "Save changes" : "Create task"}
      confirmDisabled={!connected || !content.trim() || pending || reminderPending}
      onConfirm={async () => {
        const input = {
          content: content.trim(),
          description,
          projectId: project || undefined,
          sectionId: section || undefined,
          assigneeId: assignee || null,
          labels: [
            ...new Set(
              labels
                .split(",")
                .map((label) => label.trim())
                .filter(Boolean),
            ),
          ],
          due: due.trim(),
          priority: Number(priority),
          email: email ? { accountId: email.accountId, messageId: email.messageId } : undefined,
        };
        const payload = JSON.stringify(input);
        if (attempt.current?.payload !== payload)
          attempt.current = { payload, id: crypto.randomUUID(), moveId: crypto.randomUUID() };
        setPending(true);
        try {
          if (task) {
            await todoistApi.updateTodoistTask({
              ...input,
              id: task.id,
              requestId: attempt.current.id,
              moveRequestId: attempt.current.moveId,
              // Do not move unchanged tasks: moving can detach subtasks from their parent.
              projectId:
                project !== task.project_id || section !== (task.section_id ?? "")
                  ? project
                  : undefined,
              sectionId:
                project !== task.project_id || section !== (task.section_id ?? "")
                  ? section || null
                  : undefined,
              due: due === (task.due?.string || task.due?.date || "") ? undefined : due.trim(),
            });
          } else await todoistApi.createTodoistTask({ ...input, requestId: attempt.current.id });
          toast.success(task ? "Task updated in Todoist" : "Task created in Todoist", {
            action: { label: "View tasks", onClick: browseTodoist },
          });
        } catch (error) {
          toast.error(errorText(error));
          throw error;
        } finally {
          setPending(false);
        }
      }}
    >
      {status.isError ? (
        <p role="alert">{errorText(status.error)}</p>
      ) : !status.data ? (
        <p>Loading Todoist…</p>
      ) : !connected ? (
        <ConnectTodoist onClose={onOpenSettings} />
      ) : null}
      <fieldset disabled={pending || !connected} className="flex flex-col gap-3">
        <Field label="Title" orientation="vertical">
          <Input
            value={content}
            maxLength={500}
            onChange={(e) => setContent(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Notes" orientation="vertical">
          <textarea
            aria-label="Notes"
            className="min-h-24 rounded-md border border-input bg-transparent p-2"
            value={description}
            maxLength={12000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="Project" orientation="vertical">
          <ProjectSelect
            value={project}
            defaultInbox={!task}
            onChange={(value) => {
              setProject(value);
              setSection("");
              setAssignee("");
            }}
            projects={projects.data ?? []}
          />
        </Field>
        {projects.isLoading ? <p className="text-muted-foreground">Loading projects…</p> : null}
        {projects.isError ? (
          <p role="alert">
            {errorText(projects.error)}{" "}
            <button type="button" className="underline" onClick={() => void projects.refetch()}>
              Retry
            </button>
          </p>
        ) : null}
        {project ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Section" orientation="vertical">
              <Choice
                label="Section"
                value={section}
                onChange={setSection}
                empty="No section"
                options={(sections.data ?? []).map((s) => ({ id: s.id, name: s.name }))}
              />
            </Field>
            <Field label="Assignee" orientation="vertical">
              <Choice
                label="Assignee"
                value={assignee}
                onChange={setAssignee}
                empty="Unassigned"
                options={(collaborators.data ?? []).map((c) => ({
                  id: c.id,
                  name: c.name || c.email,
                }))}
              />
            </Field>
            {sections.isError || collaborators.isError ? (
              <p role="alert">{errorText(sections.error || collaborators.error)}</p>
            ) : null}
          </div>
        ) : null}
        <Field label="Labels" orientation="vertical">
          <Input
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="Separate labels with commas"
          />
          <div className="flex flex-wrap gap-2">
            {labelOptions.data
              ?.filter(
                (l) =>
                  !labels
                    .split(",")
                    .map((v) => v.trim())
                    .includes(l.name),
              )
              .map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className="rounded bg-muted px-2 py-1 text-xs"
                  onClick={() => setLabels(labels ? `${labels}, ${l.name}` : l.name)}
                >
                  + {l.name}
                </button>
              ))}
          </div>
          {labelOptions.isError ? <p role="alert">{errorText(labelOptions.error)}</p> : null}
        </Field>
        <Field label="Due date" orientation="vertical">
          <Input
            value={due}
            maxLength={200}
            onChange={(e) => setDue(e.target.value)}
            placeholder="e.g. tomorrow at 3pm or every Monday"
          />
        </Field>
        <Field label="Priority" orientation="vertical">
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger aria-label="Priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="4">Priority 1 · Urgent</SelectItem>
              <SelectItem value="3">Priority 2 · High</SelectItem>
              <SelectItem value="2">Priority 3 · Medium</SelectItem>
              <SelectItem value="1">Priority 4 · Normal</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </fieldset>
      {task ? (
        <Reminders
          taskId={task.id}
          disabled={pending}
          pending={reminderPending}
          setPending={setReminderPending}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          After creating a task, open Edit to add reminders.
        </p>
      )}
    </Dialog>
  );
}

function TodoistBrowser({
  onClose,
  onCreate,
  onEdit,
}: {
  onClose: () => void;
  onCreate: () => void;
  onEdit: (task: TodoistTask) => void;
}) {
  const status = useTodoistStatus();
  const connected = status.data?.connected === true;
  const projects = useTodoistProjects(connected);
  const [project, setProject] = useState("");
  const [view, setView] = useState("all");
  const [filterText, setFilterText] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const filter =
    view === "today"
      ? "today | overdue"
      : view === "upcoming"
        ? "7 days"
        : view === "filter"
          ? appliedFilter
          : "";
  const [completing, setCompleting] = useState<string | null>(null);
  const requestIds = useRef(new Map<string, string>());
  const tasks = useInfiniteQuery({
    queryKey: ["todoist", "tasks", view === "all" ? project : "", filter],
    queryFn: ({ pageParam }) =>
      todoistApi.todoistTasks(
        view === "all" ? project || undefined : undefined,
        pageParam,
        filter || undefined,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: connected && (view !== "filter" || !!filter),
    retry: false,
  });
  const rows = tasks.data?.pages.flatMap((p) => p.results) ?? [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !completing) onClose();
      }}
      title="Todoist"
      description="Your active tasks. Completing a recurring task schedules its next occurrence."
      size="xl"
    >
      <div className="flex items-center gap-2">
        <Choice
          label="Task view"
          value={view === "all" ? "" : view}
          onChange={(v) => setView(v || "all")}
          empty="All tasks"
          options={[
            { id: "today", name: "Today & overdue" },
            { id: "upcoming", name: "Upcoming · 7 days" },
            { id: "filter", name: "Search & filters" },
          ]}
        />
        {view === "all" ? (
          <ProjectSelect value={project} onChange={setProject} projects={projects.data ?? []} all />
        ) : null}
        <IconBtn
          label="Refresh Todoist"
          disabled={tasks.isFetching || projects.isFetching}
          onClick={() => {
            void tasks.refetch();
            void projects.refetch();
          }}
        >
          <RefreshCwIcon className="size-4" />
        </IconBtn>
        <Btn
          size="sm"
          variant="primary"
          disabled={!connected || completing !== null}
          onClick={onCreate}
        >
          New task
        </Btn>
      </div>
      {view === "filter" ? (
        <form
          className="flex gap-2"
          onKeyDown={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedFilter(filterText.trim());
          }}
        >
          <Input
            aria-label="Todoist search or filter"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            maxLength={1024}
            placeholder="search: proposal, or p1 & @work"
          />
          <Btn type="submit" disabled={!filterText.trim()}>
            Apply
          </Btn>
        </form>
      ) : null}
      {view === "filter" ? (
        <p className="text-xs text-muted-foreground">
          Use search: followed by words, or a{" "}
          <a
            className="underline"
            href="https://todoist.com/help/articles/introduction-to-filters-V98wIH"
            target="_blank"
            rel="noreferrer"
          >
            Todoist filter
          </a>{" "}
          such as today & p1. One filter at a time.
        </p>
      ) : null}
      {status.isError ? (
        <p role="alert">{errorText(status.error)}</p>
      ) : !status.data ? (
        <p>Loading Todoist…</p>
      ) : !connected ? (
        <ConnectTodoist onClose={onClose} />
      ) : null}
      {projects.isError ? <p role="alert">{errorText(projects.error)}</p> : null}
      {tasks.isError ? (
        <p role="alert">
          {errorText(tasks.error)}{" "}
          <button className="underline" onClick={() => void tasks.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {connected && tasks.isFetching && tasks.isPending ? <p>Loading tasks…</p> : null}
      {connected && tasks.isSuccess && rows.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">
          No active tasks{project ? " in this project" : ""}.
        </p>
      ) : null}
      <ul className="divide-y divide-border">
        {rows.map((task) => (
          <li key={task.id} className="flex items-start gap-3 py-3">
            <IconBtn
              label={`Complete ${task.content}`}
              disabled={completing !== null}
              onClick={() => {
                setCompleting(task.id);
                const id = requestIds.current.get(task.id) ?? crypto.randomUUID();
                requestIds.current.set(task.id, id);
                void todoistApi
                  .completeTodoistTask(task.id, id)
                  .then(() => {
                    requestIds.current.delete(task.id);
                    toast.success(
                      task.due?.is_recurring
                        ? "Task completed; next occurrence scheduled"
                        : "Task completed",
                    );
                  })
                  .catch((error: unknown) => toast.error(errorText(error)))
                  .finally(() => setCompleting(null));
              }}
            >
              <CheckIcon className="size-4" />
            </IconBtn>
            <div className="min-w-0 flex-1">
              <a
                href={taskUrl(task.id)}
                target="_blank"
                rel="noreferrer"
                className="break-words hover:underline"
              >
                {task.content} <ExternalLinkIcon className="inline size-3 text-muted-foreground" />
              </a>
              <p className="text-xs text-muted-foreground">
                {projects.data?.find((p) => p.id === task.project_id)?.name ?? ""}
                {task.due ? ` · ${task.due.string || task.due.date} (${task.due.date})` : ""}
                {task.priority > 1 ? ` · Priority ${5 - task.priority}` : ""}
                {task.labels?.length ? ` · ${task.labels.map((l) => `@${l}`).join(" ")}` : ""}
              </p>
              {task.description ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground line-clamp-3">
                  <TaskNotes text={task.description} />
                </p>
              ) : null}
            </div>
            <IconBtn
              label={`Edit ${task.content}`}
              disabled={completing !== null}
              onClick={() => onEdit(task)}
            >
              <PencilIcon className="size-4" />
            </IconBtn>
          </li>
        ))}
      </ul>
      {tasks.hasNextPage ? (
        <Btn disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>
          {tasks.isFetchingNextPage ? "Loading…" : "Load more"}
        </Btn>
      ) : null}
    </Dialog>
  );
}

function Choice({
  label,
  value,
  onChange,
  empty,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  empty: string;
  options: { id: string; name: string }[];
}) {
  return (
    <Select
      value={value || "__empty__"}
      onValueChange={(v) => onChange(v === "__empty__" ? "" : v)}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__empty__">{empty}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function TaskNotes({ text }: { text: string }) {
  const matches = [...text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)];
  let offset = 0;
  const parts = matches.flatMap((match) => {
    const prefix = text.slice(offset, match.index);
    offset = match.index + match[0].length;
    return [
      prefix,
      <a
        key={`link-${match.index}-${match[2]}`}
        className="underline"
        href={match[2]}
        target="_blank"
        rel="noreferrer"
      >
        {match[1]}
      </a>,
    ];
  });
  return (
    <>
      {parts}
      {text.slice(offset)}
    </>
  );
}

function Reminders({
  taskId,
  disabled,
  pending,
  setPending,
}: {
  taskId: string;
  disabled: boolean;
  pending: boolean;
  setPending: (value: boolean) => void;
}) {
  const reminders = useQuery({
    queryKey: ["todoist", "reminders", taskId],
    queryFn: () => todoistApi.todoistReminders(taskId),
    retry: false,
  });
  const [due, setDue] = useState("");
  const attempt = useRef<{ due: string; id: string } | null>(null);
  const deletes = useRef(new Map<string, string>());
  return (
    <fieldset
      onKeyDown={(e) => e.stopPropagation()}
      disabled={disabled || pending}
      className="flex flex-col gap-2 border-t pt-3"
    >
      <legend className="text-sm font-medium">Reminders</legend>
      <p className="text-xs text-muted-foreground">
        Todoist sends reminders using your notification settings. Include a time, e.g. tomorrow at
        9am. Reminder changes are saved immediately.
      </p>
      {reminders.isLoading ? <p>Loading reminders…</p> : null}
      {reminders.isError ? (
        <p role="alert">
          {errorText(reminders.error)}{" "}
          <button type="button" className="underline" onClick={() => void reminders.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {reminders.data?.map((r) => (
        <div key={r.id} className="flex items-center justify-between text-sm">
          <span>
            {r.type === "relative"
              ? `${r.minute_offset} minutes before due`
              : r.due?.string || r.due?.date || "Reminder"}
          </span>
          <IconBtn
            label="Remove reminder"
            onClick={() => {
              const id = deletes.current.get(r.id) ?? crypto.randomUUID();
              deletes.current.set(r.id, id);
              setPending(true);
              void todoistApi
                .deleteTodoistReminder(r.id, id)
                .then(() => reminders.refetch())
                .catch((e) => toast.error(errorText(e)))
                .finally(() => setPending(false));
            }}
          >
            <Trash2Icon className="size-4" />
          </IconBtn>
        </div>
      ))}
      <div className="flex gap-2">
        <Input
          aria-label="Reminder date and time"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          maxLength={200}
          placeholder="Tomorrow at 9am"
        />
        <Btn
          disabled={!due.trim() || pending}
          onClick={() => {
            if (attempt.current?.due !== due) attempt.current = { due, id: crypto.randomUUID() };
            setPending(true);
            void todoistApi
              .addTodoistReminder({ itemId: taskId, due, requestId: attempt.current.id })
              .then(async () => {
                setDue("");
                attempt.current = null;
                await reminders.refetch();
              })
              .catch((e) => toast.error(errorText(e)))
              .finally(() => setPending(false));
          }}
        >
          Add reminder
        </Btn>
      </div>
    </fieldset>
  );
}
