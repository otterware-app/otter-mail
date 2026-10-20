/**
 * The sidebar while Chats is picked in the rail (the AI workspace): New chat,
 * then the account's chats, newest first, by when they last changed. A chat
 * working, waiting on you, or finished while you were away says so.
 */

import { LoaderCircleIcon, MousePointer2Icon, SquarePenIcon, Trash2Icon } from "lucide-react";

import { useChatProvider } from "./agent-providers";
import { deleteConversation, isBlank, useChats, type Conversation } from "./chat-store";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./menu";
import { NewRow, Section, SidebarBody, SkRow, SpaceHeading } from "./sidebar-ui";

const DAY = 24 * 60 * 60 * 1000;

/** Today, Yesterday, the week, then the rest: where a chat last changed. */
function groupsOf(chats: Conversation[]): { title: string; chats: Conversation[] }[] {
  const today = new Date().setHours(0, 0, 0, 0);
  const groups = [
    { title: "Today", from: today },
    { title: "Yesterday", from: today - DAY },
    { title: "Previous 7 days", from: today - 7 * DAY },
    { title: "Older", from: -Infinity },
  ].map((g) => ({ ...g, chats: [] as Conversation[] }));
  for (const chat of chats) groups.find((g) => chat.updatedAt >= g.from)!.chats.push(chat);
  return groups.filter((g) => g.chats.length > 0);
}

export function ChatsSidebar({
  selectedId,
  onSelect,
  onNewChat,
}: {
  selectedId: string | null;
  onSelect: (chatId: string) => void;
  onNewChat: () => void;
}) {
  const conversations = useChats((s) => s.conversations);
  const runs = useChats((s) => s.runs);
  const approvals = useChats((s) => s.approvals);
  const questions = useChats((s) => s.questions);
  const unseen = useChats((s) => s.unseen);
  const ready = useChats((s) => s.ready);
  const { selectedKind } = useChatProvider(undefined);
  const chats = conversations.filter((c) => !isBlank(c));

  const row = (chat: Conversation) => {
    const run = runs[chat.id];
    const waiting =
      run &&
      (approvals.some((a) => a.requestId === run.requestId) ||
        questions.some((q) => q.requestId === run.requestId));
    return (
      <ContextMenu key={chat.id}>
        <ContextMenuTrigger>
          <SkRow
            icon={
              run && !waiting ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <MousePointer2Icon className="size-4" />
              )
            }
            title={chat.title}
            selected={chat.id === selectedId}
            onClick={() => onSelect(chat.id)}
            // Waiting on you, or finished while you were away.
            dot={Boolean(waiting || unseen.has(chat.id))}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            icon={<Trash2Icon />}
            color="red"
            onSelect={() => deleteConversation(chat.id, selectedKind)}
          >
            Delete chat
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <SpaceHeading title="Chats" />
      <NewRow
        icon={<SquarePenIcon />}
        label="New chat"
        shortcut="agent.newChat"
        tour="new-chat"
        onClick={onNewChat}
      />
      <SidebarBody>
        {groupsOf(chats).map((group) => (
          <Section key={group.title} title={group.title}>
            {group.chats.map(row)}
          </Section>
        ))}
        {ready && chats.length === 0 ? (
          <p className="px-(--sidebar-row-content-inset) pt-4 text-sm text-sidebar-muted-foreground/70">
            Chats you start show up here, on every device.
          </p>
        ) : null}
      </SidebarBody>
    </div>
  );
}
