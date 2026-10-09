import { withOccurrenceKeys } from "./list-keys";
import { useLatest } from "../use-latest";
import { ListTodoIcon } from "lucide-react";
import { addEmailToTodoist } from "../integrations/todoist";
import { SnoozeButton } from "./mail-schedule";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Popover } from "radix-ui";
import { Dialog } from "~/components/ui/dialog";
import { EmptyState } from "~/components/ui/empty-state";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Text } from "~/components/ui/text";
import { sendWithUndo } from "./undo-send";
import { toast } from "./toast";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArchiveXIcon,
  MousePointer2Icon,
  ChevronDownIcon,
  DownloadIcon,
  EllipsisIcon,
  FlagIcon,
  FolderIcon,
  ForwardIcon,
  ImageIcon,
  LanguagesIcon,
  PaperclipIcon,
  MailIcon,
  MailOpenIcon,
  MailWarningIcon,
  ReplyAllIcon,
  ReplyIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
  ListIcon,
} from "lucide-react";
import { SenderHoverCard } from "./sender-hovercard";
import { UnsubscribeLink } from "./unsubscribe-link";
import {
  ConversationTranslationContext,
  useIsForeignMessage,
  useMessageTranslation,
} from "./translate-banner";
import {
  INTERFACE_FONT_SIZE,
  MARK_READ_DELAY,
  useInterfaceSetting,
} from "../theme/interface-settings";
import { useTranslationSettings } from "./translation";
import { InviteCard, requestRsvp, rsvpFromGoogleLink } from "./invite-card";
import type { RsvpResponse } from "./api";
import {
  useAccounts,
  useMessage,
  useThread,
  useModifyMessage,
  useTrashMessage,
  useModifyThread,
  useTrashThread,
  useUntrashThread,
  useUntrashMessage,
  useDeleteThreadsForever,
  useGetAttachment,
  useLabels,
  useSendMessage,
} from "./hooks";
import { gmailApi } from "./api";
import { CategoryChip, InboxChip, LabelChip, ProjectChip, isCategoryLabelId } from "./label-chip";
import { projectsApi, useProjects } from "./projects";
import { AddToProjectItems } from "./project-menus";
import { SenderAvatar } from "./sender-avatar";
import { ConversationSummary } from "./conversation-summary";
import {
  CcBccToggles,
  ComposerCard,
  ComposerField,
  ComposerFooter,
  DraftRemoteBanner,
  draftStatus,
} from "./composer-kit";
import { decodeEntities, htmlToText } from "./text";
import { LabelPickerMenu, LabelSubmenu } from "./label-picker-menu";
import { useCapabilities } from "./capabilities";
import {
  formatAddressEntry,
  normalizeAddressList,
  parseAddressEntry,
  senderLabel,
  splitAddressList,
} from "./address";
import { useCommandHandlers } from "../keybindings/dispatch";
import { useShortcutLabel } from "../keybindings/store";
import { IconBtn, HintTooltip, buttonClass, cn } from "./ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuTrigger,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "./menu";
import { RichTextArea, textToHtml, type RichTextRef } from "./rich-text";
import { RecipientInput } from "./recipient-input";
import {
  AttachmentChips,
  ComposeDropOverlay,
  attachmentSignature,
  filesToComposeAttachments,
  pickComposeAttachments,
  useComposeFileDrop,
  autosaveDelayMs,
  loadMessageAttachments,
} from "./compose-attachments";
import type { QuoteContext } from "./chat-context";
import { DraftEditor } from "./draft-editor";
import { useDraftAutosave } from "./use-draft-autosave";
import type {
  ComposeAttachment,
  GmailLabel,
  GmailMessageDetail,
  GmailMessageSummary,
} from "./types";
import { features } from "../features";
import { openLink } from "../browser/store";
import { AttachmentPreview, attachmentPreview, type PreviewFile } from "./attachment-preview";
import { isModClick } from "../keybindings/keys";

type MessageReaderProps = {
  accountId: string;
  messageId: string | null;
  /** Browsing the list previews drafts without taking focus from navigation. */
  autoFocusDraft?: boolean;
  /** Show only this message, not its whole conversation (picked from an
      expanded conversation in the list); actions then apply to it alone. */
  single?: boolean;
  /** Leaves `single` mode for the whole conversation. */
  onShowConversation?: () => void;
  /** Clears the selection (drafts return to the list after send/discard). */
  onDeselect?: () => void;
  /** Toolbar archive/trash move on to the next conversation through this. */
  onAdvance?: () => void;
  /** Opens the in-app agent chat panel (this conversation becomes its context). */
  onOpenChat?: () => void;
  /** A selected excerpt was sent to the chat panel as a quote. */
  onQuote?: (quote: QuoteContext) => void;
  /** Sender hover-card quick actions. */
  onComposeTo?: (email: string) => void;
  onSearchSender?: (email: string) => void;
  /** Right end of the window's title band (panel toggle), drawn in this header. */
  titleTrailing?: ReactNode;
  /** Navigation at the start of the title band (full inbox layout). */
  titleLeading?: ReactNode;
  /** Opens a project the conversation is in (its chip). */
  onOpenProject?: (projectId: string) => void;
};

export type DownloadAttachment = (
  messageId: string,
  attachmentId: string,
  filename: string,
  mimeType: string,
) => void;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatFullDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Day-divider label: Today, Yesterday, weekday, or a date. */
function formatDayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return date.toLocaleDateString([], { weekday: "long" });
  return date.toLocaleDateString([], {
    month: "long",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

export function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * The email canvas is always light (HTML mail is designed for white), but in
 * a dark-appearance window the iframe document inherits dark UA defaults —
 * default text renders WHITE on our white card. This prelude pins the
 * document to light rendering and sane typography; email-supplied CSS comes
 * after it and still wins.
 */
const messageBodyPrelude = (fontSize: number) => `<style>
:root { color-scheme: light; }
body {
  margin: 10px;
  background: #ffffff;
  color: #1f1f1f;
  font-family: -apple-system, system-ui, Helvetica, Arial, sans-serif;
  font-size: ${fontSize}px;
  line-height: 1.45;
  word-break: break-word;
}
a { color: #e34500; }
blockquote { border-left: 3px solid #d6d6d6; padding-left: 12px; margin: 4px 0; color: #555555; }
</style>`;

/**
 * Dark-appearance canvas, the Apple Mail approach: the email sits on the
 * message card itself (transparent page, light default text) and only parts
 * that paint their own background keep their original look (see
 * `adaptForDarkCanvas`). Email-supplied CSS still comes after and wins.
 */
const messageBodyPreludeDark = (fontSize: number) => `<style>
:root { color-scheme: dark; }
html, body { background: transparent; }
body {
  margin: 0;
  color: #e6e6e6;
  font-family: -apple-system, system-ui, Helvetica, Arial, sans-serif;
  font-size: ${fontSize}px;
  line-height: 1.45;
  word-break: break-word;
}
a { color: #7cacf8; }
blockquote { border-left: 3px solid #3a3a3a; padding-left: 12px; margin: 4px 0; color: #a3a3a3; }
hr { border: none; border-top: 1px solid #333333; }
</style>`;

/** RGB → HSL (0–1 ranges). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn
      ? (gn - bn) / d + (gn < bn ? 6 : 0)
      : max === gn
        ? (bn - rn) / d + 2
        : (rn - gn) / d + 4;
  return [h / 6, s, l];
}

/**
 * On the dark canvas, text the email colored dark (black body copy, navy
 * links, grey footers) would vanish. Only where such text sits directly on
 * the canvas — no background of its own anywhere up its ancestry — flip its
 * lightness (hue kept, so links stay blue and accents stay recognizable).
 * Anything inside an element that paints a background or background image is
 * a designed "island" (a white invite card, a newsletter body) and is left
 * exactly as the sender styled it.
 */
function adaptForDarkCanvas(doc: Document | null | undefined) {
  if (!doc?.body) return;
  const onCanvas = (start: Element): boolean => {
    let node: Element | null = start;
    while (node && node !== doc.documentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") return false;
      const bg = parseRgb(style.backgroundColor);
      if (bg && bg.a > 0.05) return false;
      node = node.parentElement;
    }
    return true;
  };
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const element = node as HTMLElement;
    const hasOwnText = Array.from(element.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0,
    );
    if (!hasOwnText) continue;
    const color = parseRgb(getComputedStyle(element).color);
    if (!color || color.a < 0.05) continue;
    if (relativeLuminance(color.r, color.g, color.b) >= 0.18) continue; // already readable
    if (!onCanvas(element)) continue;
    const [h, sat, l] = rgbToHsl(color.r, color.g, color.b);
    const lightness = Math.min(0.9, Math.max(0.72, 1 - l));
    const hsl = `hsl(${Math.round(h * 360)} ${Math.round(sat * 85)}% ${Math.round(lightness * 100)}%)`;
    element.style.setProperty("color", hsl, "important");
  }
}

/**
 * Dark mode honors the email's own dark styles, but many only half-apply:
 * LinkedIn's turn paragraph text light grey while the card behind it keeps
 * its white background. Where text sits on a light background the email
 * painted itself and is barely readable (contrast under 3:1), make it dark.
 */
function fixLightOnLightText(doc: Document | null | undefined) {
  if (!doc?.body) return;
  /** Luminance of the nearest painted background; null over the dark canvas or an image. */
  const paintedBg = (start: Element): number | null => {
    let node: Element | null = start;
    while (node && node !== doc.documentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") return null;
      const bg = parseRgb(style.backgroundColor);
      if (bg && bg.a > 0.5) return relativeLuminance(bg.r, bg.g, bg.b);
      node = node.parentElement;
    }
    return null;
  };
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const element = node as HTMLElement;
    const hasOwnText = Array.from(element.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0,
    );
    if (!hasOwnText) continue;
    const color = parseRgb(getComputedStyle(element).color);
    if (!color || color.a < 0.05) continue;
    const bg = paintedBg(element);
    if (bg === null || bg < 0.5) continue; // not on a light surface
    const text = relativeLuminance(color.r, color.g, color.b);
    const contrast = (Math.max(text, bg) + 0.05) / (Math.min(text, bg) + 0.05);
    if (contrast >= 3) continue;
    element.style.setProperty("color", "#1f1f1f", "important");
  }
}

/**
 * The email canvas is always white, but the reader's WebView carries the app's
 * dark appearance, so `prefers-color-scheme` evaluates to `dark` INSIDE the
 * iframe (a CSS `color-scheme: light` on :root doesn't change that). Emails that
 * ship a `@media (prefers-color-scheme: dark)` variant then flip their text to
 * white on our white card and become unreadable. Disable only those dark-scheme
 * media rules so the email's light/default styling (dark text) always wins.
 */
function neutralizeDarkScheme(doc: Document | null | undefined) {
  if (!doc) return;
  const isDark = (m: MediaList) => /prefers-color-scheme\s*:\s*dark/i.test(m.mediaText);
  const walk = (rules: CSSRuleList | undefined) => {
    if (!rules) return;
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        if (isDark(rule.media)) {
          try {
            rule.media.mediaText = "not all";
          } catch {
            /* some engines reject reassigning mediaText — ignore */
          }
        } else {
          walk(rule.cssRules);
        }
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      // Whole-sheet media (from `<style media=…>` / `<link media=…>`).
      if (sheet.media && isDark(sheet.media)) sheet.media.mediaText = "not all";
      walk(sheet.cssRules); // throws for cross-origin sheets — caught below
    } catch {
      /* cross-origin or unreadable stylesheet: skip */
    }
  }
}

function relativeLuminance(r: number, g: number, b: number): number {
  const s = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * s(r) + 0.7152 * s(g) + 0.0722 * s(b);
}

function parseRgb(value: string): { r: number; g: number; b: number; a: number } | null {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(",").map((s) => parseFloat(s.trim()));
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b, a };
}

/**
 * Some templates set white text via a mechanism `neutralizeDarkScheme` can't
 * reach — a CSS custom-property fallback baked into the declaration itself
 * (`color: var(--text, #fff)`), or plain unconditional white with no light
 * variant at all. Rather than chase every authoring pattern, directly measure
 * each text-owning element's rendered contrast and force a readable color
 * only where it's actually near-white on a near-white (our forced canvas)
 * background — untouched otherwise, so intentional design colors survive.
 */
function fixWhiteOnWhiteText(doc: Document | null | undefined) {
  if (!doc?.body) return;
  const effectiveBgLuminance = (start: Element): number => {
    let node: Element | null = start;
    while (node && node !== doc.documentElement) {
      const style = getComputedStyle(node);
      // A background image (hero banner, etc.) could be dark under white text
      // legitimately — we can't sample its pixels, so leave the text alone
      // rather than risk turning readable white-on-photo into unreadable
      // dark-on-photo.
      if (style.backgroundImage !== "none") return 0;
      const bg = parseRgb(style.backgroundColor);
      if (bg && bg.a > 0.05) return relativeLuminance(bg.r, bg.g, bg.b);
      node = node.parentElement;
    }
    return 1; // falls through to our forced-white canvas
  };
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  let el: Node | null;
  while ((el = walker.nextNode())) {
    const element = el as HTMLElement;
    const hasOwnText = Array.from(element.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0,
    );
    if (!hasOwnText) continue;
    const color = parseRgb(getComputedStyle(element).color);
    if (!color) continue;
    if (relativeLuminance(color.r, color.g, color.b) < 0.85) continue; // not light text
    if (effectiveBgLuminance(element) < 0.85) continue; // has a dark-enough backdrop
    element.style.setProperty("color", "#1f1f1f", "important");
  }
}

/**
 * HTML mail in an auto-height iframe. The height watchers must NOT hang off the
 * iframe's `load` event: that only fires once every subresource has settled, and
 * marketing mail is full of remote images and tracking pixels that routinely
 * stall it for tens of seconds (observed: 37s) — the iframe would sit at the
 * 150px CSS default, clipped and internally scrollable, the whole time. So watch
 * for the srcdoc document as soon as it is PARSED and fit from there; `load` and
 * the per-image listeners are then just later refinements for late-arriving art.
 */
/** Live dark/light appearance (follows the app's theme setting and the system). */
function useDarkAppearance(): boolean {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/** Containers mail clients wrap the quoted reply history in. */
const QUOTE_SELECTOR = [
  ".gmail_quote",
  "blockquote[type='cite']",
  ".yahoo_quoted",
  "#appendonsend",
  "div[id^='divRplyFwdMsg']",
  "#mail-editor-reference-message-container",
  ".moz-cite-prefix",
].join(",");

/**
 * Finds the quoted history in a rendered email and returns the elements to
 * hide (outermost only, plus a leading "On … wrote:" line and, for Outlook,
 * everything after its reply marker). Nothing is returned when hiding would
 * leave (almost) no readable text.
 */
function findQuotedHistory(doc: Document): HTMLElement[] {
  const body = doc.body;
  if (!body) return [];
  const found = Array.from(doc.querySelectorAll<HTMLElement>(QUOTE_SELECTOR));
  const outer = found.filter((el) => !found.some((o) => o !== el && o.contains(el)));
  if (outer.length === 0) return [];
  const hidden = new Set<HTMLElement>();
  for (const el of outer) {
    hidden.add(el);
    const prev = el.previousElementSibling as HTMLElement | null;
    const prevText = prev?.textContent?.trim() ?? "";
    if (prev && prevText.length < 300 && /wrote:$/i.test(prevText)) hidden.add(prev);
    if (el.id === "appendonsend" || el.id.startsWith("divRplyFwdMsg")) {
      let next = el.nextElementSibling as HTMLElement | null;
      while (next) {
        hidden.add(next);
        next = next.nextElementSibling as HTMLElement | null;
      }
    }
  }
  const quoted = Array.from(hidden).reduce((n, el) => n + (el.textContent?.trim().length ?? 0), 0);
  const total = body.textContent?.trim().length ?? 0;
  return total - quoted >= 20 ? Array.from(hidden) : [];
}

/** "•••" toggle for trimmed quoted history, as in Gmail. */
function QuoteToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <HintTooltip label={open ? "Hide quoted text" : "Show quoted text"}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Hide quoted text" : "Show quoted text"}
        onClick={onToggle}
        className="mt-2 inline-flex h-5 cursor-pointer items-center rounded-full bg-accent-surface px-2 text-muted-foreground outline-none hover:bg-input hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <EllipsisIcon className="size-4" />
      </button>
    </HintTooltip>
  );
}

/** Where an HTML body's `cid:` images come from: the message's inline attachments. */
type InlineImageSource = {
  accountId: string;
  messageId: string;
  /** Lower-cased Content-ID → attachment (see `matchInlineImages`). */
  byCid: Map<string, MessageAttachment>;
};

/**
 * Pairs each `<img src="cid:…">` in the body with the attachment it embeds. By
 * Content-ID when known; details cached before Content-IDs were recorded fall
 * back to the image's alt text (Gmail sets it to the filename), then to the
 * only image attachment when there's exactly one of each.
 */
function matchInlineImages(
  html: string | null,
  attachments: MessageAttachment[],
): Map<string, MessageAttachment> {
  const byCid = new Map<string, MessageAttachment>();
  if (!html || attachments.length === 0) return byCid;
  const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
  const refs: { cid: string; alt: string }[] = [];
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = /\bsrc\s*=\s*["']?cid:([^"'\s>]+)/i.exec(tag)?.[1];
    if (!src) continue;
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    refs.push({ cid: decodeURIComponent(src).toLowerCase(), alt });
  }
  for (const { cid, alt } of refs) {
    const match =
      images.find((a) => a.contentId?.toLowerCase() === cid) ??
      (alt ? images.find((a) => !a.contentId && a.filename === alt) : undefined) ??
      (refs.length === 1 && images.length === 1 && !images[0].contentId ? images[0] : undefined);
    if (match) byCid.set(cid, match);
  }
  return byCid;
}

function HtmlBody({
  html,
  inlineImages,
  onQuoteText,
  inviteMessageId,
}: {
  html: string;
  inlineImages?: InlineImageSource;
  onQuoteText?: (text: string) => void;
  /** A calendar invite: its Yes / No / Maybe links answer in the app. */
  inviteMessageId?: string;
}) {
  // Quoted history is hidden inside the frame; the toggle lives outside it
  // (WKWebView doesn't reliably deliver clicks from the sandboxed frame).
  const quotedRef = useRef<HTMLElement[]>([]);
  const [hasQuote, setHasQuote] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const refitRef = useRef<() => void>(() => {});
  const toggleQuote = () => {
    const show = !quoteOpen;
    for (const el of quotedRef.current) {
      el.style.display = show ? (el.dataset.otterDisplay ?? "") : "none";
    }
    setQuoteOpen(show);
    requestAnimationFrame(() => refitRef.current());
  };
  const frameRef = useRef<HTMLIFrameElement>(null);
  const quoteRef = useLatest(onQuoteText);
  const inlineRef = useLatest(inlineImages);
  const inviteRef = useLatest(inviteMessageId);
  const dark = useDarkAppearance();
  // 15px at a 16px interface (the size the app is drawn at), scaled with it.
  const bodyFontSize = (15 * useInterfaceSetting(INTERFACE_FONT_SIZE)) / 16;
  // Light: white card, email's own dark-mode CSS disabled, white-on-white
  // rescued. Dark: transparent canvas, email's dark CSS honored, dark-on-dark
  // rescued, islands with their own background untouched.
  const adaptColors = (doc: Document | null | undefined) => {
    if (dark) {
      adaptForDarkCanvas(doc);
      fixLightOnLightText(doc);
    } else {
      neutralizeDarkScheme(doc);
      fixWhiteOnWhiteText(doc);
    }
  };

  const adaptColorsForEffect = useLatest(adaptColors);
  /* oxlint-disable react/exhaustive-effect-dependencies -- Explicit DOM and reset triggers must re-run this lifecycle. */
  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe) return;
    let ro: ResizeObserver | null = null;
    let wired: Document | null = null;
    let stopped = false;

    const mountedAt = performance.now();
    let sized = false;
    const fit = () => {
      const h = iframe.contentDocument?.documentElement?.scrollHeight ?? 0;
      if (h <= 0) return;
      iframe.style.height = h + "px";
      if (!sized) {
        sized = true;
        console.log("[MessageBody:sized]", {
          ms: Math.round(performance.now() - mountedAt),
          height: h,
        });
      }
    };

    // Attach to whichever document is in the frame, once it has a body.
    const wire = () => {
      const doc = iframe.contentDocument;
      if (!doc?.body || doc === wired) return;
      wired = doc;
      ro?.disconnect();
      ro = new ResizeObserver(fit);
      ro.observe(doc.body);
      adaptColorsForEffect.current(doc);
      const quoted = findQuotedHistory(doc);
      quotedRef.current = quoted;
      for (const el of quoted) {
        el.dataset.otterDisplay = el.style.display;
        el.style.display = "none";
      }
      setHasQuote(quoted.length > 0);
      setQuoteOpen(false);
      refitRef.current = fit;
      // Some remote images won't load in the iframe — anything served with
      // `Cross-Origin-Resource-Policy: same-origin` (Anthropic/Cloudflare, …) is
      // blocked by WebKit since the frame's origin isn't the image's. Re-fetch
      // those through the backend proxy (no CORP there) and swap in a data URL.
      const proxyBrokenImage = (img: HTMLImageElement) => {
        if (img.dataset.otterProxied) return;
        const src = img.getAttribute("src") ?? "";
        if (!/^https?:/i.test(src)) return;
        // Don't bother proxying 1×1 tracking beacons.
        if (img.getAttribute("width") === "1" && img.getAttribute("height") === "1") return;
        img.dataset.otterProxied = "1";
        void gmailApi
          .proxyImage(src)
          .then((res) => {
            if (!res?.dataUrl) return;
            img.addEventListener("load", fit, { once: true });
            img.src = res.dataUrl;
          })
          .catch(() => {});
      };
      // Inline images point at the message's own attachments (`cid:`), which
      // the frame can't resolve — load the bytes and swap in a data URL.
      doc.querySelectorAll("img").forEach((el) => {
        const img = el as HTMLImageElement;
        const src = img.getAttribute("src") ?? "";
        const source = inlineRef.current;
        if (!/^cid:/i.test(src) || !source) return;
        const attachment = source.byCid.get(decodeURIComponent(src.slice(4)).toLowerCase());
        if (!attachment) return;
        img.dataset.otterProxied = "1";
        void gmailApi
          .getAttachmentData({
            accountId: source.accountId,
            messageId: source.messageId,
            attachmentId: attachment.id,
          })
          .then((data) => {
            img.addEventListener("load", fit, { once: true });
            img.src = `data:${attachment.mimeType};base64,${data.base64}`;
          })
          .catch(() => {});
      });
      doc.querySelectorAll("img").forEach((el) => {
        const img = el as HTMLImageElement;
        if (img.complete) {
          // Already settled: a broken load (naturalWidth 0) is our cue to proxy.
          if (img.naturalWidth === 0 && (img.getAttribute("src") ?? "").length > 0)
            proxyBrokenImage(img);
          return;
        }
        img.addEventListener("load", fit, { once: true });
        img.addEventListener(
          "error",
          () => {
            proxyBrokenImage(img);
            fit();
          },
          { once: true },
        );
      });
      // Open every link in a browser tab (the agent panel's, on the Mac), or
      // mail for mailto:. The sandbox has no `allow-popups`, so
      // `target="_blank"` links (common in marketing mail) otherwise do nothing
      // on a plain click, and a targetless link would navigate the iframe away
      // from the email — route them all through the OS instead.
      // Google Calendar's Yes / No / Maybe links answer in place: they become
      // in-page anchors (#otter-rsvp-…), caught by click or, when the sandbox
      // swallows the click, by the frame's hashchange.
      const inviteId = inviteRef.current;
      if (inviteId) {
        doc.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
          const response = rsvpFromGoogleLink(a.href);
          if (response) a.setAttribute("href", `#otter-rsvp-${response}`);
        });
        iframe.contentWindow?.addEventListener("hashchange", () => {
          const hash = iframe.contentWindow?.location.hash ?? "";
          const m = hash.match(/^#otter-rsvp-(accepted|declined|tentative)$/);
          if (!m) return;
          requestRsvp(inviteId, m[1] as RsvpResponse);
          iframe.contentWindow?.history.replaceState(null, "", " ");
        });
      }
      doc.addEventListener("click", (e) => {
        const anchor = (e.target as Element | null)?.closest?.("a");
        if (!anchor) return;
        const raw = anchor.getAttribute("href") ?? "";
        const rsvp = raw.match(/^#otter-rsvp-(accepted|declined|tentative)$/);
        if (rsvp && inviteRef.current) {
          e.preventDefault();
          requestRsvp(inviteRef.current, rsvp[1] as RsvpResponse);
          return;
        }
        if (raw.startsWith("#")) return; // in-page anchor: let the iframe scroll
        const url = anchor.href; // resolved absolute URL
        if (/^(https?|mailto):/i.test(url)) {
          console.log("[MessageBody:linkClick]", { href: raw.slice(0, 60) });
          e.preventDefault();
          if (/^mailto:/i.test(url)) void window.desktopBridge.openExternal(url).catch(() => {});
          else openLink(url, { flip: isModClick(e) });
        }
      });
      // The click handler above is the fast path, but WKWebView doesn't reliably
      // deliver clicks from a sandboxed iframe to this parent-attached listener
      // (same limitation as `mouseup`, below). `target="_blank"` links then just
      // request a popup the sandbox blocks — nothing navigates, so the host's
      // navigation layer (which already opens plain external links) never sees
      // them. Force every link to navigate in-frame instead so that path fires.
      doc.querySelectorAll("base[target]").forEach((b) => b.removeAttribute("target"));
      doc.querySelectorAll("a[target]").forEach((a) => a.setAttribute("target", "_self"));
      if (quoteRef.current) {
        // WKWebView doesn't reliably deliver `mouseup` from a sandboxed iframe
        // to a parent-attached listener, but `selectionchange` on its document
        // does — report the (final) non-empty selection.
        const report = () => {
          const text = doc.getSelection()?.toString().trim() ?? "";
          if (text) quoteRef.current?.(text);
        };
        doc.addEventListener("mouseup", report);
        doc.addEventListener("selectionchange", report);
      }
      fit();
    };

    // srcdoc parsing is async with no event we can subscribe to before the
    // document exists, so spin on frames until it shows up (1–2 frames)…
    const spin = () => {
      if (stopped) return;
      wire();
      if (!wired) requestAnimationFrame(spin);
    };
    requestAnimationFrame(spin);

    // … then keep re-fitting for a while: CSS background images and web fonts
    // change the height but fire no load event we can hook.
    let ticks = 0;
    const poll = setInterval(() => {
      wire();
      if (ticks < 8) {
        adaptColorsForEffect.current(iframe.contentDocument);
      }
      fit();
      if (++ticks >= 40) clearInterval(poll);
    }, 250);

    const onLoad = () => {
      wire();
      fit();
    };
    iframe.addEventListener("load", onLoad);

    return () => {
      stopped = true;
      clearInterval(poll);
      ro?.disconnect();
      iframe.removeEventListener("load", onLoad);
    };
    // adaptColors only varies with `dark`, which is a dependency; a new font
    // size remounts the frame (its key), which is wired again.
  }, [
    html,
    dark,
    bodyFontSize,
    adaptColorsForEffect,
    inlineRef,
    inviteRef,
    quoteRef,
    adaptColorsForEffect,
  ]);
  /* oxlint-enable react/exhaustive-effect-dependencies */

  // Marketing/HTML mail is designed for a white canvas — give it a light card
  // inside the dark conversation, like an unfurled preview card.
  return (
    <div>
      <iframe
        key={`${dark ? "dark" : "light"}-${bodyFontSize}`}
        ref={frameRef}
        sandbox="allow-same-origin"
        srcDoc={(dark ? messageBodyPreludeDark : messageBodyPrelude)(bodyFontSize) + html}
        // Matching the embedder's scheme keeps a dark frame transparent
        // instead of getting an opaque canvas painted behind it.
        style={{ colorScheme: dark ? "dark" : "light" }}
        className={cn("w-full rounded-lg", dark ? "bg-transparent" : "bg-white")}
        title="Message body"
      />
      {hasQuote ? <QuoteToggle open={quoteOpen} onToggle={toggleQuote} /> : null}
    </div>
  );
}

/** Splits a plain-text body at its quoted history ("On … wrote:", "> …", Outlook marker). */
function splitPlainQuote(text: string): [string, string] {
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    const quoteRunFollows = lines
      .slice(i)
      .every((l) => l.trim() === "" || l.trimStart().startsWith(">"));
    if (
      /^On .+wrote:$/i.test(line) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) ||
      (line.startsWith(">") && quoteRunFollows)
    ) {
      const main = lines.slice(0, i).join("\n").trimEnd();
      if (main.trim().length < 20) return [text, ""];
      return [main, lines.slice(i).join("\n")];
    }
  }
  return [text, ""];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'*]/g;

/** Plain text with its URLs as links that open like the HTML body's. */
function Linkified({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    parts.push(text.slice(last, match.index));
    parts.push(
      <a
        key={match.index}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          openLink(url, { flip: isModClick(e) });
        }}
        className="text-primary underline underline-offset-2 hover:opacity-80"
      >
        {url}
      </a>,
    );
    last = match.index + url.length;
  }
  parts.push(text.slice(last));
  return parts;
}

function PlainBody({ text }: { text: string }) {
  const [main, quote] = splitPlainQuote(text);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">
        <Linkified text={main} />
      </pre>
      {quote ? <QuoteToggle open={open} onToggle={() => setOpen((o) => !o)} /> : null}
      {quote && open ? (
        <pre className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 font-sans text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          <Linkified text={quote} />
        </pre>
      ) : null}
    </div>
  );
}

function MessageBody({
  bodyHtml,
  bodyText,
  inlineImages,
  onQuoteText,
  inviteMessageId,
}: {
  inviteMessageId?: string;
  bodyHtml: string | null;
  bodyText: string | null;
  inlineImages?: InlineImageSource;
  /** Reports selected text inside the (same-origin) HTML iframe. */
  onQuoteText?: (text: string) => void;
}) {
  if (bodyHtml) {
    return (
      <HtmlBody
        html={bodyHtml}
        inlineImages={inlineImages}
        onQuoteText={onQuoteText}
        inviteMessageId={inviteMessageId}
      />
    );
  }
  if (bodyText) {
    // Flush inside the message card (the card is the surface now).
    return <PlainBody text={bodyText} />;
  }
  return <span className="text-sm text-muted-foreground">(No message body)</span>;
}

type MessageAttachment = GmailMessageDetail["attachments"][number];

const MAX_THUMBNAIL_FETCHES = 3;
let activeThumbnailFetches = 0;
const thumbnailFetchQueue: (() => void)[] = [];

async function withThumbnailSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeThumbnailFetches >= MAX_THUMBNAIL_FETCHES) {
    await new Promise<void>((resolve) => thumbnailFetchQueue.push(resolve));
  }
  activeThumbnailFetches += 1;
  try {
    return await fn();
  } finally {
    activeThumbnailFetches -= 1;
    thumbnailFetchQueue.shift()?.();
  }
}

/** A message's attachment, for the in-app preview. */
function previewFile(
  accountId: string,
  messageId: string,
  attachment: MessageAttachment,
  onSave: () => void,
): PreviewFile {
  const params = { accountId, messageId, attachmentId: attachment.id };
  return {
    name: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    load: async () => (await gmailApi.getAttachmentData(params)).base64,
    onSave,
    onOpen: () => {
      void gmailApi
        .openAttachment({ ...params, filename: attachment.filename })
        .catch(() => toast.error("Could not open attachment"));
    },
  };
}

function useAttachmentActions(
  accountId: string,
  messageId: string,
  attachment: MessageAttachment,
  onDownload: DownloadAttachment,
) {
  const [opening, setOpening] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);

  const params = {
    accountId,
    messageId,
    attachmentId: attachment.id,
    filename: attachment.filename,
  };

  const save = () => onDownload(messageId, attachment.id, attachment.filename, attachment.mimeType);

  // In the app's default app (the Mac), or downloaded (the web).
  const openInApp = () => {
    if (opening) return;
    console.log("[MessageReader:openAttachment]", { messageId, filename: attachment.filename });
    setOpening(true);
    void (async () => {
      try {
        await gmailApi.openAttachment(params);
      } catch {
        toast.error("Could not open attachment");
      } finally {
        setOpening(false);
      }
    })();
  };

  // What the app can show opens in place; the rest in its own app.
  const previewable = attachmentPreview(attachment.filename, attachment.mimeType) !== null;
  const handleOpen = () => {
    if (draggedRef.current) return;
    if (previewable) setPreviewing(true);
    else openInApp();
  };

  const preview = (
    <AttachmentPreview
      file={previewing ? previewFile(accountId, messageId, attachment, save) : null}
      onClose={() => setPreviewing(false)}
    />
  );

  // Native drag-out starts once the pointer travels past a small threshold with
  // the button held; a plain click (no travel) opens the file instead.
  const dragProps = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      pressRef.current = { x: e.clientX, y: e.clientY };
      draggedRef.current = false;
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const press = pressRef.current;
      if (!press) return;
      if ((e.buttons & 1) === 0) {
        pressRef.current = null;
        return;
      }
      if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < 5) return;
      pressRef.current = null;
      draggedRef.current = true;
      console.log("[MessageReader:dragAttachment]", {
        messageId,
        filename: attachment.filename,
      });
      void gmailApi.dragAttachment(params).catch(() => {
        toast.error("Could not export attachment");
      });
    },
    onPointerUp: () => {
      pressRef.current = null;
    },
  };

  return { handleOpen, openInApp, previewable, save, preview, dragProps, opening };
}

function ImageAttachmentTile({
  accountId,
  messageId,
  attachment,
  onDownload,
}: {
  accountId: string;
  messageId: string;
  attachment: MessageAttachment;
  onDownload: DownloadAttachment;
}) {
  const { handleOpen, openInApp, previewable, save, preview, dragProps, opening } =
    useAttachmentActions(accountId, messageId, attachment, onDownload);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    // oxlint-disable-next-line react/set-state-in-effect -- Reset transient reader/composer state when the message or attachment changes.
    setUrl(null);
    setFailed(false);
    void (async () => {
      try {
        const data = await withThumbnailSlot(() =>
          gmailApi.getAttachmentData({ accountId, messageId, attachmentId: attachment.id }),
        );
        const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.mimeType }));
        if (cancelled) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        objectUrl = blobUrl;
        setUrl(blobUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [accountId, messageId, attachment.id, attachment.mimeType]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group relative w-36 select-none">
          <div
            role="button"
            aria-label={`Open ${attachment.filename}`}
            onClick={handleOpen}
            {...(features.dragOut ? dragProps : {})}
            className={`h-28 w-36 cursor-pointer overflow-hidden rounded-xl border border-border/60 bg-secondary${opening ? " opacity-60" : ""}`}
          >
            {url ? (
              <img
                src={url}
                alt={attachment.filename}
                draggable={false}
                className="h-full w-full object-cover"
              />
            ) : failed ? (
              <div className="flex h-full items-center justify-center">
                <ImageIcon className="size-6 text-muted-foreground/70" />
              </div>
            ) : (
              <div className="h-full w-full animate-skeleton bg-secondary" />
            )}
          </div>
          <button
            type="button"
            onClick={save}
            aria-label={`Download ${attachment.filename}`}
            className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-lg bg-black/60 text-white opacity-0 hover:bg-black/80 focus-visible:opacity-100 group-hover:opacity-100"
          >
            <DownloadIcon className="size-3.5" />
          </button>
          <div className="mt-1.5 truncate text-xs text-muted-foreground">{attachment.filename}</div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon="eye" onSelect={handleOpen}>
          Open
        </ContextMenuItem>
        {previewable && features.openFiles ? (
          <ContextMenuItem icon="arrow.up.forward.app" onSelect={openInApp}>
            Open in default app
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem icon="square.and.arrow.down" onSelect={save}>
          Save…
        </ContextMenuItem>
      </ContextMenuContent>
      {preview}
    </ContextMenu>
  );
}

function FileAttachmentRow({
  accountId,
  messageId,
  attachment,
  onDownload,
}: {
  accountId: string;
  messageId: string;
  attachment: MessageAttachment;
  onDownload: DownloadAttachment;
}) {
  const { handleOpen, openInApp, previewable, save, preview, dragProps, opening } =
    useAttachmentActions(accountId, messageId, attachment, onDownload);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          aria-label={`Open ${attachment.filename}`}
          onClick={handleOpen}
          {...dragProps}
          className={`flex cursor-pointer select-none items-center gap-3 px-4 py-2 hover:bg-accent-surface/60${opening ? " opacity-60" : ""}`}
        >
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {attachment.filename}
          </span>
          <span className="shrink-0 truncate text-sm text-muted-foreground">
            {attachment.mimeType} · {formatBytes(attachment.size)}
          </span>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              save();
            }}
            aria-label={`Download ${attachment.filename}`}
            className="-me-1.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent-surface hover:text-foreground"
          >
            <DownloadIcon className="size-3.5" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon="eye" onSelect={handleOpen}>
          Open
        </ContextMenuItem>
        {previewable && features.openFiles ? (
          <ContextMenuItem icon="arrow.up.forward.app" onSelect={openInApp}>
            Open in default app
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem icon="square.and.arrow.down" onSelect={save}>
          Save…
        </ContextMenuItem>
      </ContextMenuContent>
      {preview}
    </ContextMenu>
  );
}

function AttachmentList({
  accountId,
  messageId,
  attachments,
  onDownload,
}: {
  accountId: string;
  messageId: string;
  attachments: GmailMessageDetail["attachments"];
  onDownload: DownloadAttachment;
}) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
  const files = attachments.filter((a) => !a.mimeType.startsWith("image/"));
  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-border/60 bg-card">
      <div className="flex items-center gap-3 p-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-surface">
          <PaperclipIcon className="size-4 text-muted-foreground" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-foreground">
            {attachments.length} attachment{attachments.length === 1 ? "" : "s"}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatBytes(attachments.reduce((sum, a) => sum + a.size, 0))}
          </span>
        </span>
      </div>
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-t border-border/60 p-3">
          {images.map((att) => (
            <ImageAttachmentTile
              key={att.id}
              accountId={accountId}
              messageId={messageId}
              attachment={att}
              onDownload={onDownload}
            />
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="flex flex-col border-t border-border/60 py-1">
          {files.map((att) => (
            <FileAttachmentRow
              key={att.id}
              accountId={accountId}
              messageId={messageId}
              attachment={att}
              onDownload={onDownload}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// DayDivider/CollapsedRow/ExpandedRow are shared with DraftEditor, which
// renders the same conversation above its composer.
export function DayDivider({ timestamp }: { timestamp: number }) {
  return (
    <div className="flex justify-center px-6 pb-2 pt-6">
      <span className="text-xs text-muted-foreground">{formatDayLabel(timestamp)}</span>
    </div>
  );
}

export function CollapsedRow({
  accountId,
  summary,
  onExpand,
}: {
  accountId: string;
  summary: GmailMessageSummary;
  onExpand: () => void;
  /** Kept for callers; every row is now a flat, hairline-separated row. */
  standalone?: boolean;
}) {
  return (
    <div className="px-3 py-px">
      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand message"
        className="flex w-full cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 text-left outline-none hover:bg-accent-surface/60 focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <SenderAvatar
          name={summary.fromName}
          email={summary.fromEmail}
          accountId={accountId}
          className="shrink-0"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline justify-between gap-3">
            <span
              className={cn(
                "truncate text-sm",
                summary.unread ? "font-medium text-foreground" : "text-foreground",
              )}
            >
              {senderLabel(summary.fromName, summary.fromEmail, accountId)}
            </span>
            <span
              className="shrink-0 text-xs tabular-nums text-muted-foreground"
              title={formatFullDate(summary.date)}
            >
              {formatTime(summary.date)}
            </span>
          </span>
          <span className="truncate text-sm text-muted-foreground">
            {decodeEntities(summary.snippet)}
          </span>
        </span>
      </button>
    </div>
  );
}

/** "N more messages" fold inside a grouped run of collapsed messages. */
function FoldRow({ count, onUnfold }: { count: number; onUnfold: () => void }) {
  return (
    <div className="px-3 py-px">
      <button
        type="button"
        onClick={onUnfold}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent-surface/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span className="flex size-9 shrink-0 items-center justify-center">
          <span className="flex size-7 items-center justify-center rounded-full border border-border/60 text-xs tabular-nums">
            {count}
          </span>
        </span>
        {count === 1 ? "1 more message" : `${count} more messages`}
      </button>
    </div>
  );
}

export function ExpandedRow({
  accountId,
  summary,
  onCollapse,
  onDownload,
  onQuoteText,
  onComposeTo,
  onSearchSender,
}: {
  accountId: string;
  summary: GmailMessageSummary;
  /** Absent for single-message conversations, which always stay expanded. */
  onCollapse?: () => void;
  onDownload: DownloadAttachment;
  onQuoteText?: (text: string) => void;
  onComposeTo?: (email: string) => void;
  onSearchSender?: (email: string) => void;
}) {
  const detailQuery = useMessage(accountId, summary.id);
  const modifyMessage = useModifyMessage();
  const modifyMessageRef = useLatest(modifyMessage);
  const markedRead = useRef(false);
  const markReadDelayMs = useInterfaceSetting(MARK_READ_DELAY);

  // Reading a message marks it read — debounced so j/k scrubbing through the
  // list (which mounts and unmounts expanded rows) doesn't fire per row.
  // The mutation is read through a ref (not a dependency): react-query
  // returns a new `modifyMessage` object on every render, which was
  // resetting this timer on any incidental re-render (e.g. a window-focus
  // refetch) and could push marking read past the window closing.
  useEffect(() => {
    if (markedRead.current || !summary.unread) return;
    const timer = setTimeout(() => {
      markedRead.current = true;
      console.log("[MessageReader:markRead]", { messageId: summary.id });
      void modifyMessageRef.current.mutateAsync({
        accountId,
        messageId: summary.id,
        removeLabelIds: ["UNREAD"],
      });
    }, markReadDelayMs);
    return () => clearTimeout(timer);
  }, [summary.unread, summary.id, accountId, markReadDelayMs, modifyMessageRef]);

  const detail = detailQuery.data;
  const inlineImages = useMemo(
    () => matchInlineImages(detail?.bodyHtml ?? null, detail?.attachments ?? []),
    [detail],
  );
  // Mail in a language the user doesn't read gets the translate banner; once
  // translated, the body's text is swapped in place.
  const translation = useMessageTranslation(accountId, detail);
  // Calendar invitations (an .ics part) get the RSVP bar.
  const hasInvite = Boolean(
    detail?.attachments.some(
      (a) => /text\/calendar|application\/ics/i.test(a.mimeType) || /\.ics$/i.test(a.filename),
    ),
  );

  return (
    <div className="group px-6 py-5">
      <div>
        {/* Header: avatar in the gutter, sender + time, recipients */}
        <div className="flex items-start gap-3">
          <SenderHoverCard
            name={summary.fromName}
            email={summary.fromEmail}
            accountId={accountId}
            onCompose={onComposeTo}
            onSearch={onSearchSender}
          >
            <SenderAvatar
              name={summary.fromName}
              email={summary.fromEmail}
              accountId={accountId}
              className="shrink-0"
            />
          </SenderHoverCard>
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onCollapse}
              disabled={!onCollapse}
              className="flex w-full items-baseline justify-between gap-3 text-left"
              aria-label={onCollapse ? "Collapse message" : undefined}
            >
              <SenderHoverCard
                name={summary.fromName}
                email={summary.fromEmail}
                accountId={accountId}
                onCompose={onComposeTo}
                onSearch={onSearchSender}
              >
                <span className="select-text truncate text-sm font-medium leading-snug text-foreground">
                  {senderLabel(summary.fromName, summary.fromEmail, accountId)}
                </span>
              </SenderHoverCard>
              <span
                className="shrink-0 text-xs tabular-nums text-muted-foreground"
                title={formatFullDate(summary.date)}
              >
                {formatTime(summary.date)}
              </span>
            </button>
            <div className="flex min-w-0 items-baseline gap-3">
              <div className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                to{" "}
                <RecipientList
                  list={summary.to}
                  accountId={accountId}
                  onComposeTo={onComposeTo}
                  onSearchSender={onSearchSender}
                />
                {detail?.cc ? (
                  <>
                    {" · cc "}
                    <RecipientList
                      list={detail.cc}
                      accountId={accountId}
                      onComposeTo={onComposeTo}
                      onSearchSender={onSearchSender}
                    />
                  </>
                ) : null}
              </div>
              <UnsubscribeLink
                accountId={accountId}
                messageId={summary.id}
                senderName={summary.fromName}
                senderEmail={summary.fromEmail}
              />
            </div>
          </div>
        </div>

        {/* The body takes the row's full width, not indented under the avatar. */}
        <div className="mt-4 select-text">
          {detailQuery.isLoading ? (
            // The snippet stands in while the body loads: about the size of a
            // short message, so the thread doesn't jump when it arrives.
            <p className="animate-skeleton text-sm leading-6 text-muted-foreground">
              {summary.snippet}
            </p>
          ) : detail ? (
            <>
              {translation.banner}
              {hasInvite ? <InviteCard accountId={accountId} messageId={summary.id} /> : null}
              <MessageBody
                inviteMessageId={hasInvite ? summary.id : undefined}
                bodyHtml={translation.bodyHtml}
                bodyText={translation.bodyText}
                inlineImages={
                  inlineImages.size > 0
                    ? { accountId, messageId: summary.id, byCid: inlineImages }
                    : undefined
                }
                onQuoteText={onQuoteText}
              />
              {/* Images already shown in the body aren't repeated as tiles. */}
              <AttachmentList
                accountId={accountId}
                messageId={summary.id}
                attachments={detail.attachments.filter(
                  (a) => ![...inlineImages.values()].includes(a),
                )}
                onDownload={onDownload}
              />
            </>
          ) : (
            <span className="text-sm text-muted-foreground">Could not load this message.</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A message's To/Cc list: each person is selectable text (the app is
 * unselectable by default) with the sender hovercard — Copy address, New
 * message, Find emails — like the From line.
 */
function RecipientList({
  list,
  accountId,
  onComposeTo,
  onSearchSender,
}: {
  list: string;
  accountId: string;
  onComposeTo?: (email: string) => void;
  onSearchSender?: (email: string) => void;
}) {
  const people = splitAddressList(list).map(parseAddressEntry);
  return (
    <>
      {withOccurrenceKeys(people, (person) => person.email).map(({ item: p, index: i, key }) => (
        <span key={key}>
          {i > 0 ? ", " : null}
          <SenderHoverCard
            name={p.name}
            email={p.email}
            accountId={accountId}
            onCompose={onComposeTo}
            onSearch={onSearchSender}
          >
            <span className="cursor-text select-text hover:text-foreground" title={p.email}>
              {p.name || p.email}
            </span>
          </SenderHoverCard>
        </span>
      ))}
    </>
  );
}

/** Reply-all recipients for the latest message, from this account's viewpoint. */
function computeReplyAll(
  last: GmailMessageSummary & { cc?: string },
  ownEmail: string,
): { to: string; cc: string | undefined } {
  const own = ownEmail.toLowerCase();
  const fromSelf = last.fromEmail.toLowerCase() === own;
  const seen = new Set<string>([own]);
  const to: string[] = [];
  const cc: string[] = [];
  if (!fromSelf) {
    to.push(senderAddress(last));
    seen.add(last.fromEmail.toLowerCase());
  }
  for (const entry of splitAddressList(last.to)) {
    const email = parseAddressEntry(entry).email.toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    // Replying to your own message keeps its recipients in To.
    (fromSelf ? to : cc).push(entry);
  }
  for (const entry of splitAddressList(last.cc ?? "")) {
    const email = parseAddressEntry(entry).email.toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    cc.push(entry);
  }
  if (to.length === 0) to.push(senderAddress(last));
  return { to: to.join(", "), cc: cc.length > 0 ? cc.join(", ") : undefined };
}

type InlineMode = "reply" | "replyAll" | "forward";

const INLINE_MODE_LABEL: Record<InlineMode, string> = {
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
};

/** Reply-to-sender recipients for the latest message. */
/** "Name <email>" for the sender, so replies show who they're going to. */
function senderAddress(m: GmailMessageSummary): string {
  return formatAddressEntry(m.fromName, m.fromEmail);
}

function computeReply(
  last: GmailMessageSummary,
  ownEmail: string,
): { to: string; cc: string | undefined } {
  const fromSelf = last.fromEmail.toLowerCase() === ownEmail.toLowerCase();
  // Replying to your own message targets its recipients instead of yourself.
  return { to: fromSelf ? last.to : senderAddress(last), cc: undefined };
}

/** "Re: x" / "Fwd: x" without stacking prefixes (any case; FW/Fwd alike). */
function prefixSubject(prefix: "Re" | "Fwd", subject: string): string {
  const already = prefix === "Re" ? /^re:/i : /^(fwd?|fw):/i;
  return already.test(subject.trim()) ? subject : `${prefix}: ${subject}`;
}

function forwardBlock(
  source: GmailMessageSummary & { bodyText?: string | null; bodyHtml?: string | null },
): string {
  const fromDisplay = source.fromName
    ? `${source.fromName} <${source.fromEmail}>`
    : source.fromEmail;
  // HTML-only mail has no text part — derive it, or the forward arrives empty.
  const body = source.bodyText ?? (source.bodyHtml ? htmlToText(source.bodyHtml) : "");
  return `\n\n---------- Forwarded message ----------\nFrom: ${fromDisplay}\nDate: ${formatFullDate(source.date)}\nSubject: ${source.subject}\nTo: ${source.to}\n\n${body}`;
}

const INLINE_MODE_ICON: Record<InlineMode, typeof ReplyIcon> = {
  reply: ReplyIcon,
  replyAll: ReplyAllIcon,
  forward: ForwardIcon,
};

/** "↩ Reply ⌄" — switches the inline composer between reply, reply all and forward. */
function ModeSwitcher({
  mode,
  onChange,
}: {
  mode: InlineMode;
  onChange: (mode: InlineMode) => void;
}) {
  const Icon = INLINE_MODE_ICON[mode];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Reply mode"
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm font-medium text-foreground outline-none hover:bg-accent-surface focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Icon className="size-3.5 text-muted-foreground" />
          {INLINE_MODE_LABEL[mode]}
          <ChevronDownIcon className="size-3.5 text-muted-foreground/70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {(Object.keys(INLINE_MODE_LABEL) as InlineMode[]).map((m) => {
          const ItemIcon = INLINE_MODE_ICON[m];
          return (
            <DropdownMenuItem key={m} icon={<ItemIcon />} onSelect={() => onChange(m)}>
              {INLINE_MODE_LABEL[m]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The in-thread composer: reply, reply-all, or forward the latest message
 * without leaving the conversation, autosaving to a thread draft as you type.
 */
function InlineComposer({
  accountId,
  mode,
  onModeChange,
  lastMessage,
  baseSubject,
  threadId,
  onClose,
}: {
  accountId: string;
  mode: InlineMode;
  /** Switches Reply / Reply all / Forward in place (the text is kept). */
  onModeChange: (mode: InlineMode) => void;
  lastMessage: GmailMessageSummary;
  baseSubject: string;
  threadId: string;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [ccVisible, setCcVisible] = useState(false);
  const [bcc, setBcc] = useState("");
  const [bccVisible, setBccVisible] = useState(false);
  const recipientsDirty = useRef(false);
  const [formatting, setFormatting] = useState(false);
  // Forward needs recipients typed in; replies show a one-line summary.
  const [fieldsOpen, setFieldsOpen] = useState(mode === "forward");
  // null = still fetching the forwarded original's files.
  const [attachments, setAttachments] = useState<ComposeAttachment[] | null>(
    mode === "forward" ? null : [],
  );
  const editorRef = useRef<RichTextRef>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const sendMessage = useSendMessage();
  const accountsQuery = useAccounts();
  // The latest message's detail carries its Cc line and body text (summaries
  // don't); usually already cached since the last message renders expanded.
  const lastDetailQuery = useMessage(accountId, lastMessage.id);
  const lastDetail = lastDetailQuery.data;

  const ownEmail = accountsQuery.data?.find((a) => a.id === accountId)?.email ?? "";

  // A mode switch recomputes recipients (and drops forwarded files).
  const previousMode = useRef(mode);
  useEffect(() => {
    if (previousMode.current === mode) return;
    recipientsDirty.current = false;
    if (previousMode.current === "forward") setAttachments([]);
    // oxlint-disable-next-line react/set-state-in-effect -- Reset transient reader/composer state when the message or attachment changes.
    if (mode === "forward") setFieldsOpen(true);
    previousMode.current = mode;
  }, [mode]);

  // Prefill recipients per mode; refine once the detail arrives, unless the
  // user already edited the fields.
  useEffect(() => {
    if (recipientsDirty.current) return;
    const source = lastDetail ?? lastMessage;
    if (mode === "forward") {
      // oxlint-disable-next-line react/set-state-in-effect -- Reset transient reader/composer state when the message or attachment changes.
      setTo("");
      setCc("");
      setCcVisible(false);
      return;
    }
    const r = mode === "reply" ? computeReply(source, ownEmail) : computeReplyAll(source, ownEmail);
    setTo(r.to);
    setCc(r.cc ?? "");
    setCcVisible(!!r.cc);
  }, [mode, lastMessage, lastDetail, ownEmail]);

  // Forward seeds the original's attachments; other modes keep manual picks.
  useEffect(() => {
    if (mode !== "forward") return;
    if (!lastDetail) {
      // oxlint-disable-next-line react/set-state-in-effect -- Reset transient reader/composer state when the message or attachment changes.
      setAttachments(null);
      return;
    }
    if (lastDetail.attachments.length === 0) {
      setAttachments([]);
      return;
    }
    let cancelled = false;
    setAttachments(null);
    void (async () => {
      try {
        const out: ComposeAttachment[] = [];
        for (const att of lastDetail.attachments) {
          const data = await gmailApi.getAttachmentData({
            accountId,
            messageId: lastMessage.id,
            attachmentId: att.id,
          });
          out.push({
            name: att.filename,
            mimeType: att.mimeType,
            size: data.size,
            base64: data.base64,
          });
        }
        if (!cancelled) setAttachments(out);
      } catch {
        if (!cancelled) {
          setAttachments([]);
          toast.error("Could not load the original attachments");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, accountId, lastMessage.id, lastDetail]);

  useEffect(() => {
    if (mode === "forward") toRef.current?.focus();
    else editorRef.current?.focus();
  }, [mode]);

  const subject =
    mode === "forward" ? prefixSubject("Fwd", baseSubject) : prefixSubject("Re", baseSubject);

  // Half-written replies/forwards persist as thread drafts.
  const draft = useDraftAutosave({
    accountId,
    threadId,
    delayMs: autosaveDelayMs(attachments),
    // Edited elsewhere (an agent, Gmail web): load that version in place.
    // The subject stays derived from the conversation.
    onRemoteChange: async (detail) => {
      recipientsDirty.current = true;
      setTo(detail.to ?? "");
      setCc(detail.cc ?? "");
      setBcc(detail.bcc ?? "");
      setCcVisible(Boolean(detail.cc));
      setBccVisible(Boolean(detail.bcc));
      editorRef.current?.setHTML(detail.bodyHtml ?? textToHtml(detail.bodyText ?? ""));
      setAttachments(
        detail.attachments.length > 0
          ? await loadMessageAttachments(accountId, detail.id, detail.attachments)
          : [],
      );
    },
    signal: JSON.stringify({ to, cc, bcc, subject, text, att: attachmentSignature(attachments) }),
    getPayload: () => {
      if (!text.trim() || attachments == null) return null;
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

  const hasRecipient = splitAddressList(to).some((e) => parseAddressEntry(e).email.includes("@"));
  const forwardReady = attachments != null && (mode !== "forward" || lastDetail != null);
  const canSend =
    !sendMessage.isPending &&
    hasRecipient &&
    forwardReady &&
    (mode === "forward" || text.trim().length > 0);

  const handleSend = async (scheduledAt?: number) => {
    if (!canSend) return;
    const plain = editorRef.current?.getText() ?? text;
    const html = editorRef.current?.getHTML() ?? textToHtml(text);
    const quoted = mode === "forward" ? forwardBlock(lastDetail ?? lastMessage) : "";
    const body = `${plain}${quoted}`;
    const bodyHtml = `<div dir="auto">${html}${textToHtml(quoted)}</div>`;
    console.log("[MessageReader:inlineSend]", { mode, threadId });
    const payload = {
      accountId,
      to: normalizeAddressList(to),
      cc: normalizeAddressList(cc) || undefined,
      bcc: normalizeAddressList(bcc) || undefined,
      subject,
      body,
      bodyHtml,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      ...(mode === "forward" ? {} : { threadId, replyToMessageId: lastMessage.id }),
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
      subject,
      send: () => sendMessage.mutateAsync(payload),
      onSent: () => draft.finalize({ deleteDraft: true }),
      savedDraft: draft.savedDraft,
    });
  };

  const { isDragging, dropProps } = useComposeFileDrop((files) => {
    void filesToComposeAttachments(files, attachments ?? []).then((picked) => {
      if (picked.length > 0) setAttachments((prev) => [...(prev ?? []), ...picked]);
    });
  }, attachments == null);

  const senderFirstName = (lastMessage.fromName || lastMessage.fromEmail).split(" ")[0] || "thread";
  const placeholder =
    mode === "reply"
      ? `Reply to ${senderFirstName}…`
      : mode === "replyAll"
        ? "Reply to everyone…"
        : "Add a note (optional)…";

  const recipientSummary = [...splitAddressList(to), ...splitAddressList(cc)].map((entry) => {
    const { name, email } = parseAddressEntry(entry);
    return (name || email).split(" ")[0];
  });
  const attach = () => {
    void pickComposeAttachments(attachments ?? []).then((picked) => {
      if (picked.length > 0) setAttachments((prev) => [...(prev ?? []), ...picked]);
    });
  };
  const discard = () => {
    onClose();
    void draft.finalize({ deleteDraft: true });
  };
  const editRecipients = (update: (value: string) => void) => (value: string) => {
    recipientsDirty.current = true;
    update(value);
  };

  return (
    <div
      className="relative mx-auto w-full max-w-(--reading-width) shrink-0 px-5 pb-4 pt-1"
      data-inline-compose=""
      {...dropProps}
    >
      <ComposeDropOverlay visible={isDragging} />
      <ComposerCard onSend={() => void handleSend()}>
        <div className="flex min-h-10 items-center gap-1 border-b border-border/50 pl-2 pr-1.5">
          <ModeSwitcher mode={mode} onChange={onModeChange} />
          {!fieldsOpen ? (
            <button
              type="button"
              onClick={() => setFieldsOpen(true)}
              className="min-w-0 flex-1 cursor-pointer truncate rounded-md px-1.5 py-1 text-left text-sm text-muted-foreground outline-none hover:bg-accent-surface/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {recipientSummary.length > 0 ? (
                <>
                  to{" "}
                  <span className="text-foreground">{recipientSummary.slice(0, 3).join(", ")}</span>
                  {recipientSummary.length > 3 ? ` +${recipientSummary.length - 3}` : ""}
                </>
              ) : (
                "Add recipients"
              )}
            </button>
          ) : (
            <span className="flex-1" />
          )}
          <HintTooltip label="Close (keeps the draft)" hint="Esc">
            <IconBtn label="Close" className="size-7" onClick={onClose}>
              <XIcon className="size-3.5" />
            </IconBtn>
          </HintTooltip>
        </div>
        <DraftRemoteBanner
          remote={draft.remote}
          mine={{ to, cc, subject, body: text }}
          onTakeTheirs={draft.takeTheirs}
          onKeepMine={draft.keepMine}
          onSaveAsNew={draft.saveAsNew}
        />
        {fieldsOpen ? (
          <>
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
              <RecipientInput
                ref={toRef}
                value={to}
                onChange={editRecipients(setTo)}
                ariaLabel="To"
              />
            </ComposerField>
            {ccVisible ? (
              <ComposerField label="Cc">
                <RecipientInput value={cc} onChange={editRecipients(setCc)} ariaLabel="Cc" />
              </ComposerField>
            ) : null}
            {bccVisible ? (
              <ComposerField label="Bcc">
                <RecipientInput value={bcc} onChange={setBcc} ariaLabel="Bcc" />
              </ComposerField>
            ) : null}
          </>
        ) : null}
        <RichTextArea
          ref={editorRef}
          placeholder={placeholder}
          ariaLabel={INLINE_MODE_LABEL[mode]}
          onTextChange={setText}
          showToolbar={formatting}
          minHeightClass="min-h-[120px]"
          maxHeightClass="max-h-[45vh]"
          signatureHTML={accountsQuery.data?.find((a) => a.id === accountId)?.signature}
        />
        <AttachmentChips
          attachments={attachments}
          onRemove={(i) => setAttachments((prev) => (prev ?? []).filter((_, j) => j !== i))}
        />
        <ComposerFooter
          onAttach={attach}
          formatting={formatting}
          onToggleFormatting={() => setFormatting((f) => !f)}
          onDiscard={discard}
          status={
            mode === "forward" && attachments == null ? "Loading attachments…" : draftStatus(draft)
          }
          statusTone={draft.saveState === "error" ? "error" : "muted"}
          canSend={canSend}
          onSchedule={handleSend}
          onSend={() => void handleSend()}
        />
      </ComposerCard>
    </div>
  );
}

function ReaderShell({
  children,
  leading,
  trailing,
}: {
  children: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col">
      {leading || trailing ? (
        <div
          data-toolbar=""
          className="drag-region flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 px-4"
        >
          {leading}
          <span className="min-w-0 flex-1" />
          {trailing}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function MessageReader({
  accountId,
  messageId,
  autoFocusDraft = true,
  single = false,
  onShowConversation,
  onDeselect,
  onAdvance,
  onOpenChat,
  onQuote,
  onComposeTo,
  onSearchSender,
  titleTrailing,
  titleLeading,
  onOpenProject,
}: MessageReaderProps) {
  // Reply/reply-all/forward handlers exist only when a message is open; the
  // render below refreshes this ref so the once-mounted listener stays current.
  const readerActions = useRef<{
    reply?: () => void;
    replyAll?: () => void;
    forward?: () => void;
    translate?: () => void;
  }>({});
  const junkShortcut = useShortcutLabel("message.junk");
  const replyAllShortcut = useShortcutLabel("message.replyAll");
  const forwardShortcut = useShortcutLabel("message.forward");
  const flagShortcut = useShortcutLabel("message.star");
  const translateShortcut = useShortcutLabel("message.translate");
  // The band adapts to the reader's width (panels open → narrow): the subject
  // moves to its own row below 44rem, secondary actions fold into "…" below
  // 36rem. Measured in JS because the "…" menu renders outside this element.
  const [readerWidth, setReaderWidth] = useState(Infinity);
  const readerObserver = useRef<ResizeObserver | null>(null);
  const readerRef = useCallback((el: HTMLDivElement | null) => {
    readerObserver.current?.disconnect();
    readerObserver.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setReaderWidth(entry.contentRect.width));
    ro.observe(el);
    readerObserver.current = ro;
  }, []);
  const compactTitle = readerWidth < 44 * 16;
  const compactActions = readerWidth < 36 * 16;
  // The summary (Codex's pinned card): in the top-right corner, the
  // conversation re-centering in the room left of it, when the 48rem column
  // and the card (16rem + 1rem margins) both fit; else a popover from the toggle.
  const summaryFits = readerWidth >= 48 * 16 + 16 * 16 + 2 * 16;
  const [summaryPinned, setSummaryPinned] = useState(
    () => localStorage.getItem("gmail:summary-pinned") !== "0",
  );
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryFile, setSummaryFile] = useState<PreviewFile | null>(null);
  const summaryShown = summaryFits && summaryPinned;
  const readerAction = (name: "reply" | "replyAll" | "forward" | "translate") => () => {
    const action = readerActions.current[name];
    if (!action) return false;
    action();
  };
  useCommandHandlers({
    "message.reply": readerAction("reply"),
    "message.replyAll": readerAction("replyAll"),
    "message.forward": readerAction("forward"),
    "message.translate": readerAction("translate"),
  });
  // Cleared every render; the message-open path below re-populates it, so the
  // shortcuts are inert when no message is on screen.
  const renderedActions: typeof readerActions.current = {};
  useLayoutEffect(() => {
    readerActions.current = renderedActions;
  });

  const messageQuery = useMessage(accountId, messageId);
  const labelsQuery = useLabels(accountId);
  const modifyMessage = useModifyMessage();
  const trashMessage = useTrashMessage();
  const modifyThread = useModifyThread();
  // No inbox categories (IMAP): no category chips. One folder per message: a
  // folder chip can't just come off.
  const { categories, multipleLabels } = useCapabilities(accountId);
  const trashThread = useTrashThread();
  const untrashThread = useUntrashThread();
  const untrashMessage = useUntrashMessage();
  const deleteForever = useDeleteThreadsForever();
  const getAttachment = useGetAttachment();

  const message = messageQuery.data;
  const threadId = message?.threadId || null;

  // Translation is per conversation (starts on with "Translate
  // automatically"); each message in another language follows it.
  const { autoTranslate } = useTranslationSettings();
  const [translation, setTranslation] = useState<{ on: boolean; target: string | null }>({
    on: false,
    target: null,
  });
  // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- Re-run this DOM/reset lifecycle when its explicit trigger changes, even when the callback reads refs.
  useEffect(() => setTranslation({ on: autoTranslate, target: null }), [messageId, autoTranslate]);
  const conversationTranslation = useMemo(
    () => ({ ...translation, set: setTranslation }),
    [translation],
  );
  const openedForeign = useIsForeignMessage(accountId, message);
  const threadQuery = useThread(messageId ? accountId : null, threadId);
  const threadMessages = threadQuery.data ?? [];
  const isThread = !single && threadMessages.length > 1;

  const [inline, setInline] = useState<InlineMode | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  // Long runs of collapsed messages fold into "N more messages" until opened.
  const [unfolded, setUnfolded] = useState(false);
  // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- Re-run this DOM/reset lifecycle when its explicit trigger changes, even when the callback reads refs.
  useEffect(() => setUnfolded(false), [messageId]);
  const seededRef = useRef<string | null>(null);
  const readerAccounts = useAccounts();
  const projects = useProjects().data ?? [];

  // Quote-from-selection: a highlighted excerpt (parent DOM or an HTML iframe)
  // is reported up; when the chat panel is open, home-view attaches it as a
  // "quote" context item. Text is captured on mouse-up so it survives the
  // focus moving into the composer (which clears the DOM selection).
  const emitQuote = (text: string) => {
    if (!message || !text.trim()) return;
    const trimmed = text.trim();
    onQuote?.({
      text: trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed,
      account: readerAccounts.data?.find((a) => a.id === accountId)?.email ?? accountId,
      accountId,
      threadId: message.threadId || message.id,
      subject: message.subject || "(no subject)",
      messageId: message.id,
    });
  };
  const onParentMouseUp = () => {
    emitQuote(window.getSelection()?.toString() ?? "");
  };

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reset transient reader/composer state when the message or attachment changes.
    setInline(null);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-run this DOM/reset lifecycle when its explicit trigger changes, even when the callback reads refs.
  }, [messageId]);

  // Escape closes the inline composer before anything else: registered in the
  // capture phase so home-view's Escape-deselects-message listener never fires
  // while a draft is open (dialogs keep their own Escape handling).
  const inlineRef = useLatest(inline);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !inlineRef.current) return;
      const el = e.target as Element | null;
      if (el && typeof el.closest === "function" && el.closest('[role="dialog"]')) return;
      // An open autocomplete popup owns Escape (it dismisses itself).
      if (el && typeof el.closest === "function" && el.closest('[data-ac-open="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      setInline(null);
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, [inlineRef]);

  // Seed which conversation rows start expanded: the last message, every
  // unread one, and the opened message itself (differs when opened via search).
  useEffect(() => {
    if (!messageId || !threadId || threadMessages.length === 0) return;
    const seedKey = `${accountId}:${threadId}:${messageId}`;
    if (seededRef.current === seedKey) return;
    seededRef.current = seedKey;
    const ids = new Set<string>();
    for (const m of threadMessages) if (m.unread) ids.add(m.id);
    const last = threadMessages[threadMessages.length - 1];
    if (last) ids.add(last.id);
    ids.add(messageId);
    setExpandedIds(ids);
  }, [accountId, threadId, messageId, threadMessages]);

  if (!messageId) {
    return (
      <ReaderShell>
        <EmptyState
          className="flex-1"
          media={<MailIcon className="size-10 stroke-[1.25] text-muted-foreground" />}
          title="Select a conversation"
          description="Choose a message from the list to read it here."
        />
      </ReaderShell>
    );
  }

  if (messageQuery.isLoading || threadQuery.isLoading) {
    return (
      <ReaderShell leading={titleLeading} trailing={titleTrailing}>
        <div className="mx-auto flex w-full max-w-(--reading-width) flex-col gap-3 px-6 py-5">
          <div className="h-5 w-64 animate-skeleton rounded-full bg-secondary" />
          <div className="h-4 w-48 animate-skeleton rounded-full bg-accent-surface" />
          <div className="h-4 w-40 animate-skeleton rounded-full bg-accent-surface" />
        </div>
      </ReaderShell>
    );
  }

  if (!message) {
    return (
      <ReaderShell leading={titleLeading} trailing={titleTrailing}>
        <EmptyState
          className="flex-1"
          media={<MailWarningIcon className="size-10 stroke-[1.25] text-muted-foreground" />}
          title="Could not load message"
          description="The message could not be retrieved. Try again."
        />
      </ReaderShell>
    );
  }

  // Drafts resume in the composer pane instead of rendering read-only.
  if (message.labelIds.includes("DRAFT")) {
    return (
      <DraftEditor
        key={`${accountId}:${message.id}`}
        accountId={accountId}
        detail={message}
        autoFocus={autoFocusDraft}
        threadMessages={threadMessages}
        onDone={onDeselect ?? (() => {})}
        titleTrailing={titleTrailing}
        titleLeading={titleLeading}
      />
    );
  }

  // From here on the conversation is renderable — a thread of one message
  // falls back to the opened message itself.
  const rows: GmailMessageSummary[] =
    !single && threadMessages.length > 0 ? threadMessages : [message];
  // Reply/forward target the last real message — never your own saved draft.
  const sentRows = rows.filter((m) => !m.labelIds.includes("DRAFT"));
  const lastRow = sentRows[sentRows.length - 1] ?? rows[rows.length - 1];
  // Labels belong to the conversation: shown and edited as the union over it.
  const conversationLabelIds = [...new Set(rows.flatMap((m) => m.labelIds))];
  const conversationId = threadId ?? message.threadId ?? message.id;
  const readerEmail =
    readerAccounts.data?.find((a) => a.id === accountId)?.email.toLowerCase() ?? "";
  const inProjects = projects.filter((p) =>
    p.threads.some((t) => t.email === readerEmail && t.threadId === conversationId),
  );

  const isUnread = isThread ? threadMessages.some((m) => m.unread) : message.unread;

  const labelsById = new Map((labelsQuery.data ?? []).map((l) => [l.id, l]));
  const messageLabels = conversationLabelIds
    .map((id) => labelsById.get(id))
    .filter((l): l is GmailLabel => l != null && l.type === "user");

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggleRead = () => {
    console.log("[MessageReader:toggleRead]", { messageId, isUnread, isThread });
    if (isThread && threadId) {
      if (isUnread) {
        void modifyThread.mutateAsync({
          accountId,
          threadId,
          removeLabelIds: ["UNREAD"],
        });
      } else {
        // Marking a read conversation unread flags only its latest message.
        const last = threadMessages[threadMessages.length - 1];
        void modifyMessage.mutateAsync({
          accountId,
          messageId: last.id,
          addLabelIds: ["UNREAD"],
        });
        // Back to the list, or the auto mark-read would undo it (Gmail does this).
        onDeselect?.();
      }
      return;
    }
    void modifyMessage.mutateAsync({
      accountId,
      messageId,
      addLabelIds: isUnread ? undefined : ["UNREAD"],
      removeLabelIds: isUnread ? ["UNREAD"] : undefined,
    });
    if (!isUnread) onDeselect?.();
  };

  const handleArchive = () => {
    console.log("[MessageReader:archive]", { messageId, isThread });
    if (isThread && threadId) {
      void modifyThread.mutateAsync({ accountId, threadId, removeLabelIds: ["INBOX"] });
      return;
    }
    void modifyMessage.mutateAsync({
      accountId,
      messageId,
      removeLabelIds: ["INBOX"],
    });
  };

  const handleUnarchive = () => {
    console.log("[MessageReader:unarchive]", { messageId, isThread });
    if (isThread && threadId) {
      void modifyThread.mutateAsync({ accountId, threadId, addLabelIds: ["INBOX"] });
      return;
    }
    void modifyMessage.mutateAsync({
      accountId,
      messageId,
      addLabelIds: ["INBOX"],
    });
  };

  const handleTrash = () => {
    console.log("[MessageReader:trash]", { messageId, isThread });
    if (isThread && threadId) {
      void trashThread.mutateAsync({ accountId, threadId });
      return;
    }
    void trashMessage.mutateAsync({ accountId, messageId });
  };

  const handleDeleteForever = () => {
    setConfirmDeleteOpen(false);
    console.log("[MessageReader:deleteForever]", { messageId });
    onAdvance?.();
    void deleteForever.mutateAsync({ accountId, threadIds: [message.threadId || message.id] });
  };

  const handleUntrash = () => {
    console.log("[MessageReader:untrash]", { messageId, isThread });
    if (isThread && threadId) {
      void untrashThread.mutateAsync({ accountId, threadId });
      return;
    }
    void untrashMessage.mutateAsync({ accountId, messageId });
  };

  const handleReply = () => {
    console.log("[MessageReader:reply]", { messageId });
    setInline("reply");
  };

  const handleReplyAll = () => {
    console.log("[MessageReader:replyAll]", { messageId });
    setInline("replyAll");
  };

  const handleForward = () => {
    console.log("[MessageReader:forward]", { messageId });
    setInline("forward");
  };

  const handleDownloadAttachment: DownloadAttachment = (
    attachmentMessageId,
    attachmentId,
    filename,
    mimeType,
  ) => {
    console.log("[MessageReader:downloadAttachment]", {
      messageId: attachmentMessageId,
      filename,
    });
    void (async () => {
      try {
        const result = await getAttachment.mutateAsync({
          accountId,
          messageId: attachmentMessageId,
          attachmentId,
          filename,
          mimeType,
        });
        // Not saved: the save dialog was cancelled.
        if (result.saved) toast.success(`Saved ${filename}`);
      } catch {
        toast.error("Could not download attachment");
      }
    })();
  };

  // The summary's files open here: its popover closes when the preview takes focus.
  const handleOpenSummaryFile = (fileMessageId: string, attachment: MessageAttachment) => {
    const save = () =>
      handleDownloadAttachment(
        fileMessageId,
        attachment.id,
        attachment.filename,
        attachment.mimeType,
      );
    if (!attachmentPreview(attachment.filename, attachment.mimeType)) return save();
    setSummaryOpen(false);
    setSummaryFile(previewFile(accountId, fileMessageId, attachment, save));
  };

  const handleToggleTranslation = () => {
    if (!translation.on && !openedForeign) {
      toast.info("This message is already in a language you read");
      return;
    }
    console.log("[MessageReader:translate]", { messageId, on: !translation.on });
    setTranslation((t) => ({ ...t, on: !t.on }));
  };

  Object.assign(renderedActions, {
    reply: handleReply,
    replyAll: handleReplyAll,
    forward: handleForward,
    translate: handleToggleTranslation,
  });

  const isFlagged = message.labelIds.includes("STARRED");
  const isTrashed = message.labelIds.includes("TRASH");

  const handleToggleFlag = () => {
    console.log("[MessageReader:toggleFlag]", { messageId, isFlagged });
    void modifyMessage.mutateAsync({
      accountId,
      messageId: message.id,
      ...(isFlagged ? { removeLabelIds: ["STARRED"] } : { addLabelIds: ["STARRED"] }),
    });
  };

  const isJunk = message.labelIds.includes("SPAM");

  const handleJunk = () => {
    console.log("[MessageReader:junkToggle]", { messageId, isThread, isJunk });
    const addLabelIds = isJunk ? ["INBOX"] : ["SPAM"];
    const removeLabelIds = isJunk ? ["SPAM"] : ["INBOX"];
    if (isThread && threadId) {
      void modifyThread.mutateAsync({ accountId, threadId, addLabelIds, removeLabelIds });
      return;
    }
    void modifyMessage.mutateAsync({
      accountId,
      messageId: message.id,
      addLabelIds,
      removeLabelIds,
    });
  };

  const groupDivider = <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;

  /** Subject + label chips: one truncated line in the band, or a wrapping heading. */
  const summary = (
    <ConversationSummary
      accountId={accountId}
      threadId={conversationId}
      rows={rows}
      onComposeTo={onComposeTo}
      onSearchSender={onSearchSender}
      onOpenFile={handleOpenSummaryFile}
    />
  );

  const renderTitle = (wrap: boolean) => (
    <>
      <span
        className={
          wrap
            ? "select-text text-xl font-medium leading-snug tracking-[-0.01em] text-foreground"
            : "select-text truncate text-sm font-medium text-foreground"
        }
        title={isThread ? `${rows.length} messages` : formatFullDate(message.date)}
      >
        {message.subject || "(no subject)"}
      </span>
      {conversationLabelIds.includes("INBOX") ||
      (categories && conversationLabelIds.some(isCategoryLabelId)) ||
      messageLabels.length > 0 ||
      inProjects.length > 0 ? (
        <span
          className={
            wrap
              ? "flex flex-wrap items-center gap-1"
              : "flex min-w-0 shrink items-center gap-1 overflow-hidden"
          }
        >
          {inProjects.map((p) => (
            <ProjectChip
              key={p.id}
              name={p.name}
              onOpen={() => onOpenProject?.(p.id)}
              onRemove={() => void projectsApi.removeThread(p.id, readerEmail, conversationId)}
            />
          ))}
          {conversationLabelIds.includes("INBOX") ? <InboxChip onRemove={handleArchive} /> : null}
          {(categories ? conversationLabelIds.filter(isCategoryLabelId) : []).map((id) => (
            <CategoryChip
              key={id}
              id={id}
              onRemove={() => {
                console.log("[MessageReader:removeCategoryChip]", { labelId: id });
                void modifyThread.mutateAsync({
                  accountId,
                  threadId: conversationId,
                  removeLabelIds: [id],
                });
              }}
            />
          ))}
          {messageLabels.map((label) => (
            <LabelChip
              key={label.id}
              label={label}
              onRemove={
                multipleLabels
                  ? () => {
                      console.log("[MessageReader:removeLabelChip]", { labelId: label.id });
                      void modifyThread.mutateAsync({
                        accountId,
                        threadId: conversationId,
                        removeLabelIds: [label.id],
                      });
                    }
                  : undefined
              }
            />
          ))}
        </span>
      ) : null}
    </>
  );

  return (
    <ConversationTranslationContext.Provider value={conversationTranslation}>
      <div ref={readerRef} className="relative flex h-full min-h-0 min-w-0 flex-col">
        {/* Conversation header = the title band: subject + labels, the
            everyday actions, a "more" menu, then the window's panel toggle. */}
        <div
          data-toolbar=""
          className="drag-region flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 px-4"
        >
          {titleLeading}
          {/* Wide: subject + labels live in the band. Narrow: they move to a
              heading under it (see below) so the actions keep their room. */}
          {compactTitle ? (
            <span className="min-w-0 flex-1" />
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2">{renderTitle(false)}</div>
          )}

          {/* Priority + overflow: Reply, Archive, Trash and "…" always show;
              as the pane narrows the rest folds into "…". */}
          <HintTooltip label="Reply" shortcut="message.reply" side="bottom">
            <IconBtn label="Reply" onClick={handleReply}>
              <ReplyIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
          {compactActions ? null : (
            <>
              <HintTooltip label="Reply all" shortcut="message.replyAll" side="bottom">
                <IconBtn label="Reply all" onClick={handleReplyAll}>
                  <ReplyAllIcon className="size-4" />
                </IconBtn>
              </HintTooltip>
              <HintTooltip label="Forward" shortcut="message.forward" side="bottom">
                <IconBtn label="Forward" onClick={handleForward}>
                  <ForwardIcon className="size-4" />
                </IconBtn>
              </HintTooltip>
            </>
          )}

          {groupDivider}

          {isTrashed ? (
            <HintTooltip label="Restore from Trash" shortcut="message.trash" side="bottom">
              <IconBtn label="Restore from Trash" onClick={handleUntrash}>
                <RotateCcwIcon className="size-4" />
              </IconBtn>
            </HintTooltip>
          ) : (
              isThread
                ? rows.some((m) => m.labelIds.includes("INBOX"))
                : message.labelIds.includes("INBOX")
            ) ? (
            <HintTooltip label="Archive" shortcut="message.archive" side="bottom">
              <IconBtn
                label="Archive"
                onClick={() => {
                  onAdvance?.();
                  handleArchive();
                }}
              >
                <ArchiveIcon className="size-4" />
              </IconBtn>
            </HintTooltip>
          ) : (
            <HintTooltip label="Move to Inbox" shortcut="message.archive" side="bottom">
              <IconBtn label="Move to Inbox" onClick={handleUnarchive}>
                <ArchiveRestoreIcon className="size-4" />
              </IconBtn>
            </HintTooltip>
          )}
          {!isTrashed && rows.some((m) => m.labelIds.includes("INBOX")) && (
            <SnoozeButton
              accountId={accountId}
              threadId={threadId || messageId}
              onDone={onAdvance ?? onDeselect}
            />
          )}
          {isTrashed ? null : (
            <HintTooltip label="Move to Trash" shortcut="message.trash" side="bottom">
              <IconBtn
                label="Move to Trash"
                onClick={() => {
                  onAdvance?.();
                  handleTrash();
                }}
              >
                <Trash2Icon className="size-4" />
              </IconBtn>
            </HintTooltip>
          )}
          {compactActions ? null : (
            <>
              <LabelPickerMenu
                accountId={accountId}
                threadId={conversationId}
                labelIds={conversationLabelIds}
              >
                <IconBtn label={multipleLabels ? "Label" : "Move to folder"}>
                  <FolderIcon className="size-4" />
                </IconBtn>
              </LabelPickerMenu>
              <HintTooltip
                label={isFlagged ? "Unflag" : "Flag"}
                shortcut="message.star"
                side="bottom"
              >
                <IconBtn label={isFlagged ? "Unflag" : "Flag"} onClick={handleToggleFlag}>
                  <FlagIcon
                    className={cn("size-4", isFlagged ? "fill-current text-(--red)" : "")}
                  />
                </IconBtn>
              </HintTooltip>
            </>
          )}

          <HintTooltip label="Add to Todoist" side="bottom">
            <IconBtn
              label="Add to Todoist"
              onClick={() =>
                addEmailToTodoist({ accountId, messageId: message.id, subject: message.subject })
              }
            >
              <ListTodoIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconBtn label="More actions">
                <EllipsisIcon className="size-4" />
              </IconBtn>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {compactActions ? (
                <>
                  <DropdownMenuItem
                    icon={<ReplyAllIcon />}
                    accelerator={replyAllShortcut}
                    onSelect={handleReplyAll}
                  >
                    Reply all
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<ForwardIcon />}
                    accelerator={forwardShortcut}
                    onSelect={handleForward}
                  >
                    Forward
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <LabelSubmenu
                    accountId={accountId}
                    threadId={conversationId}
                    labelIds={conversationLabelIds}
                  />
                  <DropdownMenuItem
                    icon={<FlagIcon />}
                    accelerator={flagShortcut}
                    onSelect={handleToggleFlag}
                  >
                    {isFlagged ? "Unflag" : "Flag"}
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuItem
                icon={isUnread ? <MailOpenIcon /> : <MailIcon />}
                onSelect={handleToggleRead}
              >
                {isUnread ? "Mark as read" : "Mark as unread"}
              </DropdownMenuItem>
              {openedForeign || translation.on ? (
                <DropdownMenuItem
                  icon={<LanguagesIcon />}
                  accelerator={translateShortcut}
                  onSelect={handleToggleTranslation}
                >
                  {translation.on ? "Show original" : "Translate"}
                </DropdownMenuItem>
              ) : null}
              {isJunk ? (
                <DropdownMenuItem
                  icon={<ShieldCheckIcon />}
                  accelerator={junkShortcut}
                  onSelect={handleJunk}
                >
                  Not junk
                </DropdownMenuItem>
              ) : isTrashed ? null : (
                <DropdownMenuItem
                  icon={<ArchiveXIcon />}
                  accelerator={junkShortcut}
                  onSelect={() => {
                    onAdvance?.();
                    handleJunk();
                  }}
                >
                  Move to junk
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<MousePointer2Icon />} onSelect={() => onOpenChat?.()}>
                Chat about this with the agent
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  addEmailToTodoist({ accountId, messageId: message.id, subject: message.subject })
                }
              >
                Add to Todoist…
              </DropdownMenuItem>
              <DropdownMenuSub label="Add to project">
                <AddToProjectItems
                  threads={[{ accountId, threadId: conversationId }]}
                  suggestedName={message.subject}
                  Item={DropdownMenuItem}
                  Separator={DropdownMenuSeparator}
                />
              </DropdownMenuSub>
              {isTrashed || isJunk ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    icon={<Trash2Icon />}
                    color="red"
                    onSelect={() => setConfirmDeleteOpen(true)}
                  >
                    Delete forever…
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          {summaryFits ? (
            <HintTooltip label={summaryPinned ? "Hide summary" : "Show summary"} side="bottom">
              <IconBtn
                label="Toggle summary"
                active={summaryPinned}
                onClick={() => {
                  localStorage.setItem("gmail:summary-pinned", summaryPinned ? "0" : "1");
                  setSummaryPinned(!summaryPinned);
                }}
              >
                <ListIcon className="size-4" />
              </IconBtn>
            </HintTooltip>
          ) : (
            <Popover.Root open={summaryOpen} onOpenChange={setSummaryOpen}>
              <HintTooltip label="Summary" side="bottom">
                <Popover.Trigger asChild>
                  <IconBtn label="Toggle summary" active={summaryOpen}>
                    <ListIcon className="size-4" />
                  </IconBtn>
                </Popover.Trigger>
              </HintTooltip>
              <Popover.Portal>
                <Popover.Content
                  side="bottom"
                  align="end"
                  sideOffset={6}
                  collisionPadding={8}
                  className="z-[130] outline-none"
                >
                  {summary}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}

          {titleTrailing ? (
            <span className="ml-1 flex items-center gap-1">{titleTrailing}</span>
          ) : null}
        </div>

        {/* Narrow reader: the subject + labels as a wrapping heading. */}
        {compactTitle ? (
          <div className="mx-auto flex w-full max-w-(--reading-width) shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-6 pb-2 pt-3">
            {renderTitle(true)}
          </div>
        ) : null}

        {single && threadMessages.length > 1 ? (
          <div className="mx-auto flex w-full max-w-(--reading-width) shrink-0 items-center gap-2 px-6 py-1.5">
            <span className="text-sm text-muted-foreground">
              One message of {threadMessages.length} in this conversation
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={onShowConversation}
              className={buttonClass("outline", "sm", "rounded-full border-border/60")}
            >
              Show conversation
            </button>
          </div>
        ) : null}

        {isTrashed ? (
          <div className="mx-auto w-full max-w-(--reading-width) shrink-0 px-5 pt-3">
            <div className="flex items-center gap-2 rounded-2xl border border-warning/32 bg-warning-surface py-2 pl-4 pr-2">
              <Trash2Icon className="size-4 shrink-0 text-warning-foreground" />
              <span className="text-sm text-warning-foreground">
                This conversation is in the Trash
              </span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={handleUntrash}
                className={buttonClass("outline", "sm", "rounded-full")}
              >
                Restore
              </button>
              <button
                type="button"
                onClick={() => setConfirmDeleteOpen(true)}
                className={buttonClass("outline", "sm", "rounded-full text-destructive-foreground")}
              >
                Delete forever
              </button>
            </div>
          </div>
        ) : null}

        {/* Conversation */}
        <ScrollArea
          className="flex-1"
          viewportClassName={cn(
            "pb-6",
            // Room for the pinned summary, so the column centers beside it.
            summaryShown && "pr-[18rem]",
          )}
          onMouseUp={onParentMouseUp}
        >
          <div className="mx-auto w-full max-w-(--reading-width)">
            {(() => {
              // Day dividers, expanded messages, and runs of collapsed messages
              // (one grouped card per run; long runs fold to "N more").
              type Segment =
                | { kind: "day"; ts: number }
                | { kind: "open"; m: GmailMessageSummary }
                | { kind: "closed"; ms: GmailMessageSummary[] };
              const segments: Segment[] = [];
              rows.forEach((m, i) => {
                const prev = rows[i - 1];
                if (!prev || dayKey(prev.date) !== dayKey(m.date)) {
                  segments.push({ kind: "day", ts: m.date });
                }
                const open = expandedIds.has(m.id) || rows.length === 1;
                const last = segments[segments.length - 1];
                if (open) segments.push({ kind: "open", m });
                else if (last?.kind === "closed") last.ms.push(m);
                else segments.push({ kind: "closed", ms: [m] });
              });
              return segments.map((seg) => {
                if (seg.kind === "day")
                  return <DayDivider key={`d-${seg.ts}`} timestamp={seg.ts} />;
                if (seg.kind === "open") {
                  const m = seg.m;
                  return (
                    <ExpandedRow
                      key={m.id}
                      accountId={accountId}
                      summary={m}
                      onCollapse={rows.length === 1 ? undefined : () => toggleExpanded(m.id)}
                      onDownload={handleDownloadAttachment}
                      onQuoteText={(text) => emitQuote(text)}
                      onComposeTo={onComposeTo}
                      onSearchSender={onSearchSender}
                    />
                  );
                }
                const fold = !unfolded && seg.ms.length > 3;
                const visible = fold ? [seg.ms[0], seg.ms[seg.ms.length - 1]] : seg.ms;
                return (
                  <div key={`c-${seg.ms[0].id}`}>
                    <div>
                      {visible.map((m, idx) => (
                        <Fragment key={m.id}>
                          {fold && idx === 1 ? (
                            <FoldRow count={seg.ms.length - 2} onUnfold={() => setUnfolded(true)} />
                          ) : null}
                          <CollapsedRow
                            accountId={accountId}
                            summary={m}
                            standalone={false}
                            onExpand={() => toggleExpanded(m.id)}
                          />
                        </Fragment>
                      ))}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </ScrollArea>

        {/* Pinned in the reader's top-right corner, still while the conversation scrolls. */}
        {summaryShown ? (
          <aside className="absolute right-4 top-[calc(var(--workspace-topbar-height)+0.75rem)] z-10">
            {summary}
          </aside>
        ) : null}

        {/* In-thread composer, hidden until replying/forwarding */}
        {lastRow && inline ? (
          <InlineComposer
            accountId={accountId}
            mode={inline}
            onModeChange={setInline}
            lastMessage={lastRow}
            baseSubject={message.subject}
            threadId={message.threadId || message.id}
            onClose={() => setInline(null)}
          />
        ) : null}
      </div>

      <Dialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="Delete Forever"
        confirmLabel="Delete Forever"
        confirmVariant="accent"
        onConfirm={handleDeleteForever}
      >
        <Text variant="small">Permanently delete this conversation? This cannot be undone.</Text>
      </Dialog>
      <AttachmentPreview file={summaryFile} onClose={() => setSummaryFile(null)} />
    </ConversationTranslationContext.Provider>
  );
}
