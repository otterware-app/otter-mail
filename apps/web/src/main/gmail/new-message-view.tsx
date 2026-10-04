import { toast } from "./toast";
import { useEffect, useRef, useState } from "react";
import { sendWithUndo } from "./undo-send";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./menu";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { useSendMessage } from "./hooks";
import { normalizeAddressList, parseAddressEntry, splitAddressList } from "./address";
import { getAccountColor } from "./account-style";
import { IconBtn, HintTooltip } from "./ui";
import {
  CcBccToggles,
  ComposeDocument,
  ComposerCard,
  ComposerField,
  ComposerFooter,
  SubjectInput,
  DraftRemoteBanner,
  draftStatus,
} from "./composer-kit";
import { RichTextArea, textToHtml, type RichTextRef } from "./rich-text";
import {
  AttachmentChips,
  ComposeDropOverlay,
  attachmentSignature,
  autosaveDelayMs,
  loadMessageAttachments,
  filesToComposeAttachments,
  pickComposeAttachments,
  useComposeFileDrop,
} from "./compose-attachments";
import { useDraftAutosave } from "./use-draft-autosave";
import { RecipientInput } from "./recipient-input";
import type { ComposeAttachment, GmailAccount } from "./types";

/** The From account picker (shown only with several accounts). */
function FromPicker({
  accounts,
  value,
  onChange,
}: {
  accounts: GmailAccount[];
  value: GmailAccount;
  onChange: (accountId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Send from"
          className="-ml-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-sm text-foreground outline-none hover:bg-accent-surface focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: getAccountColor(value) }}
          />
          <span className="truncate">{value.email}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {accounts.map((account) => (
          <DropdownMenuItem
            key={account.id}
            icon={
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: getAccountColor(account) }}
                aria-hidden
              />
            }
            onSelect={() => onChange(account.id)}
          >
            {account.email}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * New message pane: replaces the reader when composing a fresh email —
 * recipients, subject, attachments, and body in the docked composer,
 * autosaving to a Gmail draft as you type.
 */
export function NewMessageView({
  accounts,
  defaultAccountId,
  onClose,
  prefill,
}: {
  accounts: GmailAccount[];
  defaultAccountId: string;
  onClose: () => void;
  /** Seeds the composer once at mount (mailto: links); remount to re-seed. */
  prefill?: { to?: string; cc?: string; subject?: string; body?: string };
}) {
  const [fromId, setFromId] = useState(defaultAccountId);
  const [to, setTo] = useState(prefill?.to ?? "");
  const [cc, setCc] = useState(prefill?.cc ?? "");
  const [ccVisible, setCcVisible] = useState(Boolean(prefill?.cc));
  const [bcc, setBcc] = useState("");
  const [bccVisible, setBccVisible] = useState(false);
  const [subject, setSubject] = useState(prefill?.subject ?? "");
  const [text, setText] = useState(prefill?.body ?? "");
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
  const [formatting, setFormatting] = useState(false);
  const toRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<RichTextRef>(null);
  const sendMessage = useSendMessage();

  const fromAccount = accounts.find((a) => a.id === fromId) ?? accounts[0];

  const { isDragging, dropProps } = useComposeFileDrop((files) => {
    void filesToComposeAttachments(files, attachments).then((picked) => {
      if (picked.length > 0) setAttachments((prev) => [...prev, ...picked]);
    });
  });

  const draft = useDraftAutosave({
    accountId: fromAccount?.id ?? null,
    delayMs: autosaveDelayMs(attachments),
    // Edited elsewhere (an agent, Gmail web): load that version in place.
    onRemoteChange: async (detail) => {
      setTo(detail.to ?? "");
      setCc(detail.cc ?? "");
      setBcc(detail.bcc ?? "");
      setCcVisible(Boolean(detail.cc));
      setBccVisible(Boolean(detail.bcc));
      setSubject(detail.subject ?? "");
      editorRef.current?.setHTML(detail.bodyHtml ?? textToHtml(detail.bodyText ?? ""));
      setAttachments(
        detail.attachments.length > 0
          ? await loadMessageAttachments(fromAccount?.id ?? "", detail.id, detail.attachments)
          : [],
      );
    },
    signal: JSON.stringify({
      fromId,
      to,
      cc,
      bcc,
      subject,
      text,
      att: attachmentSignature(attachments),
    }),
    getPayload: () => {
      if (!to.trim() && !subject.trim() && !text.trim() && attachments.length === 0) return null;
      const plain = editorRef.current?.getText() ?? text;
      const html = editorRef.current?.getHTML() ?? textToHtml(plain);
      return {
        to: normalizeAddressList(to),
        cc: normalizeAddressList(cc) || undefined,
        bcc: normalizeAddressList(bcc) || undefined,
        subject,
        body: plain,
        bodyHtml: `<div dir="auto">${html}</div>`,
        attachments: attachments.length > 0 ? attachments : undefined,
      };
    },
  });

  useEffect(() => {
    toRef.current?.focus();
  }, []);

  // Escape closes, keeping the autosaved draft (capture phase beats
  // home-view's Escape handling).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = e.target as Element | null;
      if (el && typeof el.closest === "function" && el.closest('[role="dialog"]')) return;
      // An open autocomplete popup owns Escape (it dismisses itself).
      if (el && typeof el.closest === "function" && el.closest('[data-ac-open="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, [onClose]);

  const hasRecipient = splitAddressList(to).some((e) => parseAddressEntry(e).email.includes("@"));
  const canSend =
    !sendMessage.isPending &&
    !!fromAccount &&
    hasRecipient &&
    (text.trim().length > 0 || subject.trim().length > 0);

  const handleSend = async (scheduledAt?: number) => {
    if (!canSend || !fromAccount) return;
    console.log("[NewMessageView:send]", { from: fromAccount.id, to });
    const payload = {
      accountId: fromAccount.id,
      to: normalizeAddressList(to),
      cc: normalizeAddressList(cc) || undefined,
      bcc: normalizeAddressList(bcc) || undefined,
      subject: subject.trim() || "(no subject)",
      body: text,
      bodyHtml: `<div dir="auto">${editorRef.current?.getHTML() ?? textToHtml(text)}</div>`,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    if (scheduledAt !== undefined) {
      await sendMessage.mutateAsync({ ...payload, scheduledAt });
      await draft.finalize({ deleteDraft: true });
      toast.success("Send scheduled", { description: new Date(scheduledAt).toLocaleString() });
      onClose();
      return;
    }
    // Close now; the unmount flush keeps a draft backup until sending succeeds.
    onClose();
    sendWithUndo({
      subject: payload.subject,
      send: () => sendMessage.mutateAsync(payload),
      onSent: () => draft.finalize({ deleteDraft: true }),
      savedDraft: draft.savedDraft,
    });
  };

  const discard = () => {
    onClose();
    void draft.finalize({ deleteDraft: true });
  };
  const attach = () => {
    void pickComposeAttachments(attachments).then((picked) => {
      if (picked.length > 0) setAttachments((prev) => [...prev, ...picked]);
    });
  };

  return (
    <div className="relative flex h-full min-w-0 flex-col" {...dropProps}>
      <ComposeDropOverlay visible={isDragging} />
      <div className="drag-region flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 px-4">
        <div className="min-w-0 flex-1 truncate text-sm text-muted-foreground">New message</div>
        <HintTooltip label="Close (keeps the draft)" hint="Esc" side="bottom">
          <IconBtn label="Close" onClick={onClose}>
            <XIcon className="size-4" />
          </IconBtn>
        </HintTooltip>
      </div>

      <ComposerCard onSend={() => void handleSend()} variant="plain" className="min-h-0 flex-1">
        <ComposeDocument
          fields={
            <>
              <DraftRemoteBanner
                remote={draft.remote}
                mine={{ to, cc, subject, body: text }}
                onTakeTheirs={draft.takeTheirs}
                onKeepMine={draft.keepMine}
                onSaveAsNew={draft.saveAsNew}
              />
              {accounts.length > 1 && fromAccount ? (
                <ComposerField label="From">
                  <FromPicker accounts={accounts} value={fromAccount} onChange={setFromId} />
                </ComposerField>
              ) : null}
              <ComposerField
                label="To"
                trailing={
                  <CcBccToggles
                    showCc={ccVisible}
                    showBcc={bccVisible}
                    onShowCc={() => setCcVisible(true)}
                    onShowBcc={() => setBccVisible(true)}
                  />
                }
              >
                <RecipientInput ref={toRef} value={to} onChange={setTo} ariaLabel="To" />
              </ComposerField>
              {ccVisible ? (
                <ComposerField label="Cc">
                  <RecipientInput value={cc} onChange={setCc} ariaLabel="Cc" />
                </ComposerField>
              ) : null}
              {bccVisible ? (
                <ComposerField label="Bcc">
                  <RecipientInput value={bcc} onChange={setBcc} ariaLabel="Bcc" />
                </ComposerField>
              ) : null}
            </>
          }
          subject={<SubjectInput title value={subject} onChange={setSubject} />}
          editor={
            <RichTextArea
              ref={editorRef}
              placeholder="Write your message…"
              ariaLabel="Message"
              onTextChange={setText}
              showToolbar={formatting}
              minHeightClass="min-h-[40vh]"
              maxHeightClass="max-h-none"
              initialHTML={prefill?.body ? textToHtml(prefill.body) : undefined}
              signatureHTML={fromAccount?.signature}
            />
          }
          attachments={
            <AttachmentChips
              attachments={attachments}
              onRemove={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))}
            />
          }
          footer={
            <ComposerFooter
              onAttach={attach}
              formatting={formatting}
              onToggleFormatting={() => setFormatting((f) => !f)}
              onDiscard={discard}
              status={draftStatus(draft)}
              statusTone={draft.saveState === "error" ? "error" : "muted"}
              canSend={canSend}
              onSchedule={handleSend}
              onSend={() => void handleSend()}
            />
          }
        />
      </ComposerCard>
    </div>
  );
}
