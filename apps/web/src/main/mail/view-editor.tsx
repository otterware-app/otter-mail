import { useMemo, useState, type ReactNode } from "react";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Text } from "~/components/ui/text";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./menu";
import { BanIcon, PlusIcon, XIcon } from "lucide-react";
import { LabelChip } from "./label-chip";
import { cn } from "./ui";
import { ViewIconPicker, ViewMark } from "./view-icon";
import { useAllAccountLabels, useCombinedCounts } from "./hooks";
import { defaultRulesFor } from "./custom-views";
import { getAccountColor, getAccountDisplayName } from "./account-style";
import { SYSTEM_LABEL_NAMES, SYSTEM_LABEL_ORDER, labelDisplayName } from "./label-names";
import type { GmailAccount, GmailLabel, MailView, ViewRule } from "./types";

/**
 * Making a view, or changing one, in a dialog over the mail (Smart
 * Mailbox-style): its mark and name, then each mailbox's "Must have" / "Must
 * not have" labels, added from a menu. A view is a space in the sidebar: its list.
 */
type ViewEditorProps = {
  /** The view being edited; null when making one. */
  view: MailView | null;
  accounts: GmailAccount[];
  onSave: (input: {
    id?: string;
    name: string;
    rules: ViewRule[];
    icon: string | null;
    color: string | null;
  }) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onReset: (id: string) => Promise<unknown>;
  onClose: () => void;
};

type AccountPicks = { allOf: string[]; noneOf: string[] };
type Picks = Record<string, AccountPicks>;

function rulesToPicks(rules: ViewRule[]): Picks {
  const picks: Picks = {};
  for (const rule of rules)
    picks[rule.accountId] = { allOf: [...rule.allOf], noneOf: [...rule.noneOf] };
  return picks;
}

function picksToRules(picks: Picks): ViewRule[] {
  return Object.entries(picks)
    .filter(([, p]) => p.allOf.length > 0 || p.noneOf.length > 0)
    .map(([accountId, p]) => ({ accountId, allOf: p.allOf, noneOf: p.noneOf }));
}

function sortSystemLabels(labels: GmailLabel[]): GmailLabel[] {
  return labels
    .filter((l) => l.type === "system")
    .sort((a, b) => {
      const ai = SYSTEM_LABEL_ORDER.indexOf(a.id);
      const bi = SYSTEM_LABEL_ORDER.indexOf(b.id);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
}

function chipName(label: GmailLabel | undefined, labelId: string): string {
  if (!label) return SYSTEM_LABEL_NAMES[labelId] ?? labelId;
  const display = labelDisplayName(label);
  return label.type === "user" ? (display.split("/").pop() ?? display) : display;
}

const EXCLUDED_CHIP =
  "group relative inline-flex h-4.5 w-fit max-w-40 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-dashed border-destructive/50 px-1 text-2xs font-medium leading-none text-destructive-foreground";

function RuleChip({
  label,
  labelId,
  excluded,
  onRemove,
}: {
  label: GmailLabel | undefined;
  labelId: string;
  excluded?: boolean;
  onRemove: () => void;
}) {
  const name = chipName(label, labelId);
  if (!excluded) {
    return <LabelChip label={label ?? { id: labelId, name, type: "system" }} onRemove={onRemove} />;
  }
  return (
    <span className={EXCLUDED_CHIP}>
      <BanIcon className="size-2.5" />
      <span className="min-w-0 truncate">{name}</span>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
        className="cursor-pointer opacity-60 hover:opacity-100"
      >
        <XIcon className="size-2.5" />
      </button>
    </span>
  );
}

function AddLabelMenu({
  labels,
  usedIds,
  onPick,
}: {
  labels: GmailLabel[];
  usedIds: Set<string>;
  onPick: (labelId: string) => void;
}) {
  const user = labels.filter((l) => l.type === "user" && !usedIds.has(l.id));
  const system = sortSystemLabels(labels).filter((l) => !usedIds.has(l.id));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Add label"
          className="inline-flex h-4.5 cursor-pointer items-center gap-0.5 rounded-sm border border-dashed border-input px-1 text-2xs font-medium leading-none text-muted-foreground outline-none hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <PlusIcon className="size-2.5" />
          Label
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80">
        {user.length > 0 ? <DropdownMenuLabel>Labels</DropdownMenuLabel> : null}
        {user.map((label) => (
          <DropdownMenuItem key={label.id} onSelect={() => onPick(label.id)}>
            {labelDisplayName(label)}
          </DropdownMenuItem>
        ))}
        {user.length > 0 && system.length > 0 ? <DropdownMenuSeparator /> : null}
        {system.length > 0 ? <DropdownMenuLabel>Mailboxes</DropdownMenuLabel> : null}
        {system.map((label) => (
          <DropdownMenuItem key={label.id} onSelect={() => onPick(label.id)}>
            {labelDisplayName(label)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A word of the expression ("in", "with", "or"): quiet, so the chips read as its terms. */
function Word({ children }: { children: ReactNode }) {
  return <span className="text-[13px] text-muted-foreground">{children}</span>;
}

/** One mailbox's clause: in it, with these labels, without those. */
function Clause({
  account,
  picks,
  labels,
  loading,
  onChange,
  onRemove,
}: {
  account: GmailAccount;
  picks: AccountPicks;
  labels: GmailLabel[];
  loading: boolean;
  onChange: (picks: AccountPicks) => void;
  onRemove: () => void;
}) {
  const byId = new Map(labels.map((l) => [l.id, l]));
  const used = new Set([...picks.allOf, ...picks.noneOf]);
  const terms = (key: "allOf" | "noneOf") =>
    picks[key].map((id) => (
      <RuleChip
        key={id}
        label={byId.get(id)}
        labelId={id}
        excluded={key === "noneOf"}
        onRemove={() => onChange({ ...picks, [key]: picks[key].filter((x) => x !== id) })}
      />
    ));
  return (
    <div className="group/clause flex items-start gap-2 rounded-lg px-3 py-2.5 hover:bg-accent-surface/40">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1.5">
        <Word>in</Word>
        <span className="inline-flex h-5 items-center gap-1.5 rounded-md bg-accent-surface px-1.5 text-[13px] text-foreground">
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: getAccountColor(account) }}
          />
          {getAccountDisplayName(account)}
        </span>
        {loading && labels.length === 0 ? (
          <Word>loading labels…</Word>
        ) : (
          <>
            <Word>with</Word>
            {terms("allOf")}
            {picks.allOf.length === 0 ? <Word>any label</Word> : null}
            <AddLabelMenu
              labels={labels}
              usedIds={used}
              onPick={(id) => onChange({ ...picks, allOf: [...picks.allOf, id] })}
            />
            <Word>without</Word>
            {terms("noneOf")}
            <AddLabelMenu
              labels={labels}
              usedIds={used}
              onPick={(id) => onChange({ ...picks, noneOf: [...picks.noneOf, id] })}
            />
          </>
        )}
      </div>
      <button
        type="button"
        aria-label={`Remove ${getAccountDisplayName(account)}`}
        onClick={onRemove}
        className="mt-0.5 rounded-md p-0.5 text-muted-foreground opacity-0 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/clause:opacity-100"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** The view in words: "Receipts in Personal, or Finance and not Unread in Work". */
function sentence(
  picks: Picks,
  accounts: GmailAccount[],
  labelsOf: (accountId: string) => GmailLabel[],
): string {
  return Object.entries(picks)
    .filter(([, p]) => p.allOf.length + p.noneOf.length > 0)
    .flatMap(([accountId, p]) => {
      const account = accounts.find((a) => a.id === accountId);
      if (!account) return [];
      const name = (id: string) =>
        chipName(
          labelsOf(accountId).find((l) => l.id === id),
          id,
        );
      const has = p.allOf.map(name).join(" and ") || "All mail";
      const not = p.noneOf.length ? ` and not ${p.noneOf.map(name).join(" or ")}` : "";
      return [`${has}${not} in ${getAccountDisplayName(account)}`];
    })
    .join(", or ");
}

/** The editor, open while `open`; mount it with a `key` per view (its fields start from it). */
export function ViewEditorDialog({
  open,
  view,
  accounts,
  onSave,
  onDelete,
  onReset,
  onClose,
}: ViewEditorProps & { open: boolean }) {
  const accountLabels = useAllAccountLabels(
    accounts.map((a) => a.id),
    open,
  );
  const anyLoading = accountLabels.some((a) => a.isLoading);

  const [name, setName] = useState(view?.name ?? "");
  const [mark, setMark] = useState({ icon: view?.icon ?? null, color: view?.color ?? null });
  const [picking, setPicking] = useState(false);
  const [picks, setPicks] = useState<Picks>(() =>
    view == null
      ? accounts[0]
        ? { [accounts[0].id]: { allOf: [], noneOf: [] } }
        : {}
      : rulesToPicks(view.rules ?? defaultRulesFor(view.kind, accounts)),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isDefault = view != null && view.kind !== "custom";

  const labelsOf = (accountId: string) =>
    accountLabels.find((a) => a.accountId === accountId)?.labels ?? [];
  // The mailboxes it draws on, in order, and those it could add.
  const clauses = Object.keys(picks).flatMap((id) => accounts.filter((a) => a.id === id));
  const others = accounts.filter((a) => !(a.id in picks));

  const rules = useMemo(() => picksToRules(picks), [picks]);
  const draftCounts = useCombinedCounts(rules, `draft:${view?.id ?? "new"}`, open);

  const canSave = name.trim().length > 0 && rules.length > 0;
  // Mutations are optimistic: it closes at once; an error rolls back, with a toast.
  const save = () => void onSave({ id: view?.id, name: name.trim(), rules, ...mark });

  const matchLine = draftCounts.data
    ? `${draftCounts.data.total.toLocaleString()} message${draftCounts.data.total === 1 ? "" : "s"}${
        draftCounts.data.unread > 0 ? `, ${draftCounts.data.unread.toLocaleString()} unread` : ""
      }`
    : "Counting…";

  return (
    <>
      <Dialog
        open={open && !confirmDelete}
        onOpenChange={(next) => {
          if (!next && !confirmDelete) onClose();
        }}
        size="xl"
        title={view ? `Edit “${view.name}”` : "New view"}
        description={
          isDefault
            ? "A folder of All mailboxes."
            : "Mail from your mailboxes, by their labels: one list, in the sidebar's Views."
        }
        confirmLabel={view ? "Save" : "Create view"}
        confirmDisabled={!canSave}
        onConfirm={save}
        destructiveAction={
          view && view.kind === "custom"
            ? { label: "Delete view", onClick: () => setConfirmDelete(true) }
            : undefined
        }
        secondaryAction={
          view && isDefault
            ? {
                label: "Reset to default",
                onClick: async () => {
                  await onReset(view.id);
                  onClose();
                },
              }
            : undefined
        }
      >
        <Field label="Name" orientation="vertical">
          <div className="flex items-center gap-2">
            {isDefault ? null : (
              <button
                type="button"
                aria-label="Choose an icon"
                aria-expanded={picking}
                onClick={() => setPicking((open) => !open)}
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg border border-input outline-none hover:bg-accent-surface focus-visible:ring-2 focus-visible:ring-focus-ring",
                  picking && "bg-accent-surface",
                )}
              >
                <ViewMark view={{ name: name || "?", ...mark }} />
              </button>
            )}
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Action Required"
              autoFocus={view == null}
            />
          </div>
        </Field>
        {picking ? <ViewIconPicker icon={mark.icon} color={mark.color} onChange={setMark} /> : null}

        <div className="mt-1 text-[13px] font-medium text-foreground">Show conversations</div>
        {accounts.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            Add a mailbox (Settings › Mailboxes) to make a view.
          </p>
        ) : (
          <div className="rounded-xl border border-border/60 p-1">
            {clauses.map((account, index) => (
              <div key={account.id}>
                {index > 0 ? (
                  <div className="flex items-center gap-2 px-3 py-0.5">
                    <span className="h-px flex-1 bg-border/60" />
                    <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      or
                    </span>
                    <span className="h-px flex-1 bg-border/60" />
                  </div>
                ) : null}
                <Clause
                  account={account}
                  picks={picks[account.id]}
                  labels={labelsOf(account.id)}
                  loading={anyLoading}
                  onChange={(next) => setPicks((prev) => ({ ...prev, [account.id]: next }))}
                  onRemove={() =>
                    setPicks((prev) =>
                      Object.fromEntries(Object.entries(prev).filter(([id]) => id !== account.id)),
                    )
                  }
                />
              </div>
            ))}
            {others.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="m-1 inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground outline-none hover:bg-accent-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <PlusIcon className="size-3.5" />
                    {clauses.length > 0 ? "Or in another mailbox" : "In a mailbox"}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {others.map((account) => (
                    <DropdownMenuItem
                      key={account.id}
                      icon={
                        <span className="flex size-4 items-center justify-center">
                          <span
                            className="size-2 rounded-full"
                            style={{ backgroundColor: getAccountColor(account) }}
                          />
                        </span>
                      }
                      onSelect={() =>
                        setPicks((prev) => ({ ...prev, [account.id]: { allOf: [], noneOf: [] } }))
                      }
                    >
                      {getAccountDisplayName(account)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        )}
        {/* The whole expression in words, and what it finds now. */}
        <p className="text-[13px] leading-5 text-muted-foreground">
          {rules.length === 0 ? (
            "Pick a label to have, or not have, in a mailbox."
          ) : (
            <>
              <span className="text-foreground">{sentence(picks, accounts, labelsOf)}</span>
              {` · ${matchLine}`}
            </>
          )}
        </p>
      </Dialog>

      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${view?.name ?? ""}”?`}
        confirmLabel="Delete view"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (view) await onDelete(view.id);
          setConfirmDelete(false);
          onClose();
        }}
      >
        <Text variant="small">
          The view leaves the sidebar. Your mail and labels aren't touched.
        </Text>
      </Dialog>
    </>
  );
}
