import { TextStream } from "./text-stream.js";
import type { Emit } from "./types.js";

/** Preserve assistant image references alongside its text, including in history. */
export function openClawMessageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: Record<string, unknown>) => {
      if (part?.type === "text") return String(part.text ?? "");
      if (part?.type !== "image") return "";
      const source = part.source as
        | { data?: string; media_type?: string; url?: string }
        | undefined;
      const href =
        typeof part.artifactId === "string"
          ? `otter-artifact:${encodeURIComponent(part.artifactId)}`
          : (part.url ??
            source?.url ??
            (source?.data ? `data:${source.media_type};base64,${source.data}` : undefined));
      if (typeof href !== "string") return "";
      const alt = String(part.alt ?? "Image").replace(/[[\]\\]/g, "");
      return `\n\n![${alt}](<${href}>)\n\n`;
    })
    .join("");
}

/** Prefer current-item assistant events; chat is a separate display projection. */
export class OpenClawText {
  private stream: TextStream;
  private agentSeen = false;
  private itemId: string | undefined;
  private chatText = "";
  // What was said since the last tool call: a new item that only repeats it
  // (the reply re-sent under another id, or again as the final message) stays
  // held back, unless it goes on to say something else.
  private said = "";
  private held: string | undefined;

  constructor(requestId: string, emit: Emit) {
    this.stream = new TextStream(requestId, emit);
  }

  boundary(): void {
    this.stream.start();
    this.itemId = undefined;
    this.said = "";
    this.held = undefined;
  }

  replay(): void {
    this.stream.replay();
  }

  assistant(data: Record<string, unknown>): void {
    const text = typeof data.text === "string" ? data.text : undefined;
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (text === undefined && !delta) return;
    this.agentSeen = true;
    const id = typeof data.itemId === "string" ? data.itemId : undefined;
    if (id && id !== this.itemId) {
      this.said = this.stream.text || this.said;
      this.stream.start(id);
      this.held = this.said ? "" : undefined;
    }
    this.itemId = id;
    this.show(text ?? (data.replace ? delta : (this.held ?? this.stream.text) + delta));
  }

  private show(text: string): void {
    if (this.held !== undefined) {
      if (this.said.startsWith(text)) {
        this.held = text;
        return;
      }
      this.held = undefined;
    }
    this.stream.snapshot(text);
  }

  chat(payload: Record<string, unknown>, final = false): void {
    const next = payload.message
      ? openClawMessageText(payload.message)
      : `${payload.replace ? "" : this.chatText}${String(payload.deltaText ?? "")}`;
    if (!this.agentSeen) {
      if (!payload.replace && next.startsWith(this.chatText))
        this.stream.append(next.slice(this.chatText.length));
      else this.stream.snapshot(next);
      this.chatText = next;
    } else if (final && !this.stream.text) {
      // A non-streaming final message after the last tool call.
      this.show(next);
    } else if (final) {
      const content = (payload.message as { content?: unknown })?.content;
      if (Array.isArray(content)) {
        const images = openClawMessageText({ content: content.filter((p) => p?.type === "image") });
        if (images && !this.stream.text.includes(images.trim())) this.stream.append(images);
      }
    }
  }
}
