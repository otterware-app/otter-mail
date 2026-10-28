import { describe, expect, it } from "vite-plus/test";
import { chatUrlTransform, isChatFileLink, isChatImageLink } from "./chat-links";

describe("agent image and file links", () => {
  it("preserves local and gateway references for the chat preview", () => {
    for (const href of [
      "file:///tmp/confirmation.png",
      "sandbox:/mnt/data/confirmation.png",
      "/home/agent/confirmation.png",
      "./output/confirmation.png",
      "otter-artifact:managed%3Aimage%3A123",
    ]) {
      expect(isChatFileLink(href)).toBe(true);
      expect(chatUrlTransform(href)).toBe(href);
    }
    expect(isChatFileLink("https://example.com/image.png")).toBe(false);
    expect(isChatImageLink("https://example.com/image.png?ticket=1")).toBe(true);
  });

  it("allows Hermes inline images without allowing arbitrary data or executable URLs", () => {
    const image = "data:image/png;base64,aGVsbG8=";
    expect(chatUrlTransform(image)).toBe(image);
    expect(isChatImageLink(image)).toBe(true);
    for (const href of [
      "javascript:alert(1)",
      "javascript:evil.png",
      "data:text/html;base64,aGVsbG8=",
      "data:image/svg+xml;base64,aGVsbG8=",
    ])
      expect(chatUrlTransform(href)).toBe("");
  });
});
