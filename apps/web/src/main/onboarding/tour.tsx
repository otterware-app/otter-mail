import { useLatest } from "../use-latest";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";
import type { KeybindingCommand } from "../keybindings/commands";
import { Btn, IconBtn, cn } from "../gmail/ui";
import { ShortcutKeys } from "./keycap";

/**
 * The tour: a spotlight walks the live app, one part at a time, with a card
 * saying what it does and the keys for it. Parts are marked `data-tour` where
 * they're rendered; a stop whose part isn't on screen shows centered. While it
 * runs, keys drive the tour (← → Esc) and mail shortcuts stay quiet.
 */

export type TourActions = {
  /** Opens a conversation if none is open, so the reader has something to show. */
  openMessage: () => void;
  setAgentOpen: (open: boolean) => void;
  agentOpen: boolean;
};

type TourStop = {
  /** The `data-tour` part to light up; centered when absent. */
  target?: string;
  title: string;
  body: ReactNode;
  keys?: { command: KeybindingCommand; label: string }[];
  message?: boolean;
  agent?: boolean;
};

const STOPS: TourStop[] = [
  {
    title: "A quick tour",
    body: "Eight stops, about a minute, on your own mail. Use the arrow keys to move and Esc to leave whenever you like.",
  },
  {
    target: "mailbox",
    title: "Your mailboxes",
    body: "Your mailboxes, down the left edge: click one, or hover it to peek at its sidebar. With two or more, All mailboxes reads them as one. You and Settings are at the bottom.",
    keys: [{ command: "mailbox.jump.1", label: "Jump to mailbox 1…9" }],
  },
  {
    target: "compose",
    title: "Write and search",
    body: "Drafts save as you type, and a sent message can be taken back for 10 seconds. Search takes Gmail's operators (from:, has:attachment, newer_than:7d), and each search stays open here as a tab.",
    keys: [
      { command: "compose.new", label: "New message" },
      { command: "search.focus", label: "Search" },
    ],
  },
  {
    target: "projects",
    title: "Views and projects",
    body: "Under your mailboxes: views, which + makes, each one list of what its filters find across them (every newsletter, receipts from any account), then Projects, which keep a piece of work's conversations, documents and notes together until it's settled. Hover one to peek at its sidebar.",
  },
  {
    target: "list",
    title: "Triage from the keyboard",
    body: "Gmail's keys, so you already know them: move through the list and act without the mouse. ⌘- or ⇧-click selects several; drag them onto a label to file them.",
    keys: [
      { command: "list.next", label: "Next" },
      { command: "message.archive", label: "Archive" },
      { command: "message.star", label: "Star" },
      { command: "message.label", label: "Label" },
      { command: "mail.undo", label: "Undo anything" },
    ],
  },
  {
    target: "reader",
    title: "Read in peace",
    body: "Earlier messages fold away. Invitations get Yes, No and Maybe; newsletters a one-click Unsubscribe; other languages a translation. Hover a sender to write to them or search their mail.",
    keys: [
      { command: "message.reply", label: "Reply" },
      { command: "message.translate", label: "Translate" },
    ],
    message: true,
  },
  {
    target: "agent",
    title: "Your agent",
    body: "It sees the conversation you're reading; select text to quote it. It can search, draft and sort your mail, and asks before changing anything. Pick the agent and model in its composer.",
    keys: [
      { command: "agent.toggle", label: "Show or hide" },
      { command: "agent.newChat", label: "New chat" },
    ],
    message: true,
    agent: true,
  },
  {
    title: "Everything else is ⌘K away",
    body: "Mailboxes, views, messages, themes and actions, all from one search. The keys start out as Gmail's; remap any of them, or add your own, in Settings → Keybindings.",
    keys: [
      { command: "commandPalette.toggle", label: "Command palette" },
      { command: "keybindings.show", label: "All shortcuts" },
    ],
  },
];

const CARD_WIDTH = 344;
const GAP = 16;
const MARGIN = 12;
const PAD = 4;

type Box = { left: number; top: number; width: number; height: number };

/** Where a part is on screen, followed every frame (panels animate). */
function useTargetBox(target: string | undefined): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    let raf = 0;
    let last: string | null = null;
    const tick = () => {
      const el = target ? document.querySelector(`[data-tour="${target}"]`) : null;
      const r = el?.getBoundingClientRect();
      const next =
        r && r.width > 0 && r.height > 0
          ? {
              left: Math.max(MARGIN / 2, r.left - PAD),
              top: Math.max(MARGIN / 2, r.top - PAD),
              width: Math.min(window.innerWidth - MARGIN, r.width + PAD * 2),
              height: Math.min(window.innerHeight - MARGIN, r.height + PAD * 2),
            }
          : null;
      const key = next ? `${next.left},${next.top},${next.width},${next.height}` : "";
      if (key !== last) {
        last = key;
        setBox(next);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return box;
}

/** Beside the part where there's room, else over it; centered without one. */
function cardPosition(box: Box | null, height: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampTop = (top: number) => Math.min(Math.max(MARGIN, top), vh - height - MARGIN);
  if (!box) return { left: (vw - CARD_WIDTH) / 2, top: clampTop((vh - height) / 2) };
  const tall = box.height > vh * 0.5;
  const top = clampTop(tall ? box.top + box.height / 2 - height / 2 : box.top);
  if (vw - (box.left + box.width) >= CARD_WIDTH + GAP + MARGIN)
    return { left: box.left + box.width + GAP, top };
  if (box.left >= CARD_WIDTH + GAP + MARGIN) return { left: box.left - GAP - CARD_WIDTH, top };
  return { left: box.left + (box.width - CARD_WIDTH) / 2, top };
}

export function Tour({ actions, onClose }: { actions: TourActions; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const stop = STOPS[index];
  const last = index === STOPS.length - 1;
  const box = useTargetBox(stop.target);

  const actionsRef = useLatest(actions);
  // The agent panel is put back as it was when the tour ends.
  const agentWasOpen = useRef(actions.agentOpen);
  useEffect(() => {
    const { openMessage, setAgentOpen } = actionsRef.current;
    if (stop.message) openMessage();
    if (stop.agent) setAgentOpen(true);
    else if (!agentWasOpen.current) setAgentOpen(false);
  }, [stop, actionsRef]);
  useEffect(
    () => () => {
      if (!agentWasOpen.current) actionsRef.current.setAgentOpen(false);
    },
    [actionsRef],
  );

  const move = (by: number) => setIndex((i) => Math.min(STOPS.length - 1, Math.max(0, i + by)));
  const next = () => (last ? onClose() : move(1));

  const nav = useLatest({ next, move, onClose });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Nothing reaches the app's shortcuts while the tour is up.
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        nav.current.onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nav.current.next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        nav.current.move(-1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [nav]);

  const card = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(220);
  useLayoutEffect(() => {
    if (card.current) setCardHeight(card.current.offsetHeight);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-run this DOM/reset lifecycle when its explicit trigger changes, even when the callback reads refs.
  }, [index]);
  const nextButton = useRef<HTMLButtonElement>(null);
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-run this DOM/reset lifecycle when its explicit trigger changes, even when the callback reads refs.
  useEffect(() => nextButton.current?.focus({ preventScroll: true }), [index]);

  const position = cardPosition(box, cardHeight);
  // Without a part, the spotlight shrinks to a point mid-screen: all dimmed.
  const spot = box ?? {
    left: window.innerWidth / 2,
    top: window.innerHeight / 2,
    width: 0,
    height: 0,
  };

  return createPortal(
    <div className="fixed inset-0 z-[60]" data-tour-overlay="">
      <div
        aria-hidden
        className="pointer-events-none fixed rounded-xl transition-[left,top,width,height] duration-[420ms] ease-drawer motion-reduce:transition-none"
        style={{
          ...spot,
          boxShadow: "0 0 0 1px rgb(255 255 255 / 0.12), 0 0 0 200vmax rgb(0 0 0 / 0.5)",
        }}
      />
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        className="fixed flex flex-col gap-3 rounded-2xl border border-border/70 bg-popover p-5 text-popover-foreground shadow-[0_24px_64px_-24px_rgb(0_0_0/0.65)] transition-[left,top] duration-[420ms] ease-drawer motion-reduce:transition-none"
        style={{ width: CARD_WIDTH, ...position }}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs tabular-nums text-muted-foreground">
            {index + 1} of {STOPS.length}
          </span>
          <IconBtn label="End the tour" className="-mr-2 -mt-1" onClick={onClose}>
            <XIcon />
          </IconBtn>
        </div>
        <div
          key={index}
          className="flex flex-col gap-3 motion-safe:animate-[onboarding-in_280ms_ease-out]"
        >
          <h2 id="tour-title" className="text-base font-medium text-foreground">
            {stop.title}
          </h2>
          <p className="text-[13px] leading-5 text-foreground/80">{stop.body}</p>
          {stop.keys ? (
            <ul className="flex flex-col gap-1.5">
              {stop.keys.map((k) => (
                <li key={k.command} className="flex items-center justify-between gap-3">
                  <span className="text-[13px] text-muted-foreground">{k.label}</span>
                  <ShortcutKeys command={k.command} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="flex gap-1" aria-hidden>
            {STOPS.map((stop, i) => (
              <span
                key={stop.target}
                className={cn(
                  "h-1.5 rounded-full transition-[width,background-color]",
                  i === index ? "w-4 bg-foreground" : "w-1.5 bg-foreground/20",
                )}
              />
            ))}
          </span>
          <span className="flex gap-2">
            {index > 0 ? (
              <Btn size="sm" variant="ghost" onClick={() => move(-1)}>
                Back
              </Btn>
            ) : null}
            <Btn ref={nextButton} size="sm" variant="primary" onClick={next}>
              {last ? "Done" : index === 0 ? "Start" : "Next"}
            </Btn>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
