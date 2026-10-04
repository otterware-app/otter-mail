/**
 * What an agent did during a turn, as ChatGPT shows it: its commentary and
 * steps in order, an integration's steps grouped ("Used Otter Mail
 * integration"), and each step opening to its input and result. Every agent
 * describes its steps the same way (ToolStep, core's steps.ts), so they read
 * the same here.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CodeXmlIcon,
  CommandIcon,
  FilePenLineIcon,
  FileTextIcon,
  GlobeIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ToolStep } from "./api";
import { ChatMarkdown } from "./chat-markdown";
import { cn } from "./ui";

/** A turn's content in order: what the agent said, and the steps it took. */
export type TurnItem =
  | { kind: "text"; text: string }
  | { kind: "step"; id?: string; step: ToolStep; output?: string };

const STEP_ICONS: Record<ToolStep["kind"], typeof WrenchIcon> = {
  command: TerminalIcon,
  read: FileTextIcon,
  edit: FilePenLineIcon,
  search: SearchIcon,
  web: GlobeIcon,
  skill: WrenchIcon,
  tool: WrenchIcon,
};

/** An integration's steps wear its mark; the others, what they do. */
const stepIcon = (step: ToolStep) => (step.source ? CommandIcon : STEP_ICONS[step.kind]);

type Step = Extract<TurnItem, { kind: "step" }>;

type Block =
  | { kind: "text"; text: string }
  | { kind: "step"; item: Step }
  | { kind: "group"; source: string; items: Step[] };

/** Runs of two or more steps from the same integration become one group. */
function blocksOf(items: TurnItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    if (item.kind === "text") {
      blocks.push({ kind: "text", text: item.text });
      continue;
    }
    const last = blocks[blocks.length - 1];
    const source = item.step.source;
    if (source && last?.kind === "group" && last.source === source) last.items.push(item);
    else if (source && last?.kind === "step" && last.item.step.source === source)
      blocks[blocks.length - 1] = { kind: "group", source, items: [last.item, item] };
    else blocks.push({ kind: "step", item });
  }
  return blocks;
}

/* oxlint-disable react/no-array-index-key -- Transcript blocks append and update in place; position preserves streaming row state. */
export function WorkLog({ items }: { items: TurnItem[] }) {
  return (
    <div className="flex flex-col py-1">
      {blocksOf(items).map((block, i) =>
        block.kind === "text" ? (
          <div key={i} className="min-w-0 px-1 py-2">
            <ChatMarkdown text={block.text} />
          </div>
        ) : block.kind === "group" ? (
          <StepGroup key={i} source={block.source} items={block.items} />
        ) : (
          <StepRow key={i} item={block.item} />
        ),
      )}
    </div>
  );
}
/* oxlint-enable react/no-array-index-key */

/** A row's icon, title and chevron; the rest of the log lines up under it. */
function RowHead({
  icon: Icon,
  title,
  open,
  expandable,
  pending,
  onToggle,
}: {
  icon: typeof WrenchIcon;
  title: string;
  open: boolean;
  expandable: boolean;
  pending?: boolean;
  onToggle: () => void;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      disabled={!expandable}
      aria-expanded={expandable ? open : undefined}
      onClick={onToggle}
      className={cn(
        "group/step flex min-w-0 max-w-full select-none items-center gap-1.5 self-start rounded-md px-0.5 py-0.5 text-left",
        expandable
          ? "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring/70"
          : "cursor-default",
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
        <Icon className="block size-4 shrink-0 stroke-2" aria-hidden />
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-sm leading-relaxed text-secondary-label",
          expandable && "group-hover/step:text-foreground",
          open && "text-foreground",
          pending && "animate-status-pulse",
        )}
      >
        {title}
      </span>
      {expandable ? (
        <Chevron
          className={cn(
            "size-3.5 shrink-0 text-icon-muted",
            !open && "opacity-0 group-hover/step:opacity-70",
          )}
          aria-hidden
        />
      ) : null}
    </button>
  );
}

/** "Used Otter Mail integration", open to its steps. */
/* oxlint-disable react/no-array-index-key -- Transcript blocks append and update in place; position preserves streaming row state. */
function StepGroup({ source, items }: { source: string; items: Step[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col">
      <RowHead
        icon={CommandIcon}
        title={`Used ${source} integration`}
        open={open}
        expandable
        pending={items.some((i) => i.output === undefined)}
        onToggle={() => setOpen((o) => !o)}
      />

      {open ? items.map((item, i) => <StepRow key={i} item={item} />) : null}
    </div>
  );
}
/* oxlint-enable react/no-array-index-key */

function StepRow({ item }: { item: Step }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(item.output || item.step.detail);
  return (
    <div className="flex flex-col">
      <RowHead
        icon={stepIcon(item.step)}
        title={item.step.title}
        open={open}
        expandable={expandable}
        pending={item.output === undefined}
        onToggle={() => setOpen((o) => !o)}
      />
      {open ? <StepResult step={item.step} output={item.output} /> : null}
    </div>
  );
}

/** Indents JSON that doesn't parse (the chat keeps only the start of long outputs). */
function indentJson(text: string): string {
  let out = "";
  let depth = 0;
  let inString = false;
  const newline = () => `\n${"  ".repeat(depth)}`;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "{" || c === "[") {
      depth += 1;
      out += c + newline();
    } else if (c === "}" || c === "]") {
      depth = Math.max(0, depth - 1);
      out += newline() + c;
    } else if (c === ",") out += c + newline();
    else if (c === ":") out += ": ";
    else if (!/\s/.test(c)) out += c;
  }
  return out;
}

/** The output as indented JSON when it is JSON (even cut short), else null. */
function prettyJson(text: string | undefined): string | null {
  if (!text || !/^\s*[[{]/.test(text)) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return indentJson(text.trim());
  }
}

/** JSON with its strings and values colored. */
function highlightJson(json: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of json.matchAll(
    /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
  )) {
    const index = match.index ?? 0;
    if (index > last) parts.push(json.slice(last, index));
    const token = match[0];
    parts.push(
      <span key={index} className={token.startsWith('"') ? "text-success" : "text-info"}>
        {token}
      </span>,
    );
    last = index + token.length;
  }
  parts.push(json.slice(last));
  return parts;
}

/** A step opened: what it was given, and what came back, in a code card. */
function StepResult({ step, output }: { step: ToolStep; output?: string }) {
  const json = prettyJson(output);
  const detail = prettyJson(step.detail) ?? step.detail;
  return (
    <div className="mb-2 ms-7 mt-1 flex min-w-0 flex-col overflow-hidden rounded-2xl bg-code">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-xs text-foreground">
        <CodeXmlIcon className="size-3.5" aria-hidden />
        <span>{json ? "json" : "text"}</span>
      </div>
      {detail && detail !== output ? (
        <pre className="mx-4 mt-1 max-h-24 select-text overflow-auto whitespace-pre-wrap break-all border-b border-border/40 pb-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {detail}
        </pre>
      ) : null}
      {output !== undefined ? (
        <FadingPre>{json ? highlightJson(json) : output}</FadingPre>
      ) : (
        <p className="px-4 pb-3 pt-1 text-xs text-muted-foreground">Running…</p>
      )}
    </div>
  );
}

/** A scrolling block that fades out at the bottom while there's more below. */
function FadingPre({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [more, setMore] = useState(false);
  const measure = () => {
    const el = ref.current;
    if (el) setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 4);
  };
  useLayoutEffect(measure, [children]);
  return (
    <pre
      ref={ref}
      onScroll={measure}
      className={cn(
        "max-h-72 select-text overflow-auto whitespace-pre-wrap break-words px-4 pb-4 pt-2 font-mono text-xs leading-relaxed text-foreground",
        more && "[mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]",
      )}
    >
      {children}
    </pre>
  );
}
