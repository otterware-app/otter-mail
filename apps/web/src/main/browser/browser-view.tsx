import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CodeIcon,
  CopyIcon,
  GlobeIcon,
  LoaderCircleIcon,
  LockIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PuzzleIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { gmailApi } from "../gmail/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../gmail/menu";
import { toast } from "../gmail/toast";
import { Btn, HintTooltip, IconBtn, cn } from "../gmail/ui";
import { ExtensionToolbar } from "./extension-toolbar";
import {
  CHROME_WEB_STORE_URL,
  addressToUrl,
  closeTab,
  hostOf,
  openTab,
  selectTab,
  updateTab,
  useBrowser,
  type BrowserTab,
} from "./store";
import { shortcutText } from "../keybindings/keys";

/** Electron's `<webview>`, the parts used here. */
type Webview = HTMLElement & {
  getWebContentsId(): number;
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  openDevTools(): void;
};

/** The main process lets tabs into this session only (apps/desktop/src/services/browser.ts). */
const PARTITION = "persist:browser";

/**
 * Where a page that isn't showing waits: off to the side, still paintable. A
 * macOS webview hidden outright can come back blank (Otter Code's
 * HostedBrowserWebview), and moving it keeps its size, so nothing reflows.
 */
const OFFSCREEN: CSSProperties = { transform: "translateX(-100000px)", pointerEvents: "none" };

const SUGGESTED = [
  { name: "Google", url: "https://www.google.com/" },
  { name: "YouTube", url: "https://www.youtube.com/" },
  { name: "Otter Drive", url: "https://drive.otterware.app/" },
  { name: "Chrome Web Store", url: CHROME_WEB_STORE_URL },
];

function faviconFor(url: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(url))}&sz=64`;
}

export function BrowserTabIcon({ tab }: { tab: BrowserTab }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (tab.loading) return <LoaderCircleIcon className="size-3.5 animate-spin" />;
  if (tab.favicon && failed !== tab.favicon) {
    return (
      <img
        src={tab.favicon}
        alt=""
        draggable={false}
        className="size-3.5 rounded-[3px]"
        onError={() => setFailed(tab.favicon)}
      />
    );
  }
  return <GlobeIcon className="size-3.5" />;
}

/**
 * The browser's pages, over the chat (which stays mounted underneath, its
 * turns streaming) while one of its tabs shows. A tab's page loads the first
 * time it shows and then stays alive, waiting offscreen while another shows.
 */
export function BrowserPages({ onNewChat }: { onNewChat: () => void }) {
  const tabs = useBrowser((s) => s.tabs);
  const activeId = useBrowser((s) => s.activeId);
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  if (activeId && !shown.has(activeId)) setShown(new Set(shown).add(activeId));
  return (
    <div
      className="absolute inset-x-0 bottom-0 top-(--workspace-topbar-height) z-10 overflow-hidden rounded-t-xl bg-canvas"
      style={activeId ? undefined : OFFSCREEN}
    >
      {tabs.map((tab) =>
        shown.has(tab.id) ? (
          <div
            key={tab.id}
            className="absolute inset-0 flex flex-col"
            style={tab.id === activeId ? undefined : OFFSCREEN}
          >
            <BrowserPage tab={tab} active={tab.id === activeId} onNewChat={onNewChat} />
          </div>
        ) : null,
      )}
    </div>
  );
}

function BrowserPage({
  tab,
  active,
  onNewChat,
}: {
  tab: BrowserTab;
  active: boolean;
  onNewChat: () => void;
}) {
  const [view, setView] = useState<Webview | null>(null);
  // The page's webContents id once it's attached: its tab id, to extensions.
  const [pageId, setPageId] = useState<number | null>(null);
  // The address the page opens at; later ones go through loadURL (a new src
  // attribute would load the page over again).
  const [src, setSrc] = useState(tab.url);
  const [history, setHistory] = useState({ back: false, forward: false });
  const [failure, setFailure] = useState<string | null>(null);
  const [crashed, setCrashed] = useState(false);
  const addressRequest = useBrowser((s) =>
    s.addressFocus?.tabId === tab.id ? s.addressFocus.seq : 0,
  );

  useEffect(() => {
    if (!view) return;
    let ready = false;
    // The page last shown: Chromium only reports a favicon that changed, so
    // the tab drops its icon only for another site's page.
    let shown = "";
    const sync = () => {
      if (ready) setHistory({ back: view.canGoBack(), forward: view.canGoForward() });
    };
    const on: Record<string, (event: Event & Record<string, unknown>) => void> = {
      "dom-ready": () => {
        ready = true;
        setPageId(view.getWebContentsId());
        sync();
      },
      "did-start-loading": () => {
        setFailure(null);
        setCrashed(false);
        updateTab(tab.id, { loading: true });
      },
      "did-stop-loading": () => {
        updateTab(tab.id, { loading: false });
        sync();
      },
      "did-navigate": (e) => {
        const url = e.url as string;
        const otherSite = hostOf(shown) !== hostOf(url);
        shown = url;
        updateTab(tab.id, otherSite ? { url, title: hostOf(url), favicon: null } : { url });
        sync();
      },
      "did-navigate-in-page": (e) => {
        if (!e.isMainFrame) return;
        updateTab(tab.id, { url: e.url as string });
        sync();
      },
      "page-title-updated": (e) => updateTab(tab.id, { title: e.title as string }),
      "page-favicon-updated": (e) =>
        updateTab(tab.id, { favicon: (e.favicons as string[])[0] ?? null }),
      "did-fail-load": (e) => {
        // -3 is a load given up for another (a click before the page finished).
        if (!e.isMainFrame || e.errorCode === -3) return;
        setFailure((e.errorDescription as string) || "The page couldn't load.");
      },
      "render-process-gone": () => {
        setCrashed(true);
        updateTab(tab.id, { loading: false });
      },
    };
    for (const [name, listener] of Object.entries(on)) {
      view.addEventListener(name, listener as EventListener);
    }
    return () => {
      for (const [name, listener] of Object.entries(on)) {
        view.removeEventListener(name, listener as EventListener);
      }
      // Gone mid-load (the panel closed): no spinner left in its tab.
      updateTab(tab.id, { loading: false });
    };
  }, [view, tab.id]);

  // Extensions see the page showing as the active tab, and can show or close one.
  useEffect(() => {
    if (active && pageId !== null) void window.desktopBridge.invoke("browser:activeTab", pageId);
  }, [active, pageId]);
  useEffect(() => {
    if (pageId === null) return;
    const mine = (params: unknown) =>
      (params as { webContentsId?: number }).webContentsId === pageId;
    const offs = [
      window.desktopBridge.on("browser:selectTab", (params) => {
        if (mine(params)) selectTab(tab.id);
      }),
      window.desktopBridge.on("browser:closeTab", (params) => {
        if (mine(params)) closeTab(tab.id);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [pageId, tab.id]);

  const navigate = (url: string) => {
    updateTab(tab.id, { url });
    if (view) void view.loadURL(url).catch(() => {});
    else setSrc(url);
  };

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <div className="flex shrink-0 items-center rounded-full bg-foreground/[0.06] p-0.5">
          <HintTooltip label="Back" hint={shortcutText("mod+[")} side="bottom">
            <IconBtn
              label="Back"
              className="rounded-full"
              disabled={!history.back}
              onClick={() => view?.goBack()}
            >
              <ArrowLeftIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
          <HintTooltip label="Forward" hint={shortcutText("mod+]")} side="bottom">
            <IconBtn
              label="Forward"
              className="rounded-full"
              disabled={!history.forward}
              onClick={() => view?.goForward()}
            >
              <ArrowRightIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          {tab.loading ? (
            <HintTooltip label="Stop" side="bottom">
              <IconBtn label="Stop" className="rounded-full" onClick={() => view?.stop()}>
                <XIcon className="size-4" />
              </IconBtn>
            </HintTooltip>
          ) : (
            <HintTooltip label="Reload" hint={shortcutText("mod+r")} side="bottom">
              <IconBtn
                label="Reload"
                className="rounded-full"
                disabled={!view}
                onClick={() => view?.reload()}
              >
                <RotateCwIcon className="size-4" />
              </IconBtn>
            </HintTooltip>
          )}
        </div>
        <AddressBar
          url={tab.url}
          focusRequest={addressRequest}
          onNavigate={navigate}
          onSiteDataCleared={() => view?.reload()}
        />
        {src ? <ExtensionToolbar /> : null}
        <PageMenu url={tab.url} onDevTools={view ? () => view.openDevTools() : undefined} />
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {src ? (
          <webview
            ref={(node) => setView(node as Webview | null)}
            src={src}
            partition={PARTITION}
            // An attribute Electron reads as the page attaches; React drops a
            // boolean for it, so it's the string.
            {...({ allowpopups: "true" } as unknown as { allowpopups?: boolean })}
            className="flex min-h-0 flex-1 bg-white"
          />
        ) : (
          <StartPage
            onNavigate={navigate}
            // The chat takes the start page's place, as a site would.
            onNewChat={() => {
              closeTab(tab.id);
              onNewChat();
            }}
          />
        )}
        {failure || crashed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas p-6 text-center">
            <TriangleAlertIcon className="mb-1 size-6 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              {crashed ? "This page crashed" : "This page couldn't load"}
            </p>
            {failure && !crashed ? (
              <p className="max-w-80 text-[13px] text-muted-foreground">{failure}</p>
            ) : null}
            <Btn size="sm" className="mt-2" onClick={() => view?.reload()}>
              {crashed ? "Reload" : "Try again"}
            </Btn>
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * The address pill (ChatGPT's): the site's name, centered; the whole address
 * to edit once focused, where text that isn't an address searches Google.
 * Hovering it offers the site's info and opening it in the default browser.
 */
function AddressBar({
  url,
  focusRequest,
  onNavigate,
  onSiteDataCleared,
}: {
  url: string;
  /** Changes when ⌘L asks for this address bar. */
  focusRequest: number;
  onNavigate: (url: string) => void;
  onSiteDataCleared: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // What's typed, while editing.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (focusRequest) inputRef.current?.focus();
  }, [focusRequest]);
  const editing = draft !== null;
  const origin = URL.parse(url)?.origin;
  return (
    <div className="group/address relative mx-auto flex h-8 min-w-0 max-w-[56rem] flex-1 items-center rounded-full bg-foreground/[0.06] focus-within:bg-foreground/[0.09] hover:bg-foreground/[0.09]">
      <input
        ref={inputRef}
        aria-label="Address"
        placeholder="Search or enter a URL"
        // A new tab starts at its address bar.
        autoFocus={!url}
        spellCheck={false}
        autoComplete="off"
        value={editing ? draft : url ? hostOf(url) : ""}
        onFocus={(e) => {
          setDraft(url);
          const input = e.currentTarget;
          requestAnimationFrame(() => input.select());
        }}
        onBlur={() => setDraft(null)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Enter") {
            const next = addressToUrl(draft ?? "");
            if (!next) return;
            onNavigate(next);
            e.currentTarget.blur();
          }
        }}
        className={cn(
          "h-full min-w-0 flex-1 bg-transparent px-9 text-sm text-foreground outline-none placeholder:text-muted-foreground",
          editing ? "text-left" : "text-center",
        )}
      />
      {origin && origin !== "null" && !editing ? (
        <>
          <SiteInfo url={url} origin={origin} onCleared={onSiteDataCleared} />
          <HintTooltip label="Open in default browser" side="bottom">
            <IconBtn
              label="Open in default browser"
              className="absolute right-0.5 rounded-full opacity-0 group-hover/address:opacity-100 focus-visible:opacity-100"
              onClick={() => void window.desktopBridge.openExternal(url).catch(() => {})}
            >
              <ArrowUpRightIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
        </>
      ) : null}
    </div>
  );
}

/** "View site information": is the connection private, and clearing what the site keeps. */
function SiteInfo({
  url,
  origin,
  onCleared,
}: {
  url: string;
  origin: string;
  onCleared: () => void;
}) {
  const secure = url.startsWith("https:");
  const clear = async () => {
    try {
      await window.desktopBridge.invoke("browser:clearData", { origin });
      toast.success(`Cleared ${hostOf(url)}'s cookies and data`);
      onCleared();
    } catch (error) {
      toast.error(`Couldn't clear the site's data: ${error}`);
    }
  };
  return (
    <DropdownMenu>
      <HintTooltip label="View site information" side="bottom">
        <DropdownMenuTrigger asChild>
          <IconBtn
            label="View site information"
            className="absolute left-0.5 rounded-full opacity-0 group-hover/address:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <SlidersHorizontalIcon className="size-4" />
          </IconBtn>
        </DropdownMenuTrigger>
      </HintTooltip>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="truncate">{hostOf(url)}</DropdownMenuLabel>
        <p className="flex items-center gap-2 px-2.5 pb-2 text-[13px] text-muted-foreground">
          {secure ? (
            <LockIcon className="size-3.5 shrink-0" />
          ) : (
            <TriangleAlertIcon className="size-3.5 shrink-0" />
          )}
          {secure ? "Connection is secure" : "Not secure: what you send here can be read"}
        </p>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void clear()}>
          Clear cookies and site data
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PageMenu({ url, onDevTools }: { url: string; onDevTools?: () => void }) {
  return (
    <DropdownMenu>
      <HintTooltip label="More" side="bottom">
        <DropdownMenuTrigger asChild>
          <IconBtn label="More" className="size-8 shrink-0 rounded-full">
            <MoreHorizontalIcon className="size-4" />
          </IconBtn>
        </DropdownMenuTrigger>
      </HintTooltip>
      <DropdownMenuContent align="end" className="w-56">
        {url ? (
          <>
            <DropdownMenuItem
              icon={<ArrowUpRightIcon className="size-4" />}
              onSelect={() => void window.desktopBridge.openExternal(url).catch(() => {})}
            >
              Open in Default Browser
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<CopyIcon className="size-4" />}
              onSelect={() => void navigator.clipboard.writeText(url)}
            >
              Copy Link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          icon={<PuzzleIcon className="size-4" />}
          onSelect={() => void gmailApi.openSettings({ pane: "browser" })}
        >
          Extensions
        </DropdownMenuItem>
        {onDevTools ? (
          <DropdownMenuItem icon={<CodeIcon className="size-4" />} onSelect={onDevTools}>
            Developer Tools
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A new tab's page (ChatGPT's): the panel's other tools, then places to start. */
function StartPage({
  onNavigate,
  onNewChat,
}: {
  onNavigate: (url: string) => void;
  onNewChat: () => void;
}) {
  const tile =
    "flex cursor-pointer items-center gap-2.5 rounded-xl bg-foreground/[0.04] px-4 py-3 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-focus-ring [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-8">
        <h2 className="text-sm font-medium text-foreground">Tools</h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
          <button type="button" className={tile} onClick={onNewChat}>
            <MessageSquareIcon />
            New chat
          </button>
          <button
            type="button"
            className={tile}
            onClick={() => void gmailApi.openSettings({ pane: "browser" })}
          >
            <PuzzleIcon />
            Extensions
          </button>
        </div>
        <h2 className="mt-5 text-sm font-medium text-foreground">Suggested</h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
          {SUGGESTED.map((site) => (
            <button
              key={site.url}
              type="button"
              onClick={() => onNavigate(site.url)}
              onAuxClick={(e) => {
                if (e.button === 1) openTab(site.url, { background: true });
              }}
              className="flex cursor-pointer flex-col items-center gap-3 rounded-xl px-2 py-4 text-sm text-foreground outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <img src={faviconFor(site.url)} alt="" className="size-8 rounded-md" />
              <span className="truncate">{site.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
