import type { Emit } from "./types.js";

/** One assistant message at a time; snapshots backfill only that message. */
export class TextStream {
  private sequence = 0;
  private id: string;
  text = "";

  constructor(
    private requestId: string,
    private emit: Emit,
  ) {
    this.id = `${requestId}:text:0`;
  }

  start(id?: string): void {
    this.id = id ?? `${this.requestId}:text:${++this.sequence}`;
    this.text = "";
  }

  append(text: string): void {
    if (!text) return;
    this.text += text;
    this.emit({ requestId: this.requestId, type: "delta", id: this.id, text });
  }

  snapshot(text: string): void {
    if (text === this.text) return;
    if (text.startsWith(this.text)) this.append(text.slice(this.text.length));
    else {
      this.text = text;
      this.emit({ requestId: this.requestId, type: "text", id: this.id, text });
    }
  }
}
