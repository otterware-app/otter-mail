/**
 * One chat: its transcript with the composer pinned below, or, while its
 * provider can't run yet, what to set up. Files dropped on it go with the
 * next message; passages selected in a reply are cited in it.
 */

import { useCallback, useState, type RefObject } from "react";
import { MessageScroller } from "@shadcn/react/message-scroller";
import { ArrowDownIcon, MailIcon } from "lucide-react";
import { ScrollArea } from "~/components/ui/scroll-area";
import { buttonClass } from "./ui";
import { gmailApi, type AgentSettingsPatch, type ChatChange, type ProviderKind } from "./api";
import {
  ProviderIcon,
  providerSummary,
  useChatProvider,
  useSetProvidersState,
} from "./agent-providers";
import type { MailChatContext } from "./chat-context";
import {
  CitationCommentEditor,
  CiteSelectionButton,
  rangeAnchor,
  type Citation,
} from "./chat-cite";
import { AttachmentPreview, attachmentPreview, type PreviewFile } from "./attachment-preview";
import { DropOverlay, useChatAttachments, useFileDrop } from "./chat-attachments";
import { setCitations, useChats } from "./chat-store";
import { ChatTranscript } from "./chat-transcript";
import { ChatComposer } from "./chat-composer";
import { isProviderUsable } from "./agent-providers";
import { toast } from "./toast";

const NO_CITATIONS: Citation[] = [];

function useChatImageLoader(provider?: ProviderKind, sessionId?: string | null) {
  return useCallback(
    async (href: string) => {
      if (!provider) throw new Error("Open the image from its chat.");
      const file = await gmailApi.agentReadFile(provider, sessionId ?? "", href);
      const preview = attachmentPreview(file.name, file.mimeType);
      if (preview?.kind !== "image") throw new Error("This file isn't an image.");
      return `data:${preview.mimeType};base64,${file.data}`;
    },
    [provider, sessionId],
  );
}

export function ChatView({
  chatId,
  context,
  onClearQuote,
  inputRef,
  onOpenChange,
}: {
  chatId: string;
  context: MailChatContext;
  onClearQuote?: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onOpenChange: (change: ChatChange) => Promise<void>;
}) {
  const convo = useChats((s) => s.conversations.find((c) => c.id === chatId));
  const streaming = useChats((s) => Boolean(s.runs[chatId]));
  const hydrating = useChats((s) => s.hydrating === chatId);
  const citations = useChats((s) => s.citations[chatId]) ?? NO_CITATIONS;
  const turns = convo?.turns ?? [];
  const chat = useChatProvider(convo);
  const setProvidersState = useSetProvidersState();
  const updateSettings = (patch: AgentSettingsPatch) => {
    console.log("[AgentChat:updateSettings]", patch);
    gmailApi.updateAgentSettings(patch).then(setProvidersState, () => {});
  };

  const files = useChatAttachments();
  const drop = useFileDrop((dropped) => {
    void files.add(dropped);
    inputRef.current?.focus();
  });

  // The cited passage whose comment is open.
  const [commenting, setCommenting] = useState<{
    id: string;
    anchor: DOMRect;
    side: "above" | "below";
    range?: Range;
  } | null>(null);
  const [shownChat, setShownChat] = useState(chatId);
  if (shownChat !== chatId) {
    setShownChat(chatId);
    setCommenting(null);
  }
  const [transcript, setTranscript] = useState<HTMLDivElement | null>(null);
  const commentingCitation = commenting && citations.find((c) => c.id === commenting.id);
  const cite = (text: string, range: Range) => {
    const id = crypto.randomUUID();
    setCitations(chatId, (list) => [...list, { id, text }]);
    setCommenting({ id, anchor: rangeAnchor(range), side: "below", range });
  };

  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  const loadChatImage = useChatImageLoader(convo?.provider, convo?.sessionId);
  const openChatFile = (href: string) => {
    if (!convo) return;
    void gmailApi
      .agentReadFile(convo.provider, convo.sessionId ?? "", href)
      .then((file) => {
        if (!attachmentPreview(file.name, file.mimeType))
          throw new Error("This file type can't be previewed.");
        setPreviewFile({ ...file, load: async () => file.data });
      })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : "Couldn't open the file."),
      );
  };
  const openContextItem = (item: { title: string; target: ChatChange["target"] }) => {
    onOpenChange({ title: item.title, action: "updated", target: item.target }).catch(
      (error: unknown) =>
        toast.error("Couldn't open this item", {
          description: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  // An empty chat whose provider can't run yet shows setup instead of a composer.
  const needsSetup = Boolean(chat.state) && !chat.usable && turns.length === 0;
  const setupSummary = providerSummary(chat.provider);
  const fallback = chat.state?.providers.find(
    (p) => p.kind !== chat.kind && isProviderUsable(p) && p.checkedAt !== null,
  );
  // An empty chat shows a centered headline above the pinned composer (Codex).
  const hero = turns.length === 0 && !hydrating;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...(needsSetup ? {} : drop.handlers)}>
      {drop.active ? <DropOverlay /> : null}
      {needsSetup ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <ProviderIcon kind={chat.kind} className="mb-1 size-6" />
          <span className="text-sm font-medium text-foreground">
            {chat.name}: {setupSummary.headline}
          </span>
          {setupSummary.detail ? (
            <span className="text-sm text-muted-foreground">{setupSummary.detail}</span>
          ) : null}
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void gmailApi.openSettings({ pane: "agents" })}
              className={buttonClass("outline", "sm")}
            >
              Open Settings
            </button>
            {fallback ? (
              <button
                type="button"
                onClick={() => updateSettings({ selected: fallback.kind })}
                className={buttonClass("ghost", "sm")}
              >
                Use {fallback.displayName}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <MessageScroller.Provider autoScroll defaultScrollPosition="end">
          <MessageScroller.Root className="relative min-h-0 flex-1">
            <ScrollArea
              className="h-full"
              viewportClassName="topbar-scroll-fade px-3 pb-3 pt-(--workspace-titlebar-scroll-fade-height)"
              render={<MessageScroller.Viewport />}
            >
              <MessageScroller.Content
                ref={setTranscript}
                className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-2"
              >
                {turns.length === 0 && hydrating ? (
                  <div className="px-2 pt-6 text-center text-sm text-placeholder">
                    Loading this session from {chat.name}…
                  </div>
                ) : null}
                <ChatTranscript
                  turns={turns}
                  streaming={streaming}
                  detached={Boolean(convo?.openRequest)}
                  providerName={chat.name}
                  onOpenFile={openChatFile}
                  loadImage={loadChatImage}
                  onOpenContext={openContextItem}
                  onOpenChange={onOpenChange}
                />
              </MessageScroller.Content>
            </ScrollArea>
            <MessageScroller.Button
              direction="end"
              render={(props, state) =>
                state.active ? (
                  <button
                    {...props}
                    type="button"
                    aria-label="Jump to latest"
                    className="surface-glass absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border/40 text-muted-foreground shadow-sm hover:text-foreground"
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </button>
                ) : null
              }
            />
            <CiteSelectionButton root={transcript} onCite={cite} />
            {commentingCitation && commenting ? (
              <CitationCommentEditor
                key={commenting.id}
                citation={commentingCitation}
                anchor={commenting.anchor}
                side={commenting.side}
                range={commenting.range}
                onSave={(comment) => {
                  setCitations(chatId, (list) =>
                    list.map((c) =>
                      c.id === commenting.id ? { ...c, comment: comment.trim() || undefined } : c,
                    ),
                  );
                  setCommenting(null);
                  inputRef.current?.focus();
                }}
                onCancel={() => setCommenting(null)}
              />
            ) : null}
            {/* An empty chat shows its headline in the middle of the column. */}
            {hero ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 px-6">
                <MailIcon
                  aria-hidden
                  strokeWidth={1.25}
                  className="size-10 text-muted-foreground"
                />
                <h1 className="w-full max-w-3xl text-balance text-center text-2xl font-normal tracking-tight text-foreground">
                  {context.headline}
                </h1>
              </div>
            ) : null}
          </MessageScroller.Root>
          <ChatComposer
            chatId={chatId}
            convo={convo}
            chat={chat}
            context={context}
            onClearQuote={onClearQuote}
            files={files}
            inputRef={inputRef}
            onEditCitation={(id, anchor) => setCommenting({ id, anchor, side: "above" })}
            onSent={() => setCommenting(null)}
            updateSettings={updateSettings}
          />
        </MessageScroller.Provider>
      )}
      <AttachmentPreview file={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
}
