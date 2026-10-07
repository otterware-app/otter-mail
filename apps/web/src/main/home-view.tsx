import { useLatest } from "./use-latest";
import { TodoistDialogs } from "./integrations/todoist";
import {
  useLayoutEffect,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useMatch, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { EmptyState } from "~/components/ui/empty-state";
import { useQueryClient } from "@tanstack/react-query";
import { toast, type ToastId } from "./gmail/toast";
import { setDraftOpener } from "./gmail/undo-send";
import { AccountsSidebar, MailboxSidebarPage } from "./gmail/accounts-sidebar";
import { SpacePeekCard, useSpacePeek } from "./gmail/space-peek";
import { SpaceRail } from "./gmail/space-rail";
import { ViewEditorDialog } from "./gmail/view-editor";
import { MessageList } from "./gmail/message-list";
import { MessageReader } from "./gmail/message-reader";
import { NewMessageView } from "./gmail/new-message-view";
import { CommandPalette } from "./gmail/command-palette";
import { AgentChatPanel } from "./gmail/agent-chat";
import { SEARCH_MAILBOX } from "./gmail/gmail-query";
import { searchTabId, searchTitle, type SearchTab } from "./gmail/search-tabs";
import {
  PanelControl,
  SidebarControl,
  TitleControls,
  TitleTrailing,
  TitlebarInset,
  SidebarTitle,
} from "./gmail/top-bar";
import { SettingsPage, type SettingsRoute } from "./settings/settings-page";
import { SettingsNav } from "./settings/settings-nav";
import { isTypingTarget } from "./gmail/keyboard";
import { cn, HintTooltip, IconBtn } from "./gmail/ui";
import { useMailLayout } from "./theme/interface-settings";
import { FloatingReader } from "./gmail/floating-reader";
import { usePanelAnimationSettings, usePanelPresence } from "./panel-animations";
import {
  keybindingContext,
  useCommandHandlers,
  useKeybindingContext,
  useKeybindingDispatcher,
} from "./keybindings/dispatch";
import { MAILBOX_JUMP_COMMANDS } from "./keybindings/commands";
import {
  useAccounts,
  useAccountSync,
  useGlobalSyncStatus,
  useGmailWriteFailureToasts,
  useExternalMailChanges,
  useModifyMessage,
  useModifyThread,
  useTrashMessage,
  useTrashThread,
  useUntrashThread,
  useUntrashMessage,
} from "./gmail/hooks";
import {
  beginUndoGroup,
  onUndoableAction,
  quietParams,
  registerRedo,
  takeRedo,
  takeUndo,
  type UndoAction,
} from "./gmail/undo";
import { getAccountColor, getAccountContrastColor } from "./gmail/account-style";
import { gmailApi, type ChatChange, type MailtoTarget, type SettingsPane } from "./gmail/api";
import type { QuoteContext } from "./gmail/chat-context";
import type { GmailAccount, GmailMessageSummary, MailView } from "./gmail/types";
import {
  useMailViews,
  resolveRules,
  loadLastLocation,
  saveLastLocation,
  COMBINED_ACCOUNT_ID,
  INBOX_VIEW_ID,
  SENT_VIEW_ID,
  STARRED_VIEW_ID,
  DRAFTS_VIEW_ID,
  ALL_MAIL_VIEW_ID,
} from "./gmail/custom-views";
import { ALL_MAIL_LABEL_ID } from "./gmail/label-names";
import { useMonochromeTheme } from "./theme/apply-theme";
import { features } from "./features";
import { useMailboxes } from "./mailboxes";
import { ALL_PROJECTS, useProject, useProjects } from "./gmail/projects";
import {
  PROJECTS_SPACE,
  VIEW_LIST,
  firstLabelOf,
  isViewSpaceId,
  spaceOf,
  spansMailboxes as spanning,
} from "./gmail/spaces";
import { ProjectsSidebar } from "./gmail/projects-sidebar";
import { ProjectsOverview } from "./gmail/projects-overview";
import { ProjectView } from "./gmail/project-view";
import { NewProjectDialog } from "./gmail/project-menus";
import { UpdateCard } from "./updates";
import { useRecordRecentlyViewed } from "./recently-viewed";
import { SetupFlow } from "./onboarding/setup";
import { newTab, openLink, selectTab, useBrowser, useBrowserEvents } from "./browser/store";
import { Tour } from "./onboarding/tour";
import {
  endTour,
  getSetupStage,
  markSetUp,
  offerTour,
  useSetupStage,
  useTourRequested,
} from "./onboarding/onboarding";

/** Narrowest the reader gets when the chat panel is dragged wider. */
const READER_MIN_WIDTH = 360;
/** The mailbox rail's width (styles.css's --workspace-rail-width). */
const RAIL_WIDTH = 52;

/** A place in the mail, as the route names it (router.tsx). */
type MailLoc = {
  /** The space (spaces.ts): an account id, COMBINED_ACCOUNT_ID, a view's id, or PROJECTS_SPACE. */
  mailbox: string;
  /** A label or view id (in Projects, ALL_PROJECTS or a project's id), or SEARCH_MAILBOX. */
  label: string;
  /** The conversation (or message) open in the reader. */
  messageId: string | null;
  /** The open message's own account, where it isn't `mailbox`. */
  account: string | null;
  /** One message picked from the open conversation: the reader shows just that one. */
  focusId: string | null;
};

const sameLoc = (a: MailLoc, b: MailLoc | null) =>
  !!b &&
  a.mailbox === b.mailbox &&
  a.label === b.label &&
  a.messageId === b.messageId &&
  a.account === b.account &&
  a.focusId === b.focusId;

/** The place in the mail the route names, if it names one. */
function useRouteMailLoc(): MailLoc | null {
  const message = useMatch({ from: "/mail/$mailbox/$label/$messageId", shouldThrow: false });
  const list = useMatch({ from: "/mail/$mailbox/$label", shouldThrow: false });
  if (message) {
    const { mailbox, label, messageId } = message.params;
    const { account, message: focusId } = message.search;
    return { mailbox, label, messageId, account: account ?? null, focusId: focusId ?? null };
  }
  if (list) {
    const { mailbox, label } = list.params;
    return { mailbox, label, messageId: null, account: null, focusId: null };
  }
  return null;
}

/** Where the mail was last time (custom-views' saved location). */
function savedLoc(): MailLoc {
  const saved = loadLastLocation();
  const [mailbox, label] = saved ? [saved.accountId, saved.labelId] : ["", "INBOX"];
  return { mailbox, label, messageId: null, account: null, focusId: null };
}

/**
 * `loc` among the spaces there are: one turned off (or "All mailboxes" off,
 * a view deleted, or one not there at all) gives way to what's first now
 * (Combined when it's on, else the first account), at its inbox. Views count
 * as there until they're known (`views` null).
 */
function placeFor(
  loc: MailLoc,
  accounts: GmailAccount[],
  combined: boolean,
  views: MailView[] | null,
): MailLoc {
  const there =
    views === null && isViewSpaceId(loc.mailbox)
      ? true
      : spaceOf(loc.mailbox, { accounts, views: views ?? [], combined }) !== null;
  if (there) return loc;
  const mailbox = combined ? COMBINED_ACCOUNT_ID : (accounts[0]?.id ?? loc.mailbox);
  return { mailbox, label: firstLabelOf(mailbox), messageId: null, account: null, focusId: null };
}

/** The Settings pane the route names, if it names one. */
function useRouteSettings(): SettingsRoute | null {
  const match = useMatch({ from: "/mail/settings/$pane", shouldThrow: false });
  const pane = match?.params.pane;
  const target = match?.search.target;
  return useMemo(() => (pane ? { pane, target } : null), [pane, target]);
}

/**
 * Drag-resizable pane width persisted to localStorage. `room` (when given)
 * caps the width at drag start so neighbouring panes keep their minimum.
 */
function useStoredWidth(
  key: string,
  def: number,
  min: number,
  max: number,
  dir: 1 | -1 = 1,
  room?: () => number,
) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : def;
  });
  const widthRef = useLatest(width);
  // The pane element itself, resized imperatively during a drag.
  const paneRef = useRef<HTMLDivElement>(null);
  // The animated frame around a collapsible pane: follows the drag with its
  // open/close transition switched off.
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ cleanup: () => void; finish: () => void } | null>(null);
  useEffect(() => () => dragRef.current?.cleanup(), []);

  const start = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current?.finish();
    e.preventDefault();
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startW = widthRef.current;
    const cap = Math.max(min, Math.min(max, room ? room() : max));
    let latest = startW;
    let raf = 0;
    let finished = false;
    // Browser guests and message iframes must not swallow the release.
    const cover = document.createElement("div");
    cover.className = "no-drag fixed inset-0 z-[200] touch-none select-none cursor-col-resize";
    document.body.append(cover);
    const apply = () => {
      raf = 0;
      if (paneRef.current) paneRef.current.style.width = `${latest}px`;
      if (frameRef.current) frameRef.current.style.width = `${latest}px`;
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!(ev.buttons & 1)) {
        finish();
        return;
      }
      // dir -1: right-side panes grow when the handle drags left.
      latest = Math.min(cap, Math.max(min, startW + dir * (ev.clientX - startX)));
      // Drive the drag through the DOM only — calling setWidth on every
      // pointermove re-renders the whole HomeView tree (message list, reader,
      // chat) each frame, which is what made resizing slow and shaky. Batch the
      // style write to one per frame and commit to React state once, on release.
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const cleanup = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", finish);
      handle.removeEventListener("lostpointercapture", finish);
      if (raf) cancelAnimationFrame(raf);
      cover.remove();
      if (frameRef.current) frameRef.current.style.transitionProperty = "";
      dragRef.current = null;
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    };
    const finish = () => {
      if (finished) return;
      cleanup();
      apply();
      widthRef.current = latest;
      setWidth(latest);
      localStorage.setItem(key, String(latest));
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish();
    };
    dragRef.current = { cleanup, finish };
    if (frameRef.current) frameRef.current.style.transitionProperty = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", finish);
    handle.addEventListener("lostpointercapture", finish);
    handle.setPointerCapture(pointerId);
  };

  return { width, start, paneRef, frameRef };
}

function PaneResizer({ onPointerDown }: { onPointerDown: (e: ReactPointerEvent) => void }) {
  // Zero-width in the layout: panes meet on a tone change (or their own faint
  // divider), and the grab area is an invisible strip centered on the seam
  // that shows a hairline on hover (no-drag, so it resizes instead of moving
  // the window inside the title band).
  return (
    <div className="relative z-20 w-0 shrink-0" aria-hidden>
      <div
        onPointerDown={onPointerDown}
        className="no-drag group absolute inset-y-0 -left-[3px] flex w-1.5 cursor-col-resize justify-center"
      >
        <div className="w-px group-hover:bg-input" />
      </div>
    </div>
  );
}

/**
 * ChatGPT-style window chrome: the window wears the sidebar's surface (and
 * grain), so the rail and the title band read as one frame, and the columns
 * after the rail share one inset panel (canvas) that starts under the title
 * band, with rounded corners and a faint edge. The panes themselves are
 * transparent: their title bands sit on the frame, their bodies on the panel.
 */
const PANE = "min-h-0 overflow-hidden";
/** The sidebar's body sits in the panel (in a browser tab, its heading too),
    between the frame's tone and the canvas, with a faint full-height divider
    before the list. */
const PANE_SIDEBAR = `${PANE} relative text-sidebar-foreground before:pointer-events-none before:absolute before:bottom-px before:left-px before:right-0 before:top-[calc(var(--workspace-topbar-height)+1px)] web:before:inset-y-0 before:-z-10 before:rounded-l-[calc(var(--radius-xl)-1px)] before:bg-(--sidebar-panel-surface) after:pointer-events-none after:absolute after:bottom-0 after:right-0 after:top-0 after:z-20 after:w-px after:bg-border/70`;
/** Faint full-height dividers, through the title band (ChatGPT): on the
    list's right, the chat's left. */
const PANE_LIST = `${PANE} relative after:pointer-events-none after:absolute after:bottom-0 after:right-0 after:top-0 after:z-20 after:w-px after:bg-border/70`;
const PANE_MAIN = PANE;
const PANE_CHAT = `${PANE} relative before:pointer-events-none before:absolute before:bottom-0 before:left-0 before:top-0 before:z-20 before:w-px before:bg-border/70`;
/** Clips a collapsible pane while its width animates open or closed (Otter
    Code's panel animations); the pane keeps its width so nothing reflows. */
const PANE_FRAME =
  "flex min-h-0 shrink-0 overflow-hidden [[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:[transition-duration:var(--panel-animation-duration)] [[data-panel-animations=true]_&]:ease-out";

/**
 * The main window: the setup while there's no mailbox yet (or until it's
 * finished), else mail. The setup stands in for the whole view, so none of
 * mail's shortcuts run under it.
 */
export function HomeView() {
  const accountsQuery = useAccounts();
  const stage = useSetupStage();
  const loaded = !accountsQuery.isLoading;
  if (loaded && ((accountsQuery.data ?? []).length === 0 || stage === "setup")) {
    return <SetupFlow />;
  }
  return <MailHome />;
}

function MailHome() {
  // Where the window is comes from the route: a place in the mail, or a
  // Settings pane over the mail it was opened from (router.tsx).
  const navigate = useNavigate();
  const router = useRouter();
  const routeLoc = useRouteMailLoc();
  const settingsRoute = useRouteSettings();

  const accountsQuery = useAccounts();
  const { views, loaded: viewsLoaded, saveView, deleteView, resetView } = useMailViews();

  // The mailboxes shown: turned-on accounts, in the user's order (Settings →
  // Mailboxes, synced with the Otter account).
  const mailboxes = useMailboxes();
  const accounts = mailboxes.accounts;
  const accountIds = accounts.map((a) => a.id);
  const firstRealAccountId = accounts[0]?.id ?? null;
  const ready = !accountsQuery.isLoading && accounts.length > 0;

  // The mail under Settings: where it was when Settings opened.
  const [lastMail, setLastMail] = useState<MailLoc | null>(null);
  if (routeLoc && !sameLoc(routeLoc, lastMail)) setLastMail(routeLoc);
  // Where the route names no place in the mail (the index route, or a window
  // that started in Settings), it's where it was last time. Once the
  // mailboxes are known, it's always one of theirs (effects below catch the
  // route up), so nothing shows a place only to leave it at once.
  const placed = routeLoc ?? lastMail;
  const viewSpaces = views.filter((v) => v.kind === "custom");
  const mailLoc = ready
    ? placeFor(placed ?? savedLoc(), accounts, mailboxes.combined, viewsLoaded ? views : null)
    : placed;
  const initialized = ready && mailLoc !== null;
  const selectedAccountId = mailLoc?.mailbox ?? null;
  const selectedLabelId = mailLoc?.label ?? "INBOX";
  const selectedMessageId = mailLoc?.messageId ?? null;
  // Account that owns the currently-open message (differs per row in combined views).
  const readerAccountId = mailLoc?.account ?? null;
  // One message picked from an expanded conversation in the list: the reader
  // shows just that message.
  const focusedMessageId = mailLoc?.focusId ?? null;
  // Browsing past a draft keeps mail navigation active until it is opened to edit.
  const [autoFocusDraft, setAutoFocusDraft] = useState(true);
  // Open searches, each a sidebar row: the top Search row (all mail) and one
  // per view it was started from (⌘F there). They keep their query and any
  // unrun text while you visit other mailboxes; × or Escape closes them.
  const [searchTabs, setSearchTabs] = useState<SearchTab[]>([]);
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  // The view being made ("new") or edited, in a dialog.
  const [viewEditor, setViewEditor] = useState<string | null>(null);
  // mailto: target from the OS (OtterMail as default mail app). The seq keys
  // NewMessageView so a link arriving while the composer is open re-seeds it.
  const [mailtoPrefill, setMailtoPrefill] = useState<MailtoTarget | null>(null);
  const [mailtoSeq, setMailtoSeq] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The pane Settings was last on: opening it again without asking for one
  // (the menu, ⌘,) returns there.
  const lastPaneRef = useRef<SettingsPane>("general");
  useLayoutEffect(() => {
    if (settingsRoute) lastPaneRef.current = settingsRoute.pane;
  });
  // In-app settings page; null = mail. Opened from the sidebar footer, ⌘,
  // (menu accelerator → backend broadcast), or any window's deep link.
  const openSettings = useCallback(
    (route: SettingsRoute) => {
      // Only the scroll target going (it was reached): the same place.
      const replace = !!settingsRoute && route.pane === settingsRoute.pane;
      void navigate({
        to: "/settings/$pane",
        params: { pane: route.pane },
        search: { target: route.target },
        replace,
      });
    },
    [navigate, settingsRoute],
  );
  const openSettingsRef = useLatest(openSettings);
  useEffect(() => {
    const pull = async () => {
      try {
        const target = await gmailApi.getSettingsTarget();
        if (!target) return;
        const pane = target.pane ?? lastPaneRef.current;
        console.log("[HomeView:openSettings]", { pane });
        openSettingsRef.current({ pane });
      } catch (error) {
        console.log("[HomeView:getSettingsTarget] failed", { error: String(error) });
      }
    };
    void pull();
    return window.desktopBridge.on("settings:open", () => void pull());
  }, [openSettingsRef]);

  // ⌘W (File ▸ Close): close the panel's active tab (the last closes the
  // panel); close the window when the panel is absent.
  const closeChatTabRef = useRef<(() => boolean) | null>(null);
  const newChatTabRef = useRef<((reuseEmpty?: boolean) => void) | null>(null);
  const pendingChatTabs = useRef(0);
  useEffect(
    () =>
      window.desktopBridge.on("window:closeRequest", () => {
        if (closeChatTabRef.current?.()) return;
        void gmailApi.closeMainWindow();
      }),
    [],
  );

  /** Moves the mail to `to`, from where it is (or was, under Settings). */
  const go = (to: Partial<MailLoc>, replace = false) => {
    if (!mailLoc) return;
    const next = { ...mailLoc, ...to };
    const params = { mailbox: next.mailbox, label: next.label };
    // Opening and closing a floating reader keeps the inbox at its current scroll offset.
    const resetScroll =
      !floatingLayout ||
      !!settingsRoute ||
      next.mailbox !== mailLoc.mailbox ||
      next.label !== mailLoc.label;
    if (!next.messageId) {
      void navigate({ to: "/$mailbox/$label", params, replace, resetScroll });
      return;
    }
    void navigate({
      to: "/$mailbox/$label/$messageId",
      params: { ...params, messageId: next.messageId },
      search: {
        account: next.account && next.account !== next.mailbox ? next.account : undefined,
        message: next.focusId ?? undefined,
      },
      replace,
      resetScroll,
    });
  };
  const closeMessage = () => go({ messageId: null });
  /** Puts the mail right where it is; under Settings, where Back returns to. */
  const correct = (to: Partial<MailLoc>) => {
    if (routeLoc) go(to, true);
    else if (lastMail) setLastMail({ ...lastMail, ...to });
  };

  // Back to the mail Settings was opened over.
  const leaveSettings = () => {
    if (mailLoc) go({});
    else void navigate({ to: "/" });
  };
  const settingsRouteRef = useLatest(settingsRoute);
  const leaveSettingsRef = useLatest(leaveSettings);
  // Escape leaves settings (blurring a focused field first, like a dialog).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !settingsRouteRef.current) return;
      if (isTypingTarget(e)) {
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      e.preventDefault();
      leaveSettingsRef.current();
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, [leaveSettingsRef, settingsRouteRef]);

  // The space showing (spaces.ts); none until the mailboxes are known.
  const space = selectedAccountId
    ? spaceOf(selectedAccountId, { accounts, views, combined: mailboxes.combined })
    : null;
  const isCombined = space?.kind === "combined";
  const isProjects = space?.kind === "projects";
  const mailLayout = useMailLayout();
  // Projects keep their overview beside the conversation list.
  const fullInbox = mailLayout === "full" && !isProjects;
  const floatingLayout = mailLayout === "floating" && !isProjects;
  const wideInbox = fullInbox || floatingLayout;
  const [mailWorkspace, setMailWorkspace] = useState<HTMLDivElement | null>(null);
  // A view's space: its list, with no sidebar.
  const viewSpace = space?.kind === "view" ? space.view : null;
  const spansMailboxes = spanning(space);
  const selectedProject = useProject(isProjects ? selectedLabelId : null);
  const projectsQuery = useProjects();
  const projectsLoaded = projectsQuery.isSuccess;

  const globalSync = useGlobalSyncStatus(accountIds);
  useGmailWriteFailureToasts();
  useExternalMailChanges();
  useBrowserEvents();

  const {
    width: sidebarWidth,
    start: sidebarStart,
    paneRef: sidebarPaneRef,
    frameRef: sidebarFrameRef,
  } = useStoredWidth("gmail:pane:sidebar", 200, 180, 400);
  const {
    width: listWidth,
    start: listStart,
    paneRef: listPaneRef,
  } = useStoredWidth("gmail:pane:list", 340, 280, 640);
  // The chat can grow wide, as long as the reader keeps READER_MIN_WIDTH.
  const {
    width: chatWidth,
    start: chatStart,
    paneRef: chatPaneRef,
    frameRef: chatFrameRef,
  } = useStoredWidth(
    "gmail:pane:chat",
    340,
    280,
    1200,
    -1,
    () =>
      window.innerWidth -
      RAIL_WIDTH -
      (sidebarOpen ? sidebarWidth : 0) -
      (wideInbox ? 0 : listWidth) -
      READER_MIN_WIDTH,
  );
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem("gmail:chat-open") === "1");
  // Mail and Settings are separate spaces: each keeps its sidebar open or
  // closed on its own, and the toggle acts on the one showing.
  const [mailSidebarOpen, setMailSidebarOpen] = useState(
    () => localStorage.getItem("gmail:sidebar-open") !== "0",
  );
  const [settingsSidebarOpen, setSettingsSidebarOpen] = useState(
    () => localStorage.getItem("gmail:settings-sidebar-open") !== "0",
  );
  // A view's space has no sidebar: only its list.
  const sidebarOpen = settingsRoute ? settingsSidebarOpen : mailSidebarOpen && !viewSpace;
  // Entering or leaving Settings swaps panes in place rather than animating them.
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings(settingsRoute ? "settings" : "mail");
  const chatVisible = chatOpen && !settingsRoute;
  useEffect(() => {
    if (!chatVisible || !newChatTabRef.current) return;
    while (pendingChatTabs.current > 0) {
      pendingChatTabs.current--;
      newChatTabRef.current(false);
    }
  }, [chatVisible]);
  const sidebarPresent = usePanelPresence(
    sidebarOpen,
    panelAnimationsActive,
    panelAnimationDurationMs,
  );
  const chatPresent = usePanelPresence(
    chatVisible,
    panelAnimationsActive,
    panelAnimationDurationMs,
  );
  const toggleSidebar = () => {
    const [key, setOpen] = settingsRoute
      ? ["gmail:settings-sidebar-open", setSettingsSidebarOpen]
      : ["gmail:sidebar-open", setMailSidebarOpen];
    setOpen((open) => {
      localStorage.setItem(key, open ? "0" : "1");
      return !open;
    });
  };
  // Rows multi-selected in the list, surfaced to the chat panel's context chip.
  const [chatSelection, setChatSelection] = useState<GmailMessageSummary[]>([]);
  const toggleChat = () => {
    if (chatOpen) closeChat();
    else openPanel();
  };
  const closeChat = () => {
    localStorage.setItem("gmail:chat-open", "0");
    setChatOpen(false);
    setPendingQuote(null);
  };
  const openChat = () => {
    localStorage.setItem("gmail:chat-open", "1");
    setChatOpen(true);
  };
  const openPanel = () => {
    const browser = useBrowser.getState();
    if (features.browser && !browser.activeId) {
      const page = browser.tabs.at(-1);
      if (page) selectTab(page.id);
      else newTab();
    }
    openChat();
  };
  // The panel can fill the window (the mail hides) until it closes, or mail
  // asks for the window: a new message, a conversation opened from elsewhere.
  const [chatExpanded, setChatExpanded] = useState(false);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Synchronize pane and composer state with route, notification and navigation events.
    if (!chatOpen || composeOpen) setChatExpanded(false);
  }, [chatOpen, composeOpen]);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Opening a message returns the expanded panel to the mail view.
    if (selectedMessageId) setChatExpanded(false);
  }, [selectedMessageId]);
  const panelExpanded = chatExpanded && chatVisible;
  const toggleChatExpanded = () => {
    if (settingsRouteRef.current) leaveSettingsRef.current();
    if (!chatVisible) openPanel();
    setChatExpanded((expanded) => (chatVisible ? !expanded : true));
  };
  // A page opening in the browser (a link, ⌘T) shows in the panel, out of Settings.
  const browserRevealed = useBrowser((s) => s.revealed);
  const openChatForEffect = useLatest(openChat);
  useEffect(() => {
    if (!browserRevealed) return;
    if (settingsRouteRef.current) leaveSettingsRef.current();
    openChatForEffect.current();
  }, [browserRevealed, leaveSettingsRef, openChatForEffect, settingsRouteRef]);
  // Getting started. A device whose mail was already here skips the setup,
  // and is offered the tour, once.
  useEffect(() => {
    if (accountsQuery.isLoading || accounts.length === 0 || getSetupStage()) return;
    markSetUp();
    offerTour();
  }, [accountsQuery.isLoading, accounts.length]);
  // The tour walks the mail view: out of Settings and the composer, with the sidebar showing.
  const tourRequested = useTourRequested();
  useEffect(() => {
    if (!tourRequested) return;
    if (settingsRouteRef.current) leaveSettingsRef.current();
    // oxlint-disable-next-line react/set-state-in-effect -- Synchronize pane and composer state with route, notification and navigation events.
    setComposeOpen(false);
    localStorage.setItem("gmail:sidebar-open", "1");
    setMailSidebarOpen(true);
  }, [tourRequested, leaveSettingsRef, settingsRouteRef]);

  // A highlighted excerpt handed from the reader to the chat panel (one-shot).
  const [pendingQuote, setPendingQuote] = useState<QuoteContext | null>(null);

  // MessageList fills this each render; reader archive/trash advance through it.
  const advanceRef = useRef<(fromMessageId: string) => boolean>(() => false);
  const handleReaderAdvance = () => {
    if (!selectedMessageId || !advanceRef.current(selectedMessageId)) closeMessage();
  };

  const searchRef = useRef<HTMLInputElement>(null);

  // ⌘1 = Combined mailbox, ⌘2…⌘9 = accounts in rail order. The ref is
  // populated below once handleSelectAccount exists.
  const accountSwitchRef = useRef<{
    ids: string[];
    combined: boolean;
    select: (id: string) => void;
  }>({ ids: [], combined: false, select: () => {} });

  const undoModifyMessage = useModifyMessage();
  const undoModifyThread = useModifyThread();
  const undoUntrashThread = useUntrashThread();
  const undoUntrashMessage = useUntrashMessage();
  const redoTrashThread = useTrashThread();
  const redoTrashMessage = useTrashMessage();
  const undoRunner = useRef<(action: UndoAction) => void>(() => {});
  const redoRunner = useRef<() => boolean>(() => false);
  // An undo runs quietly (quietParams: no undo or toast of its own). A redo is
  // the action again: it registers its undo and shows its toast, so a bulk
  // redo regroups to announce itself once.
  const runAction = (action: UndoAction, quiet: boolean): Promise<unknown> => {
    const params = <T extends object>(p: T) => (quiet ? quietParams(p) : p);
    switch (action.kind) {
      case "modifyMessage":
        return undoModifyMessage.mutateAsync(params(action.params));
      case "modifyThread":
        return undoModifyThread.mutateAsync(params(action.params));
      case "untrashThread":
        return undoUntrashThread.mutateAsync(params(action.params));
      case "untrashMessage":
        return undoUntrashMessage.mutateAsync(params(action.params));
      case "trashThread":
        return redoTrashThread.mutateAsync(params(action.params));
      case "trashMessage":
        return redoTrashMessage.mutateAsync(params(action.params));
      case "callback":
        action.run();
        return Promise.resolve();
      case "batch":
        if (!quiet) beginUndoGroup(action.actions.length);
        return Promise.all(action.actions.map((a) => runAction(a, quiet)));
    }
  };
  // ⌘Z / ⇧⌘Z (Edit › Undo and Redo in the app menu): text undo while typing,
  // else the mail action, like z and ⇧Z.
  useEffect(() => {
    const onEdit = (native: "edit:nativeUndo" | "edit:nativeRedo", run: () => void) => () => {
      const context = keybindingContext();
      if (context.editableFocus) {
        void window.desktopBridge.invoke(native);
        return;
      }
      if (context.dialogOpen) return;
      run();
    };
    const offUndo = window.desktopBridge.on(
      "edit:undo",
      onEdit("edit:nativeUndo", () => {
        const action = takeUndo();
        if (action) undoRunner.current(action);
      }),
    );
    const offRedo = window.desktopBridge.on(
      "edit:redo",
      onEdit("edit:nativeRedo", () => redoRunner.current()),
    );
    return () => {
      offUndo();
      offRedo();
    };
  }, []);
  // Each action's toast, stacked; undoing an action (z or its Undo) closes it.
  const actionToasts = useRef(new Map<UndoAction, ToastId>());
  useLayoutEffect(() => {
    undoRunner.current = (action) => {
      console.log("[HomeView:undo]", {
        kind: action.kind,
        count: action.kind === "batch" ? action.actions.length : 1,
      });
      const toastId = actionToasts.current.get(action);
      if (toastId) toast.close(toastId);
      actionToasts.current.delete(action);
      runAction(action, true).then(
        () => {
          registerRedo(action);
          // Callbacks (e.g. holding back a send) say what happened themselves.
          if (action.kind !== "callback") toast.success("Undone");
        },
        () => toast.error("Could not undo"),
      );
    };
  });
  useLayoutEffect(() => {
    redoRunner.current = () => {
      const action = takeRedo();
      if (!action) return false;
      console.log("[HomeView:redo]", {
        kind: action.kind,
        count: action.kind === "batch" ? action.actions.length : 1,
      });
      runAction(action, false).catch(() => toast.error("Could not redo"));
      return true;
    };
  });
  useEffect(
    () =>
      onUndoableAction((title, action) => {
        // This toast undoes this action only, whatever came after it.
        const toastId = toast.success(title, {
          action: {
            label: "Undo",
            onClick: () => {
              if (!takeUndo(action)) {
                actionToasts.current.delete(action);
                toast.info("That can no longer be undone");
                return;
              }
              undoRunner.current(action);
            },
          },
          onRemove: () => actionToasts.current.delete(action),
        });
        actionToasts.current.set(action, toastId);
      }),
    [],
  );

  // Keyboard commands (Settings › Keybindings; defaults in keybindings/commands.ts).
  useKeybindingDispatcher();
  useKeybindingContext("settingsOpen", settingsRoute !== null);
  useKeybindingContext("panelExpanded", panelExpanded);
  useKeybindingContext("messageOpen", selectedMessageId !== null);
  const goTo = (combinedViewId: string, labelId: string) => {
    // From Projects or a view, to the first mailbox's.
    const mailbox =
      isProjects || viewSpace
        ? mailboxes.combined
          ? COMBINED_ACCOUNT_ID
          : firstRealAccountId
        : selectedAccountId;
    if (!mailbox) return;
    go({
      mailbox,
      label: mailbox === COMBINED_ACCOUNT_ID ? combinedViewId : labelId,
      messageId: null,
    });
  };
  const jumpToMailbox = (digit: number) => {
    const { ids, combined, select } = accountSwitchRef.current;
    // ⌘1 = All mailboxes when it's on, then the accounts in sidebar order.
    const target = combined ? (digit === 1 ? COMBINED_ACCOUNT_ID : ids[digit - 2]) : ids[digit - 1];
    if (!target) return false;
    select(target);
  };
  useCommandHandlers({
    "commandPalette.toggle": () => setPaletteOpen((o) => !o),
    "sidebar.toggle": () => toggleSidebar(),
    "agent.toggle": () => toggleChat(),
    "agent.toggleExpanded": () => toggleChatExpanded(),
    "agent.newTab": () => {
      if (features.browser) {
        newTab();
        return;
      }
      if (chatVisible && newChatTabRef.current) newChatTabRef.current(false);
      else pendingChatTabs.current++;
      if (settingsRouteRef.current) leaveSettingsRef.current();
      openChat();
    },
    "search.focus": () => searchFromView(),
    "compose.new": () => setComposeOpen(true),
    "keybindings.show": () => openSettings({ pane: "keybindings" }),
    "mail.undo": () => {
      const action = takeUndo();
      if (!action) return false;
      undoRunner.current(action);
    },
    "mail.redo": () => redoRunner.current(),
    "go.inbox": () => goTo(INBOX_VIEW_ID, "INBOX"),
    "go.sent": () => goTo(SENT_VIEW_ID, "SENT"),
    "go.starred": () => goTo(STARRED_VIEW_ID, "STARRED"),
    "go.drafts": () => goTo(DRAFTS_VIEW_ID, "DRAFT"),
    "go.allMail": () => goTo(ALL_MAIL_VIEW_ID, ALL_MAIL_LABEL_ID),
    "message.close": () => closeMessage(),
    ...Object.fromEntries(
      MAILBOX_JUMP_COMMANDS.map((command, i) => [command, () => jumpToMailbox(i + 1)]),
    ),
  });

  // A window opened on no place in particular (the index route) goes to the
  // last one, once accounts are known.
  const onIndex = !routeLoc && !settingsRoute;
  const hasMail = mailLoc !== null;
  const goForEffect = useLatest(go);
  useEffect(() => {
    if (onIndex && hasMail) goForEffect.current({}, true);
  }, [onIndex, hasMail, goForEffect]);

  // Persist where the user is so we can reopen here next launch.
  useEffect(() => {
    if (!initialized || !selectedAccountId) return;
    // The Search mailbox isn't a place to reopen into.
    if (selectedLabelId === SEARCH_MAILBOX) return;
    saveLastLocation({ accountId: selectedAccountId, labelId: selectedLabelId });
  }, [initialized, selectedAccountId, selectedLabelId]);

  // ⌘[ / ⌘] (the menu accelerators, main.ts "Go"; a DOM keydown never
  // arrives for them because the webview consumes it) and the mouse's
  // back/forward buttons move through the window's history. A browser does
  // all of this itself.
  useEffect(() => {
    const back = () => {
      // Never back out of the app, to the page before it.
      if (!router.history.canGoBack()) return;
      console.log("[HomeView:navBack]");
      router.history.back();
    };
    const forward = () => {
      console.log("[HomeView:navForward]");
      router.history.forward();
    };
    const unsubBack = window.desktopBridge.on("nav:back", back);
    const unsubForward = window.desktopBridge.on("nav:forward", forward);
    const mouse = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        back();
      } else if (e.button === 4) {
        e.preventDefault();
        forward();
      }
    };
    const handlesMouse = window.desktopBridge.platform !== "web";
    if (handlesMouse) window.addEventListener("mouseup", mouse);
    return () => {
      unsubBack();
      unsubForward();
      if (handlesMouse) window.removeEventListener("mouseup", mouse);
    };
  }, [router]);

  // mailto: links (default mail app): pull the pending target on mount (cold
  // start) and whenever the backend broadcasts one, then open the composer
  // prefilled.
  useEffect(() => {
    const pull = async () => {
      const target = await gmailApi.takePendingMailto();
      if (!target) return;
      console.log("[HomeView:mailto]", { to: target.to });
      setMailtoPrefill(target);
      setMailtoSeq((n) => n + 1);
      setComposeOpen(true);
    };
    void pull();
    const unsub = window.desktopBridge.on("compose:mailto", () => void pull());
    return unsub;
  }, []);

  // A conversation clicked in a new-mail notification opens here, in the
  // reader (once there's mail to open it in, when it started the app).
  const [openFromNotification, setOpenFromNotification] = useState<{
    accountId: string;
    messageId: string;
  } | null>(null);
  useEffect(() => {
    const pull = async () => {
      const target = await gmailApi.takePendingOpenMessage().catch(() => null);
      if (!target) return;
      console.log("[HomeView:openFromNotification]", { messageId: target.messageId });
      setOpenFromNotification(target);
    };
    void pull();
    return window.desktopBridge.on("mail:open", () => void pull());
  }, []);

  const effectiveAccountId = space?.id ?? firstRealAccountId;

  // If the selected view disappears (deleted, or it has no rules for the
  // active account), fall back to Inbox.
  const correctForEffect = useLatest(correct);
  /* oxlint-disable react/exhaustive-effect-dependencies -- Explicit DOM and reset triggers must re-run this lifecycle. */
  useEffect(() => {
    if (!initialized || !viewsLoaded || selectedLabelId === SEARCH_MAILBOX) return;
    // A project deleted (here or elsewhere): all of them.
    if (isProjects) {
      if (projectsLoaded && selectedLabelId !== ALL_PROJECTS && !selectedProject)
        correctForEffect.current({ label: ALL_PROJECTS, messageId: null });
      return;
    }
    if (viewSpace) {
      if (selectedLabelId !== VIEW_LIST) correctForEffect.current({ label: VIEW_LIST });
      return;
    }
    // A view as a label (views were once in each mailbox): its own space.
    const view = views.find((v) => v.id === selectedLabelId);
    if (view?.kind === "custom") {
      correctForEffect.current({ mailbox: view.id, label: VIEW_LIST });
      return;
    }
    if (isCombined && !view) correctForEffect.current({ label: INBOX_VIEW_ID });
  }, [
    initialized,
    viewsLoaded,
    isCombined,
    views,
    selectedLabelId,
    effectiveAccountId,
    isProjects,
    projectsLoaded,
    selectedProject,
    viewSpace,
    correctForEffect,
  ]);
  /* oxlint-enable react/exhaustive-effect-dependencies */

  // Local-first: keep the on-disk cache synced in the background. Combined mode
  // refreshes all accounts via its own list handler (sentinel isn't a real account).
  useAccountSync(spansMailboxes ? null : effectiveAccountId);

  // Per-account branding: the primary (send, unread dot, focus ring) and the
  // accent take the active account's color; selection surfaces stay
  // neutral (Combined keeps the default blue). Set on the document root so
  // portaled dialogs/menus rebrand too; inline properties win over the
  // injected theme rule.
  const brandAccount = isCombined
    ? null
    : (accounts.find((a) => a.id === effectiveAccountId) ?? null);
  // Monochrome themes (Codex) keep their own primary.
  const monochrome = useMonochromeTheme();
  const brand = brandAccount && !monochrome ? getAccountColor(brandAccount) : null;
  useEffect(() => {
    const root = document.documentElement.style;
    const props = ["--accent", "--accent-contrast", "--primary", "--primary-foreground", "--ring"];
    if (!brand) {
      for (const p of props) root.removeProperty(p);
      return;
    }
    const contrast = getAccountContrastColor(brand);
    root.setProperty("--accent", brand);
    root.setProperty("--accent-contrast", contrast);
    root.setProperty("--primary", brand);
    root.setProperty("--primary-foreground", contrast);
    root.setProperty("--ring", brand);
  }, [brand]);

  // Resolve the selected view to concrete per-account rules. Projects list
  // their conversations like a combined view (every mailbox's), without rules.
  const combined = (() => {
    if (isProjects) {
      return {
        viewId: `projects:${selectedLabelId}`,
        name: selectedProject?.name ?? "All projects",
        rules: [],
      };
    }
    if (viewSpace) {
      return {
        viewId: viewSpace.id,
        name: viewSpace.name,
        rules: resolveRules(viewSpace, accounts),
      };
    }
    if (isCombined) {
      const view = views.find((v) => v.id === selectedLabelId) ?? views[0];
      return {
        viewId: view?.id ?? INBOX_VIEW_ID,
        name: view?.name ?? "Inbox",
        rules: view ? resolveRules(view, accounts) : [],
      };
    }
    return null;
  })();

  const handleSelectAccount = (accountId: string) => {
    console.log("[HomeView:selectAccount]", { accountId });
    setComposeOpen(false);
    go({ mailbox: accountId, label: firstLabelOf(accountId), messageId: null });
  };
  useLayoutEffect(() => {
    accountSwitchRef.current = {
      ids: accountIds,
      combined: mailboxes.combined,
      select: handleSelectAccount,
    };
  });

  // The route's mailbox was turned off (or "All mailboxes" was), or isn't
  // there: the route catches up with what shows instead.
  const misplaced = ready && !!routeLoc && routeLoc.mailbox !== mailLoc?.mailbox;
  const goForAccountEffect = useLatest(go);
  useEffect(() => {
    if (!misplaced) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Synchronize pane and composer state with route, notification and navigation events.
    setComposeOpen(false);
    goForAccountEffect.current({}, true);
  }, [misplaced, goForAccountEffect]);

  const handleSelectLabel = (labelId: string) => {
    console.log("[HomeView:selectLabel]", { labelId });
    setComposeOpen(false);
    go({ label: labelId, messageId: null });
  };

  // Peeking at another space's sidebar from the rail (space-peek.tsx): only
  // while the sidebar is collapsed (or a view's space has none).
  const spacePeek = useSpacePeek();
  const peekSpace = spacePeek.peek && !sidebarOpen ? spacePeek.peek : null;
  /** Goes to a space (at its first place, or `label`), closing the peek. */
  const goToSpace = (spaceId: string, label?: string) => {
    spacePeek.close();
    if (label === undefined) handleSelectAccount(spaceId);
    else {
      setComposeOpen(false);
      go({ mailbox: spaceId, label, messageId: null, account: null, focusId: null });
    }
  };

  /** The view editor ("new", or a view's id). */
  const openViewEditor = (viewId: string) => {
    console.log("[HomeView:openViewEditor]", { isNew: viewId === "new" });
    spacePeek.close();
    setViewEditor(viewId);
  };

  /** A project's page, with its conversations in the list. */
  const openProject = (id: string) => {
    console.log("[HomeView:openProject]");
    setComposeOpen(false);
    go({ mailbox: PROJECTS_SPACE, label: id, messageId: null, account: null, focusId: null });
  };

  const handleSelectMessage = (
    messageId: string,
    accountId: string,
    focusId?: string,
    options?: { autoFocusDraft?: boolean },
  ) => {
    console.log("[HomeView:selectMessage]", { messageId, accountId, focusId });
    setAutoFocusDraft(options?.autoFocusDraft !== false);
    setComposeOpen(false);
    go({ messageId, account: accountId, focusId: focusId ?? null });
  };

  const queryClient = useQueryClient();
  /** Agent results open in the app; draft ids resolve to their current message. */
  const openChatChange = async ({ target }: ChatChange) => {
    if (target.kind === "project") {
      openProject(target.id);
    } else if (target.kind === "view") {
      goToSpace(target.id, VIEW_LIST);
    } else if (target.kind === "theme") {
      openSettings({ pane: "appearance" });
    } else if (target.kind === "event") {
      if (target.url) openLink(target.url);
    } else if (target.kind === "label") {
      goToSpace(target.accountId, target.id);
    } else {
      let messageId: string;
      if (target.kind === "draft") {
        const version = await gmailApi.getDraftVersion(target.accountId, target.id);
        if (!version.messageId) throw new Error("This draft was sent or deleted.");
        await gmailApi.loadDraftVersion(target.accountId, target.id, version.messageId);
        messageId = version.messageId;
      } else {
        const messages = await gmailApi.getThread(target.accountId, target.id);
        const message = messages.at(-1);
        if (!message) throw new Error("This conversation is no longer available.");
        messageId = message.id;
      }
      void queryClient.invalidateQueries({ queryKey: ["gmail:messages", target.accountId] });
      setComposeOpen(false);
      go({
        mailbox: target.accountId,
        label: target.kind === "draft" ? "DRAFT" : ALL_MAIL_LABEL_ID,
        messageId,
        account: null,
        focusId: null,
      });
    }
  };
  // A send taken back with Undo reopens its draft here (the reader edits drafts).
  const selectMessageRef = useLatest(handleSelectMessage);
  useEffect(
    () =>
      setDraftOpener(({ accountId, messageId }) => {
        void queryClient.invalidateQueries({ queryKey: ["gmail:messages", accountId] });
        void queryClient.invalidateQueries({ queryKey: ["gmail:combinedMessages"] });
        selectMessageRef.current(messageId, accountId);
      }),
    [queryClient, selectMessageRef],
  );

  // ── Search mailbox ───────────────────────────────────────────────────────
  // Search is a mailbox like Inbox: selecting a search row (the top Search
  // row, or one under the view it was started from) shows Gmail's search in
  // the list pane. Escape clears it, then closes it back to where you were.
  const searchActive = selectedLabelId === SEARCH_MAILBOX;
  const searchReturnRef = useRef<string>("INBOX");
  const searchMailbox = selectedAccountId ?? "";
  const topSearchId = searchTabId(searchMailbox, null);
  const activeSearch = searchActive
    ? (searchTabs.find((t) => t.id === activeSearchId) ?? null)
    : null;
  const patchSearch = (id: string, patch: Partial<SearchTab>) =>
    setSearchTabs((tabs) => tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  // Where a new search looks by default: the mailbox you started it from.
  const defaultScope = (): string[] =>
    spansMailboxes || !effectiveAccountId
      ? combined && selectedLabelId !== SEARCH_MAILBOX
        ? [...new Set(combined.rules.map((r) => r.accountId))]
        : accountIds
      : [effectiveAccountId];
  const focusSearchEnd = () =>
    setTimeout(() => {
      const input = searchRef.current;
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  const showSearch = (id: string) => {
    if (!searchActive) searchReturnRef.current = selectedLabelId;
    setComposeOpen(false);
    setActiveSearchId(id);
    go({ label: SEARCH_MAILBOX, messageId: null });
  };
  /** The top Search row (all mail), optionally running `q`. */
  const openSearch = (q?: string) => {
    console.log("[HomeView:openSearch]", { hasQuery: Boolean(q) });
    setSearchTabs((tabs) => {
      const existing = tabs.find((t) => t.id === topSearchId);
      if (existing)
        return q === undefined
          ? tabs
          : tabs.map((t) => (t.id === topSearchId ? { ...t, query: q, draft: q } : t));
      return [
        ...tabs,
        {
          id: topSearchId,
          mailbox: searchMailbox,
          parent: null,
          base: "",
          query: q ?? "",
          draft: q ?? "",
          scope: defaultScope(),
        },
      ];
    });
    showSearch(topSearchId);
    // Focus once the header has mounted (no query: ready to type).
    if (!q) focusSearchEnd();
  };
  // ⌘F / the list's search icon: the view's own search row, opened under it
  // with its operators prefilled (`in:inbox `) and the cursor after them.
  // Already in a search, it just focuses the bar.
  const viewQueryRef = useRef("");
  const searchFromView = () => {
    if (searchActive && !settingsRoute) {
      searchRef.current?.focus();
      return;
    }
    const base = viewQueryRef.current;
    if (!base) return openSearch();
    const id = searchTabId(searchMailbox, selectedLabelId);
    console.log("[HomeView:searchFromView]", { base });
    setSearchTabs((tabs) =>
      tabs.some((t) => t.id === id)
        ? tabs
        : [
            ...tabs,
            {
              id,
              mailbox: searchMailbox,
              parent: selectedLabelId,
              base,
              query: "",
              draft: `${base} `,
              scope: defaultScope(),
            },
          ],
    );
    showSearch(id);
    focusSearchEnd();
  };
  const runSearch = (q: string) => {
    const tab = activeSearch;
    if (!tab) return openSearch(q);
    // Dropping the view's operators makes it a search of all mail: it moves
    // up to the top Search row.
    if (tab.parent && !q.includes(tab.base)) {
      console.log("[HomeView:searchLeavesView]");
      setSearchTabs((tabs) => [
        ...tabs.filter((t) => t.id !== tab.id && t.id !== topSearchId),
        { ...tab, id: topSearchId, parent: null, base: "", query: q, draft: q },
      ]);
      setActiveSearchId(topSearchId);
      return;
    }
    patchSearch(tab.id, { query: q, draft: q });
  };
  const closeSearch = (id: string) => {
    const tab = searchTabs.find((t) => t.id === id);
    console.log("[HomeView:closeSearch]", { child: Boolean(tab?.parent) });
    setSearchTabs((tabs) => tabs.filter((t) => t.id !== id));
    if (searchActive && activeSearchId === id) {
      go({ label: tab?.parent ?? searchReturnRef.current, messageId: null });
    }
  };
  const handleSearchChange = (q: string) => openSearch(q);
  // Back/forward (or a reload) into a search that was since closed: the top
  // Search row. Only on arriving: closing the open search leaves it at once.
  const openSearchForEffect = useLatest(openSearch);
  useEffect(() => {
    if (searchActive && !activeSearch) openSearchForEffect.current();
  }, [searchActive, activeSearch, openSearchForEffect]);

  // Palette mail result: jump to the owning account (Combined stays put) and open.
  const handlePaletteOpenMessage = (message: GmailMessageSummary) => {
    console.log("[HomeView:paletteOpenMessage]", {
      messageId: message.id,
      accountId: message.accountId,
    });
    const owner = message.accountId ?? firstRealAccountId;
    if (!owner) return;
    openMessage(owner, message.id);
  };

  /** Opens a message of `owner`'s where it is: Combined stays put, another account's inbox opens. */
  const openMessage = (owner: string, messageId: string) => {
    const switching = !spansMailboxes && owner !== effectiveAccountId;
    setAutoFocusDraft(true);
    go({
      ...(switching ? { mailbox: owner, label: "INBOX" } : {}),
      messageId,
      account: owner,
      focusId: null,
    });
  };
  const openMessageForEffect = useLatest(openMessage);
  useEffect(() => {
    if (!openFromNotification || !hasMail) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Synchronize pane and composer state with route, notification and navigation events.
    setOpenFromNotification(null);
    setComposeOpen(false);
    openMessageForEffect.current(openFromNotification.accountId, openFromNotification.messageId);
  }, [openFromNotification, hasMail, openMessageForEffect]);

  const handlePaletteGoToView = (viewId: string) => {
    console.log("[HomeView:paletteGoToView]", { viewId });
    go({ mailbox: COMBINED_ACCOUNT_ID, label: viewId, messageId: null });
  };

  // Manual refresh: spin from the click until every account's sync settles
  // (any phase — the passive indicator only shows long full/body syncs), and
  // for at least a beat so a fast incremental sync still reads as feedback.
  const [manualSyncing, setManualSyncing] = useState(false);
  const syncNow = () => {
    if (manualSyncing) return;
    console.log("[HomeView:syncNow]");
    setManualSyncing(true);
    const startedAt = Date.now();
    void (async () => {
      try {
        await Promise.all(accountIds.map((id) => gmailApi.syncAccount(id).catch(() => null)));
        for (let i = 0; i < 150; i++) {
          const statuses = await Promise.all(
            accountIds.map((id) => gmailApi.getSyncStatus(id).catch(() => null)),
          );
          if (!statuses.some((st) => st?.syncing)) break;
          await new Promise((r) => setTimeout(r, 400));
        }
      } finally {
        const remaining = 700 - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
        setManualSyncing(false);
      }
    })();
  };
  // ⌘R (Mailbox › Sync Now in the app menu) is the same manual refresh.
  const syncNowRef = useLatest(syncNow);
  useEffect(
    () => window.desktopBridge.on("mail:syncNow", () => syncNowRef.current()),
    [syncNowRef],
  );

  // From a view, the first of the mailboxes it draws on.
  const composeAccountId = viewSpace
    ? (combined?.rules[0]?.accountId ?? firstRealAccountId)
    : spansMailboxes
      ? firstRealAccountId
      : effectiveAccountId;
  const readerAccount =
    readerAccountId ?? (spansMailboxes ? firstRealAccountId : effectiveAccountId);
  useRecordRecentlyViewed({
    ready: initialized,
    href: router.state.location.href,
    settingsPane: settingsRoute?.pane ?? null,
    mailbox: selectedAccountId,
    label: selectedLabelId,
    messageId: selectedMessageId,
    readerAccount,
    accounts,
    views,
  });
  // Without a project yet, Projects is only its overview (which says how to start one).
  const hasListTarget =
    (isCombined || effectiveAccountId != null) && !(isProjects && projectsQuery.data?.length === 0);
  const showMain =
    !!settingsRoute ||
    !wideInbox ||
    !hasListTarget ||
    (fullInbox && !!selectedMessageId) ||
    composeOpen;
  const listVisible = hasListTarget && !settingsRoute && (!wideInbox || !showMain);

  // Full-height columns: each pane owns its slice of the title band (on the
  // chrome); the content panel is painted behind them from under that band.
  // With a conversation open, its header is the title band (subject, actions
  // and the panel toggle in one row) instead of an empty band above it.
  const readerOwnsBand =
    !settingsRoute && !(composeOpen && composeAccountId) && !!readerAccount && !!selectedMessageId;
  const titleTrailing = <TitleTrailing showPanelToggle={!chatOpen && !settingsRoute} />;
  // A view's space has no sidebar to toggle.
  const sidebarToggle = !(viewSpace && !settingsRoute);
  const titlebarInset = <TitlebarInset toggle={sidebarToggle} />;
  const readerLeading = fullInbox ? (
    <>
      {sidebarOpen ? null : titlebarInset}
      <HintTooltip label="Back to message list" shortcut="message.close">
        <IconBtn label="Back to message list" onClick={closeMessage}>
          <ArrowLeftIcon className="size-4" />
        </IconBtn>
      </HintTooltip>
    </>
  ) : undefined;
  const renderReader = (
    leading: ReactNode = readerLeading,
    trailing: ReactNode = titleTrailing,
  ) => (
    <MessageReader
      titleLeading={leading}
      titleTrailing={trailing}
      accountId={readerAccount ?? ""}
      messageId={focusedMessageId ?? selectedMessageId}
      autoFocusDraft={autoFocusDraft}
      single={focusedMessageId != null}
      onShowConversation={() => go({ focusId: null })}
      onDeselect={closeMessage}
      onAdvance={handleReaderAdvance}
      onOpenChat={openChat}
      onQuote={(q) => {
        if (chatOpen) setPendingQuote(q);
      }}
      onComposeTo={(email) => {
        setMailtoPrefill({ to: email, cc: "", subject: "", body: "" });
        setMailtoSeq((n) => n + 1);
        setComposeOpen(true);
      }}
      onSearchSender={(email) => handleSearchChange(`from:${email}`)}
      onOpenProject={openProject}
    />
  );
  // With the sidebar hidden and no list pane, this band is the first after the
  // rail: it needs the traffic-light clearance and the toggle to bring the
  // sidebar (and Settings' Back button) back.
  const mainIsLeftmost = !sidebarOpen && !listVisible;
  const titleControls = (
    <TitleControls
      leading={mainIsLeftmost ? titlebarInset : null}
      syncing={globalSync.syncing}
      syncLabel={globalSync.label}
      // Room for the pinned panel toggle while the panel is closed; when
      // open, the panel's header keeps it. Settings has no panel.
      showPanelToggle={!chatOpen && !settingsRoute}
    />
  );
  return (
    <>
      <div
        className={cn(
          "surface-grain flex h-full text-foreground",
          // The Mac window is frosted glass (its vibrancy): the frame lets it
          // through, more so as Glass opacity goes down.
          features.vibrancy ? "bg-sidebar-surface/(--frame-opacity)" : "bg-sidebar-surface",
        )}
        data-panel-animations={panelAnimationsActive ? "true" : "false"}
        data-mail-layout={isProjects ? "split" : mailLayout}
        style={{ "--panel-animation-duration": `${panelAnimationDurationMs}ms` } as CSSProperties}
      >
        <div className="contents">
          {/* The spaces and the app's menu (ChatGPT's rail): they stay when
              the sidebar hides. */}
          <SpaceRail
            accounts={accounts}
            views={viewSpaces}
            onNewView={() => openViewEditor("new")}
            onEditView={openViewEditor}
            onHoverSpace={sidebarOpen ? undefined : spacePeek.hover}
            selectedSpaceId={effectiveAccountId}
            onSelectSpace={handleSelectAccount}
            settingsOpen={settingsRoute !== null}
            onOpenSettings={(pane = lastPaneRef.current) => openSettings({ pane })}
            onSync={syncNow}
            syncing={globalSync.syncing || manualSyncing}
          />
          {/* A thin margin of frame on every free side (ChatGPT), so the panel
              floats with all four corners rounded. A browser tab has no window
              to frame: there the panel fills the page beside the rail, title
              bands and all, rounded only against the rail. */}
          <div className="relative isolate flex min-w-0 flex-1 pb-1 pr-1 web:p-0">
            {/* The inset content panel, behind the panes and under their title bands. */}
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-1 left-0 right-1 top-(--workspace-topbar-height) -z-10 rounded-xl bg-canvas web:inset-y-0 web:right-0 web:rounded-r-none"
            />
            {/* The rim stays above sticky day headers and the panes' surfaces. */}
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-1 left-0 right-1 top-(--workspace-topbar-height) z-30 rounded-xl border border-(--panel-edge) web:inset-y-0 web:right-0 web:rounded-r-none web:border-y-0 web:border-r-0"
            />
            <div
              ref={setMailWorkspace}
              data-mail-workspace=""
              className={cn("relative flex min-h-0 min-w-0 flex-1", panelExpanded && "hidden")}
            >
              {peekSpace ? (
                <SpacePeekCard
                  key={peekSpace}
                  width={sidebarWidth}
                  onHover={(inside) => spacePeek.hover(inside ? peekSpace : null)}
                >
                  {peekSpace === PROJECTS_SPACE ? (
                    <ProjectsSidebar
                      selectedLabelId={isProjects ? selectedLabelId : ""}
                      onSelectLabel={(label) => goToSpace(PROJECTS_SPACE, label)}
                      searchSelected={false}
                      searchPending={false}
                      onOpenSearch={() => goToSpace(PROJECTS_SPACE)}
                    />
                  ) : (
                    <MailboxSidebarPage
                      selectedAccountId={peekSpace}
                      onSelectAccount={(id) => goToSpace(id)}
                      selectedLabelId={peekSpace === effectiveAccountId ? selectedLabelId : ""}
                      onSelectLabel={(label) => goToSpace(peekSpace, label)}
                      views={views}
                      onCompose={() => {
                        spacePeek.close();
                        setComposeOpen(true);
                      }}
                      searchSelected={false}
                      searchPending={false}
                      onOpenSearch={() => goToSpace(peekSpace)}
                      searches={[]}
                      onSelectSearch={() => {}}
                      onCloseSearch={() => {}}
                    />
                  )}
                </SpacePeekCard>
              ) : null}
              {sidebarPresent ? (
                <>
                  <div
                    ref={sidebarFrameRef}
                    style={{ width: sidebarOpen ? sidebarWidth : 0 }}
                    className={cn(
                      PANE_FRAME,
                      // Anchored left: the sidebar stays put while the columns
                      // after it slide over it, and back out.
                      sidebarOpen && "[[data-panel-animations=true]_&]:starting:w-0!",
                      !sidebarOpen && "pointer-events-none",
                    )}
                  >
                    <div
                      ref={sidebarPaneRef}
                      style={{ width: sidebarWidth }}
                      className={`${PANE_SIDEBAR} flex shrink-0 flex-col`}
                      data-app-sidebar=""
                    >
                      {settingsRoute ? (
                        <>
                          <SidebarTitle />
                          <SettingsNav
                            pane={settingsRoute.pane}
                            onSelect={(pane, target) => openSettings({ pane, target })}
                            onBack={leaveSettings}
                          />
                        </>
                      ) : isProjects ? (
                        <>
                          <SidebarTitle />
                          <ProjectsSidebar
                            selectedLabelId={selectedLabelId}
                            onSelectLabel={handleSelectLabel}
                            searchSelected={activeSearch?.id === topSearchId}
                            searchPending={Boolean(
                              searchTabs.find((t) => t.id === topSearchId)?.draft.trim(),
                            )}
                            onOpenSearch={() => openSearch()}
                          />
                          <UpdateCard />
                        </>
                      ) : viewSpace ? null : (
                        <AccountsSidebar
                          selectedAccountId={effectiveAccountId}
                          onSelectAccount={handleSelectAccount}
                          selectedLabelId={selectedLabelId}
                          onSelectLabel={handleSelectLabel}
                          views={views}
                          onCompose={() => setComposeOpen(true)}
                          searchSelected={activeSearch?.id === topSearchId}
                          searchPending={Boolean(
                            searchTabs.find((t) => t.id === topSearchId)?.draft.trim(),
                          )}
                          searches={searchTabs
                            .filter((t) => t.mailbox === searchMailbox && t.parent)
                            .map((t) => ({
                              id: t.id,
                              parent: t.parent!,
                              title: searchTitle(t),
                              selected: activeSearch?.id === t.id,
                            }))}
                          onSelectSearch={(id) => {
                            showSearch(id);
                            focusSearchEnd();
                          }}
                          onCloseSearch={closeSearch}
                          onOpenSearch={() => openSearch()}
                        />
                      )}
                    </div>
                  </div>
                  {sidebarOpen ? <PaneResizer onPointerDown={sidebarStart} /> : null}
                </>
              ) : null}
              <div className="relative flex min-h-0 min-w-0 flex-1">
                {hasListTarget && !settingsRoute ? (
                  <>
                    {/* Keep the list mounted while reading in Full inbox: its
                    scroll position, selection and next-message shortcuts stay. */}
                    <div
                      ref={listPaneRef}
                      style={{ width: wideInbox ? undefined : listWidth }}
                      className={cn(
                        wideInbox ? `${PANE} min-w-0 flex-1` : `${PANE_LIST} shrink-0`,
                        !listVisible && "invisible absolute inset-0",
                      )}
                      inert={!listVisible}
                      data-tour="list"
                    >
                      <MessageList
                        headerLeading={sidebarOpen ? null : titlebarInset}
                        headerTrailing={wideInbox ? titleTrailing : undefined}
                        roundedLeft={!sidebarOpen}
                        roundedRight={wideInbox && !chatOpen}
                        renderFloatingReader={
                          floatingLayout && !composeOpen
                            ? (navigation, title) => (
                                <FloatingReader
                                  container={mailWorkspace}
                                  messageId={selectedMessageId ?? ""}
                                  title={title}
                                  navigation={navigation}
                                  onClose={closeMessage}
                                >
                                  {renderReader(null, null)}
                                </FloatingReader>
                              )
                            : undefined
                        }
                        accountId={(spansMailboxes ? firstRealAccountId : effectiveAccountId) ?? ""}
                        labelId={selectedLabelId}
                        combined={combined}
                        accountIds={accountIds}
                        accounts={accounts}
                        selectedMessageId={selectedMessageId}
                        focusedMessageId={focusedMessageId}
                        onSelectMessage={handleSelectMessage}
                        onDeselect={closeMessage}
                        advanceRef={advanceRef}
                        onSelectionChange={setChatSelection}
                        onOpenChat={openChat}
                        onSearchView={searchFromView}
                        viewQueryRef={viewQueryRef}
                        project={isProjects && !activeSearch ? { id: selectedLabelId } : undefined}
                        search={
                          activeSearch
                            ? {
                                id: activeSearch.id,
                                query: activeSearch.query,
                                base: activeSearch.base,
                                accountIds: activeSearch.scope,
                                onSearch: runSearch,
                                onClear: () => {
                                  const base = activeSearch.base ? `${activeSearch.base} ` : "";
                                  patchSearch(activeSearch.id, { query: "", draft: base });
                                  focusSearchEnd();
                                },
                                onExit: () => closeSearch(activeSearch.id),
                                onScope: (scope) => patchSearch(activeSearch.id, { scope }),
                                focusRef: searchRef,
                                draft: activeSearch.draft,
                                onDraftChange: (draft) => patchSearch(activeSearch.id, { draft }),
                                messageOpen: selectedMessageId !== null,
                              }
                            : undefined
                        }
                      />
                    </div>
                    {wideInbox ? null : <PaneResizer onPointerDown={listStart} />}
                  </>
                ) : null}
                <div
                  className={cn(
                    `${PANE_MAIN} min-w-0 flex-1 flex-col`,
                    showMain ? "flex" : "hidden",
                  )}
                  data-tour={showMain ? "reader" : undefined}
                >
                  {readerOwnsBand ? null : titleControls}
                  <div className="flex min-h-0 flex-1 flex-col">
                    {settingsRoute ? (
                      <SettingsPage route={settingsRoute} onNavigate={openSettings} />
                    ) : composeOpen && composeAccountId ? (
                      <NewMessageView
                        key={mailtoSeq}
                        accounts={accounts}
                        defaultAccountId={composeAccountId}
                        onClose={() => {
                          setComposeOpen(false);
                          setMailtoPrefill(null);
                        }}
                        prefill={mailtoPrefill ?? undefined}
                      />
                    ) : isProjects && !selectedMessageId && !searchActive ? (
                      selectedProject ? (
                        <ProjectView
                          project={selectedProject}
                          onOpenMessage={(accountId, messageId) =>
                            handleSelectMessage(messageId, accountId)
                          }
                          onAskAgent={openChat}
                          onDeleted={() => handleSelectLabel(ALL_PROJECTS)}
                        />
                      ) : (
                        <ProjectsOverview onOpenProject={openProject} />
                      )
                    ) : readerAccount ? (
                      showMain ? (
                        renderReader()
                      ) : null
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <EmptyState
                          title="No account selected"
                          description="Select a mailbox from the sidebar."
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
            {chatPresent ? (
              <>
                {chatVisible && !panelExpanded ? <PaneResizer onPointerDown={chatStart} /> : null}
                <div
                  ref={chatFrameRef}
                  data-tour="agent"
                  style={{ width: panelExpanded ? undefined : chatVisible ? chatWidth : 0 }}
                  className={cn(
                    PANE_FRAME,
                    panelExpanded && "flex-1",
                    chatVisible && "[[data-panel-animations=true]_&]:starting:w-0!",
                    !chatVisible && "pointer-events-none",
                  )}
                >
                  <div
                    ref={chatPaneRef}
                    style={{ width: panelExpanded ? undefined : chatWidth }}
                    className={cn(PANE_CHAT, panelExpanded ? "flex-1 before:hidden" : "shrink-0")}
                  >
                    <AgentChatPanel
                      expanded={panelExpanded}
                      onToggleExpanded={toggleChatExpanded}
                      onOpenChange={openChatChange}
                      closeTabRef={closeChatTabRef}
                      newTabRef={newChatTabRef}
                      onClosePanel={closeChat}
                      accountId={selectedMessageId ? readerAccount : null}
                      messageId={selectedMessageId}
                      selectedRows={chatSelection}
                      quote={pendingQuote}
                      onClearQuote={() => setPendingQuote(null)}
                      project={
                        selectedProject && !searchActive
                          ? { id: selectedProject.id, name: selectedProject.name }
                          : null
                      }
                    />
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Pinned titlebar toggles (Otter Code): same window spot whatever the panes do. */}
      {!sidebarToggle || panelExpanded ? null : (
        <SidebarControl sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
      )}
      {!settingsRoute ? (
        <PanelControl
          open={chatOpen}
          onToggle={() => {
            if (chatOpen) setPendingQuote(null);
            toggleChat();
          }}
        />
      ) : null}

      {tourRequested && initialized ? (
        <Tour
          actions={{
            agentOpen: chatOpen,
            setAgentOpen: (open) => (open ? openChat() : closeChat()),
            openMessage: () => {
              if (selectedMessageId) return;
              // A read one where there is one: opening marks a conversation read.
              const row =
                document.querySelector<HTMLElement>(
                  "[data-message-row]:not([data-draft]):not([data-unread])",
                ) ?? document.querySelector<HTMLElement>("[data-message-row]:not([data-draft])");
              row?.click();
            },
          }}
          onClose={endTour}
        />
      ) : null}

      <TodoistDialogs />
      <NewProjectDialog onOpenProject={openProject} />
      <ViewEditorDialog
        key={viewEditor ?? "closed"}
        open={viewEditor !== null}
        view={views.find((v) => v.id === viewEditor) ?? null}
        accounts={accountsQuery.data ?? []}
        // A new view opens in its space once saved.
        onSave={(input) =>
          saveView(input).then((saved) => {
            if (!input.id) handleSelectAccount(saved.id);
          })
        }
        onDelete={deleteView}
        onReset={resetView}
        onClose={() => setViewEditor(null)}
      />

      {accounts.length > 0 ? (
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          accounts={accounts}
          views={views}
          selectedAccountId={effectiveAccountId}
          onOpenMessage={handlePaletteOpenMessage}
          onSearchMail={(q) => openSearch(q)}
          onGoToView={handlePaletteGoToView}
          onSelectAccount={handleSelectAccount}
          onOpenProject={openProject}
          onCompose={() => setComposeOpen(true)}
          onOpenSettings={(pane = lastPaneRef.current) => openSettings({ pane })}
          onNewView={() => openViewEditor("new")}
          onToggleChat={toggleChat}
          onToggleSidebar={toggleSidebar}
          onSync={syncNow}
        />
      ) : null}
    </>
  );
}
