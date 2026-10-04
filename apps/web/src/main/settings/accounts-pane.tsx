import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Dialog } from "~/components/ui/dialog";
import { Text } from "~/components/ui/text";
import { CheckIcon, GripVerticalIcon, LayersIcon, PlusIcon, RotateCwIcon } from "lucide-react";
import { Switch } from "~/components/ui/switch";
import { arrangeAccounts, setMailboxArrangement, useMailboxArrangement } from "../mailboxes";
import { gmailApi } from "../gmail/api";
import { toast } from "../gmail/toast";
import {
  syncStatusPollMs,
  useAccounts,
  useAddAccount,
  useRemoveAccount,
  useUpdateAccount,
} from "../gmail/hooks";
import { RichTextArea, type RichTextRef } from "../gmail/rich-text";
import { AddMailboxMenu, ImapPasswordForm } from "../gmail/add-mailbox";
import { capabilitiesOf, mailServerName, signsInWithPassword } from "../gmail/capabilities";
import {
  ACCOUNT_COLOR_PALETTE,
  getAccountColor,
  getAccountDisplayName,
} from "../gmail/account-style";
import type { GmailAccount, SyncStatus } from "../gmail/types";
import { Btn, HintTooltip, cn, restoreFocusForKeyboardOnly } from "../gmail/ui";
import {
  DraftInput,
  SettingResetButton,
  SettingsGroup,
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
} from "./settings-ui";
import { searchableSetting } from "./settings-search";

/**
 * Settings › Mailboxes: the list of mailboxes (turn on or off, drag to
 * reorder), then the selected mailbox's settings (status, profile, signature,
 * removal) below it.
 */

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

type StatusLine = { text: string; tone: "muted" | "active" | "error"; detail?: string };

function syncLine(status: SyncStatus | undefined): {
  text: string;
  tone: "muted" | "active" | "error";
  detail?: string;
} {
  if (!status) return { text: "…", tone: "muted" };
  // Only a full sync reads as "Syncing": the routine check for new mail runs
  // every tick and would otherwise blink here all the time.
  if (status.syncing && (status.phase === "full" || !status.lastSyncAt)) {
    const progress =
      status.phase === "full" && status.total
        ? ` ${status.synced.toLocaleString()} of ~${status.total.toLocaleString()}`
        : "";
    return { text: `Syncing${progress}…`, tone: "active" };
  }
  if (status.error && !status.syncing) {
    return { text: "Sync failed — will retry", tone: "error", detail: status.error };
  }
  const synced = status.lastSyncAt ? `Synced ${timeAgo(status.lastSyncAt)}` : "Not synced yet";
  if (status.download) {
    const left = Math.max(0, status.download.total - status.download.done);
    return { text: `${synced} · Saving ${left.toLocaleString()} for offline`, tone: "muted" };
  }
  return { text: synced, tone: "muted" };
}

/** Read-only sync status (the main view starts syncs; settings only watches). */
function useSyncStatusOnly(accountId: string) {
  return useQuery<SyncStatus>({
    queryKey: ["gmail:syncStatus", accountId],
    queryFn: () => gmailApi.getSyncStatus(accountId),
    refetchInterval: (query) => syncStatusPollMs(query.state.data),
  });
}

function ColorPicker({
  color,
  label,
  onPick,
}: {
  color: string;
  label: string;
  onPick: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <HintTooltip label="Account color">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            className="flex size-7 cursor-pointer items-center justify-center rounded-lg outline-none hover:bg-accent-surface focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <span
              className="size-3.5 rounded-full ring-1 ring-inset ring-black/10"
              style={{ backgroundColor: color }}
            />
          </button>
        </Popover.Trigger>
      </HintTooltip>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          onCloseAutoFocus={restoreFocusForKeyboardOnly}
          className="dropdown-glass z-[130] grid grid-cols-5 gap-1.5 rounded-xl p-2.5 shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none"
        >
          {ACCOUNT_COLOR_PALETTE.map((swatch) => {
            const picked = swatch.toLowerCase() === color.toLowerCase();
            return (
              <button
                key={swatch}
                type="button"
                aria-label={`Use ${swatch}`}
                onClick={() => {
                  onPick(swatch);
                  setOpen(false);
                }}
                className="flex size-6 cursor-pointer items-center justify-center rounded-full outline-none ring-offset-2 ring-offset-popover transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-focus-ring"
                style={{ backgroundColor: swatch }}
              >
                {picked ? <CheckIcon className="size-3.5 text-white" strokeWidth={3} /> : null}
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Sync state for an account, with a signed-out account called out first. */
function accountStatus(account: GmailAccount, status: SyncStatus | undefined): StatusLine {
  // Never synced here: it was added on another device (through the Otter account).
  if (account.signedOut && status && !status.lastSyncAt) {
    return {
      text: "Not signed in on this device",
      tone: "muted",
      detail: "Added on another device. Sign in to use it here.",
    };
  }
  if (account.signedOut) {
    return {
      text: "Signed out",
      tone: "error",
      detail: "Sign in again to sync this account. Its cached mail stays.",
    };
  }
  return syncLine(status);
}

function StatusText({ status, className }: { status: StatusLine; className?: string }) {
  return (
    <span
      title={status.detail}
      className={cn(
        "flex min-w-0 items-center gap-1.5",
        status.tone === "error" && "text-destructive-foreground",
        status.tone === "active" && "text-foreground/80",
        className,
      )}
    >
      {status.tone !== "muted" ? (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status.tone === "error" ? "bg-destructive" : "bg-primary",
          )}
        />
      ) : null}
      <span className="truncate">{status.text}</span>
    </span>
  );
}

function AccountAvatar({
  account,
  size = "small",
}: {
  account: GmailAccount;
  size?: "small" | "medium";
}) {
  const displayName = getAccountDisplayName(account);
  return (
    <span className="relative shrink-0">
      <Avatar size={size}>
        {account.picture ? (
          <AvatarImage src={account.picture} alt={displayName} referrerPolicy="no-referrer" />
        ) : null}
        <AvatarFallback>{(displayName[0] ?? "?").toUpperCase()}</AvatarFallback>
      </Avatar>
      <span
        aria-hidden
        className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card"
        style={{ backgroundColor: getAccountColor(account) }}
      />
    </span>
  );
}

/**
 * Sign in again with Google (signed-out account) or add a mailbox: Gmail, or
 * other mail over IMAP. Cancellable while Google is open.
 */
function SignInButton({ email, label }: { email?: string; label: string }) {
  const signIn = useAddAccount();
  if (signIn.isPending) {
    return (
      <Btn size="sm" onClick={() => void gmailApi.cancelAddAccount()}>
        Cancel sign-in
      </Btn>
    );
  }
  const google = () =>
    void signIn.mutateAsync(email).catch((err: unknown) => {
      toast.error(email ? `Couldn't sign in to ${email}` : "Couldn't add the account", {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  if (email) {
    return (
      <Btn size="sm" variant="primary" onClick={google}>
        {label}
      </Btn>
    );
  }
  return (
    <AddMailboxMenu onGmail={google} align="end">
      <Btn size="sm" variant="outline">
        <PlusIcon className="size-3.5" />
        {label}
      </Btn>
    </AddMailboxMenu>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** Row reordering (drag the grip): where a dragged mailbox would land. */
type DropSpot = { email: string; after: boolean } | null;

function AccountListRow({
  account,
  selected,
  onSelect,
  on,
  onToggle,
  lastOn,
  dragging,
  dropSpot,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  account: GmailAccount;
  selected: boolean;
  onSelect: () => void;
  on: boolean;
  onToggle: (on: boolean) => void;
  /** The only mailbox still on: it can't be turned off. */
  lastOn: boolean;
  dragging: boolean;
  dropSpot: DropSpot;
  onDragStart: () => void;
  onDragOver: (after: boolean) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const sync = useSyncStatusOnly(account.id);
  const status = accountStatus(account, sync.data);
  const dropHere = dropSpot?.email === account.email;
  return (
    <div
      data-slot="settings-row"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        onDragOver(e.clientY > box.top + box.height / 2);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group/row relative flex min-h-[60px] items-center gap-3 px-4 py-2.5",
        selected ? "bg-foreground/[0.04]" : "hover:bg-foreground/[0.03]",
        dragging && "opacity-40",
      )}
    >
      {dropHere ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-4 h-0.5 rounded-full bg-primary",
            dropSpot.after ? "-bottom-px" : "-top-px",
          )}
        />
      ) : null}
      <button
        type="button"
        className="absolute inset-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
        onClick={onSelect}
        aria-label={`Select ${account.email}`}
        aria-pressed={selected}
      />
      {/* In the row's left padding, so the avatars line up with the text of every other row. */}
      <GripVerticalIcon
        aria-hidden
        className="pointer-events-none absolute left-0.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/0 group-hover/row:text-muted-foreground/70"
      />
      <span className={cn("pointer-events-none contents", !on && "[&>*]:opacity-50")}>
        <AccountAvatar account={account} size="medium" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">
            {getAccountDisplayName(account)}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
            <span className="min-w-0 shrink truncate">{account.email}</span>
            <span aria-hidden>·</span>
            {on ? (
              <StatusText status={status} className="shrink-0" />
            ) : (
              <span className="shrink-0">Turned off</span>
            )}
          </span>
        </span>
      </span>
      <HintTooltip label={lastOn ? "Keep at least one mailbox on" : on ? "Turn off" : "Turn on"}>
        <span className="relative z-10 flex">
          <Switch
            checked={on}
            disabled={lastOn}
            onCheckedChange={onToggle}
            aria-label={`${getAccountDisplayName(account)} on`}
          />
        </span>
      </HintTooltip>
    </div>
  );
}

/** "All mailboxes", the combined inbox: pinned first, only turned on or off. */
function AllMailboxesRow({ on, onToggle }: { on: boolean; onToggle: (on: boolean) => void }) {
  return (
    <SettingsSearchTarget
      id={searchableSetting("all-mailboxes").id}
      data-slot="settings-row"
      className="flex min-h-[60px] items-center gap-3 px-4 py-2.5"
    >
      <span className={cn("contents", !on && "[&>*]:opacity-50")}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground">
          <LayersIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">All mailboxes</span>
          <span className="block truncate text-[13px] leading-[18px] text-muted-foreground">
            One inbox for every mailbox
          </span>
        </span>
      </span>
      <Switch checked={on} onCheckedChange={onToggle} aria-label="All mailboxes on" />
    </SettingsSearchTarget>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** The editor's signature: empty when it holds neither text nor an image. */
function editedSignature(editor: RichTextRef): string {
  const html = editor.getHTML();
  return editor.getText().trim() || /<img\b/i.test(html) ? html : "";
}

function AccountEditor({ account }: { account: GmailAccount }) {
  const updateAccount = useUpdateAccount();
  const removeAccount = useRemoveAccount();
  const signIn = useAddAccount();
  const sync = useSyncStatusOnly(account.id);
  const displayName = getAccountDisplayName(account);
  const status = accountStatus(account, sync.data);
  const capabilities = capabilitiesOf(account);
  const signatureRef = useRef<RichTextRef>(null);
  // Gmail's signature as loaded into the editor. A newer one from Gmail replaces it only while
  // the editor holds no unsaved edits (compared with what the editor showed once loaded).
  const [shown, setShown] = useState(account.signature ?? "");
  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    loadedRef.current = signatureRef.current ? editedSignature(signatureRef.current) : null;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-run this DOM/reset lifecycle when its explicit trigger changes, even when the callback reads refs.
  }, [shown]);
  useEffect(() => {
    const next = account.signature ?? "";
    const editor = signatureRef.current;
    if (next === shown) return;
    if (!editor || editedSignature(editor) === loadedRef.current) setShown(next);
  }, [account.signature, shown]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const syncNow = () => {
    setSyncing(true);
    void gmailApi
      .syncAccount(account.id)
      .catch(() => {})
      .finally(() => setTimeout(() => setSyncing(false), 700));
  };

  const saveSignature = () => {
    const editor = signatureRef.current;
    if (!editor) return;
    const html = editedSignature(editor);
    if (html === loadedRef.current) return;
    console.log("[Settings:updateSignature]", { accountId: account.id });
    void updateAccount.mutateAsync({ accountId: account.id, signature: html }).then(
      (saved) => {
        setShown(saved.signature ?? "");
        if (saved.signatureInGmail === false) {
          // An older sign-in may not change Gmail's settings: core kept it here.
          toast.info("Signature saved in Otter Mail, not in Gmail", {
            description: `Sign in to ${account.email} again to let Otter Mail save it in Gmail too.`,
            action: {
              label: "Sign in",
              onClick: () => void signIn.mutateAsync(account.email).catch(() => {}),
            },
          });
          return;
        }
        toast.success(
          capabilities.serverSignatures ? "Signature saved in Gmail" : "Signature saved",
        );
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        toast.error("Couldn't save the signature", { description: message });
      },
    );
  };

  return (
    <>
      <SettingsSection
        title={displayName}
        icon={<AccountAvatar account={account} />}
        headerAction={<span className="text-xs text-muted-foreground">{account.email}</span>}
      >
        <SettingsRow
          id={searchableSetting("mailbox-status").id}
          title="Status"
          description={<StatusText status={status} />}
          control={
            account.signedOut && signsInWithPassword(account) ? (
              <ImapPasswordForm account={account} />
            ) : account.signedOut ? (
              <SignInButton email={account.email} label="Sign in" />
            ) : (
              <Btn size="sm" disabled={syncing || sync.data?.syncing} onClick={syncNow}>
                <RotateCwIcon
                  className={cn("size-3.5", (syncing || sync.data?.syncing) && "animate-spin")}
                />
                Sync now
              </Btn>
            )
          }
        />
        <SettingsRow
          {...searchableSetting("mailbox-display-name")}
          resetAction={
            account.displayName ? (
              <SettingResetButton
                label="mailbox display name"
                onClick={() =>
                  void updateAccount.mutateAsync({ accountId: account.id, displayName: "" })
                }
              />
            ) : null
          }
          description="Shown in the sidebar and account switcher. Only used in Otter Mail."
          control={
            <DraftInput
              value={displayName}
              onCommit={(name) => {
                if (!name) return;
                console.log("[Settings:renameAccount]", { accountId: account.id, name });
                void updateAccount.mutateAsync({ accountId: account.id, displayName: name });
              }}
              aria-label={`Display name for ${account.email}`}
              className="@min-[32rem]/settings-row:w-56"
            />
          }
        />
        <SettingsRow
          id={searchableSetting("mailbox-color").id}
          resetAction={
            getAccountColor(account) !== getAccountColor({ id: account.id }) ? (
              <SettingResetButton
                label="mailbox color"
                onClick={() =>
                  void updateAccount.mutateAsync({
                    accountId: account.id,
                    color: "",
                  })
                }
              />
            ) : null
          }
          title="Color"
          description="Marks this account's mail in combined mailboxes."
          control={
            <ColorPicker
              color={getAccountColor(account)}
              label={`Color for ${account.email}`}
              onPick={(swatch) =>
                void updateAccount.mutateAsync({ accountId: account.id, color: swatch })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("signature")}
        description={
          capabilities.serverSignatures
            ? "Added to new messages, replies and forwards from this account. Saved in Gmail, so it's the same there and on every device."
            : "Added to new messages, replies and forwards from this account, on every device with your Otter account."
        }
        headerAction={
          <Btn size="sm" variant="primary" onClick={saveSignature}>
            Save signature
          </Btn>
        }
      >
        <RichTextArea
          key={shown}
          ref={signatureRef}
          placeholder="Your signature…"
          ariaLabel={`Signature for ${account.email}`}
          minHeightClass="min-h-[96px]"
          initialHTML={shown}
        />
      </SettingsSection>

      <SettingsSection title="Remove">
        <SettingsRow
          {...searchableSetting("remove-mailbox")}
          description={`Stops syncing and deletes the local copy. Nothing is deleted from ${mailServerName(account)}.`}
          control={
            <Btn size="sm" variant="destructive" onClick={() => setConfirmRemove(true)}>
              Remove…
            </Btn>
          }
        />
      </SettingsSection>

      <Dialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${displayName}?`}
        confirmLabel={removeAccount.isPending ? "Removing…" : "Remove account"}
        confirmVariant="accent"
        onConfirm={() => {
          console.log("[Settings:removeAccount]", { accountId: account.id });
          void removeAccount.mutateAsync(account.id).then(() => setConfirmRemove(false));
        }}
      >
        <Text variant="small">
          Otter Mail stops syncing {account.email} and deletes its local copy. Nothing is deleted
          from {mailServerName(account)} — you can add the account again any time.
        </Text>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

export function AccountsPane() {
  const accountsQuery = useAccounts();
  // Every mailbox, turned-off ones too, in the user's order: turning them on
  // or off and reordering follow the Otter account to every device.
  const arrangement = useMailboxArrangement();
  const accounts = arrangeAccounts(accountsQuery.data ?? [], arrangement);
  const onCount = accounts.filter((a) => !arrangement.off.includes(a.email)).length;
  const [dragEmail, setDragEmail] = useState<string | null>(null);
  const [dropSpot, setDropSpot] = useState<DropSpot>(null);
  const dropMailbox = () => {
    if (dragEmail && dropSpot && dragEmail !== dropSpot.email) {
      const order = accounts.map((a) => a.email).filter((e) => e !== dragEmail);
      const at = order.indexOf(dropSpot.email) + (dropSpot.after ? 1 : 0);
      order.splice(at, 0, dragEmail);
      setMailboxArrangement({ ...arrangement, order });
    }
    setDragEmail(null);
    setDropSpot(null);
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const current = accounts.find((a) => a.id === selectedId) ?? accounts[0];
  // Signatures live in Gmail: pick up edits made there.
  useEffect(() => void gmailApi.refreshSignatures().catch(() => {}), []);

  return (
    <SettingsPageContainer
      searchId={searchableSetting("mailboxes").id}
      title="Mailboxes"
      description="Turn mailboxes on or off and drag them into order, on every device."
      action={<SignInButton label="Add mailbox" />}
    >
      {current ? (
        <>
          <SettingsGroup>
            {accounts.length > 1 ? (
              <AllMailboxesRow
                on={arrangement.combined}
                onToggle={(combined) => setMailboxArrangement({ ...arrangement, combined })}
              />
            ) : null}
            {accounts.map((account) => {
              const on = !arrangement.off.includes(account.email);
              return (
                <AccountListRow
                  key={account.id}
                  account={account}
                  selected={account.id === current.id}
                  onSelect={() => setSelectedId(account.id)}
                  on={on}
                  lastOn={on && onCount === 1}
                  onToggle={(next) =>
                    setMailboxArrangement({
                      ...arrangement,
                      off: next
                        ? arrangement.off.filter((e) => e !== account.email)
                        : [...arrangement.off, account.email],
                    })
                  }
                  dragging={dragEmail === account.email}
                  dropSpot={dropSpot}
                  onDragStart={() => setDragEmail(account.email)}
                  onDragOver={(after) =>
                    dragEmail && dragEmail !== account.email
                      ? setDropSpot({ email: account.email, after })
                      : setDropSpot(null)
                  }
                  onDrop={dropMailbox}
                  onDragEnd={() => {
                    setDragEmail(null);
                    setDropSpot(null);
                  }}
                />
              );
            })}
          </SettingsGroup>
          <AccountEditor key={current.id} account={current} />
        </>
      ) : (
        <SettingsGroup>
          <SettingsRow
            title={accountsQuery.isLoading ? "Loading mailboxes…" : "No mailboxes yet"}
            description="Add a Gmail account, or any mailbox that works with IMAP, to start syncing mail."
          />
        </SettingsGroup>
      )}
    </SettingsPageContainer>
  );
}
