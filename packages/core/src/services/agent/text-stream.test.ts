import { describe, expect, it } from "vite-plus/test";
import { TextStream } from "./text-stream.js";
import { OpenClawText, openClawMessageText } from "./openclaw-stream.js";
import type { ChatEvent } from "./types.js";

function transcript(events: ChatEvent[]): string[] {
  const messages = new Map<string, string>();
  for (const event of events) {
    if (event.type === "delta")
      messages.set(event.id!, (messages.get(event.id!) ?? "") + event.text);
    else if (event.type === "text") messages.set(event.id, event.text);
  }
  return [...messages.values()];
}

describe("assistant messages", () => {
  it("retains streamed commentary and a later complete reply that had no deltas", () => {
    const events: ChatEvent[] = [];
    const stream = new TextStream("run", (event) => events.push(event));
    stream.start("commentary");
    stream.append("I'll resume the LinkedIn cancellation.");
    stream.snapshot("I'll resume the LinkedIn cancellation.");
    stream.start("answer");
    stream.snapshot("Cancelled successfully.\n\n[View screenshot](/tmp/confirmation.png)");
    expect(transcript(events)).toEqual([
      "I'll resume the LinkedIn cancellation.",
      "Cancelled successfully.\n\n[View screenshot](/tmp/confirmation.png)",
    ]);
  });

  it("replaces raw MEDIA text with the resolved image and honors empty replacements", () => {
    const events: ChatEvent[] = [];
    const stream = new TextStream("run", (event) => events.push(event));
    stream.append("Done.\nMEDIA:/tmp/image.png");
    stream.snapshot("Done.\n![image](data:image/png;base64,aGVsbG8=)");
    expect(transcript(events)).toEqual(["Done.\n![image](data:image/png;base64,aGVsbG8=)"]);
    stream.snapshot("");
    expect(transcript(events)).toEqual([""]);
  });
});

describe("OpenClaw text projections", () => {
  it("keeps commentary and final text without duplicating chat snapshots", () => {
    const events: ChatEvent[] = [];
    const text = new OpenClawText("run", (event) => events.push(event));
    text.assistant({ itemId: "intro", text: "I'll resume", delta: "I'll resume" });
    text.chat({ message: { content: "I'll resume" } });
    text.assistant({ itemId: "intro", text: "I'll resume the LinkedIn cancellation." });
    text.boundary();
    text.assistant({ itemId: "answer", text: "Cancelled successfully." });
    text.chat(
      { message: { content: "I'll resume the LinkedIn cancellation.\nCancelled successfully." } },
      true,
    );
    expect(transcript(events)).toEqual([
      "I'll resume the LinkedIn cancellation.",
      "Cancelled successfully.",
    ]);
  });

  it("supports compact deltas, distinct assistant items, and revisions", () => {
    const events: ChatEvent[] = [];
    const text = new OpenClawText("run", (event) => events.push(event));
    text.assistant({ itemId: "a", text: "Checking" });
    text.assistant({ itemId: "a", delta: " now" });
    text.assistant({ itemId: "b", text: "Wrong" });
    text.assistant({ itemId: "b", text: "Correct", replace: true });
    expect(transcript(events)).toEqual(["Checking now", "Correct"]);
  });

  it("falls back to chat-only gateways and to a non-streaming final after tools", () => {
    const events: ChatEvent[] = [];
    const text = new OpenClawText("run", (event) => events.push(event));
    text.chat({ message: { content: "Checking" } });
    text.chat({ deltaText: " now" });
    text.boundary();
    text.chat({ message: { content: "Checking nowDone" } }, true);
    expect(transcript(events)).toEqual(["Checking now", "Done"]);
    const nextEvents: ChatEvent[] = [];
    const next = new OpenClawText("next", (event) => nextEvents.push(event));
    next.assistant({ text: "Checking" });
    next.boundary();
    next.chat({ message: { content: "Done" } }, true);
    expect(transcript(nextEvents)).toEqual(["Checking", "Done"]);
  });

  it("shows a reply re-sent under a new item, or again as the final message, once", () => {
    const events: ChatEvent[] = [];
    const text = new OpenClawText("run", (event) => events.push(event));
    text.assistant({ itemId: "a", text: "Done." });
    text.assistant({ itemId: "b", delta: "Do" });
    text.assistant({ itemId: "b", delta: "ne." });
    text.assistant({ itemId: "c", text: "" });
    text.chat({ message: { content: "Done." } }, true);
    expect(transcript(events)).toEqual(["Done."]);
  });

  it("still shows a new item that only starts like the one before", () => {
    const events: ChatEvent[] = [];
    const text = new OpenClawText("run", (event) => events.push(event));
    text.assistant({ itemId: "a", text: "Done." });
    text.assistant({ itemId: "b", delta: "Do" });
    text.assistant({ itemId: "b", delta: "ing more." });
    expect(transcript(events)).toEqual(["Done.", "Doing more."]);
  });

  it("keeps generated image references in live replies and session history", () => {
    const message = {
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Done." },
        {
          type: "image",
          artifactId: "managed:image:123",
          alt: "Confirmation",
          url: "/api/private",
        },
      ],
    };
    expect(openClawMessageText(message)).toBe(
      "Done.\n\n![Confirmation](<otter-artifact:managed%3Aimage%3A123>)\n\n",
    );
    const events: ChatEvent[] = [];
    const text = new OpenClawText("run", (event) => events.push(event));
    text.assistant({ text: "Done." });
    text.chat({ message }, true);
    expect(transcript(events)).toEqual([openClawMessageText(message)]);
  });
});
