import { describe, expect, it } from "vite-plus/test";
import { normalizeOpenClawUrl, parseOpenClawSetupCode } from "./openclaw.js";
import { openClawStep } from "./steps.js";

describe("OpenClaw", () => {
  it("reaches the gateway over its WebSocket, whatever address is pasted", () => {
    expect(normalizeOpenClawUrl("chris-agent-01.tail1234.ts.net")).toBe(
      "wss://chris-agent-01.tail1234.ts.net",
    );
    expect(normalizeOpenClawUrl("https://chris-agent-01.tail1234.ts.net/")).toBe(
      "wss://chris-agent-01.tail1234.ts.net",
    );
    expect(normalizeOpenClawUrl("ws://127.0.0.1:18789")).toBe("ws://127.0.0.1:18789");
  });

  it("shows its shell commands as commands", () => {
    expect(openClawStep("bash", { command: "/usr/bin/bash -lc date", cwd: "/w" })).toMatchObject({
      kind: "command",
      detail: "date",
    });
    expect(openClawStep("bash", { command: "bash -lc 'ls -la'" })).toMatchObject({
      detail: "ls -la",
    });
    expect(openClawStep("web_search", { query: "otters" }).kind).toBe("tool");
  });

  it("reads the address and bootstrap token from a setup code", () => {
    const code = btoa(
      JSON.stringify({ url: "wss://gw.tail1234.ts.net", bootstrapToken: "bt-1", expiresAtMs: 1 }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(parseOpenClawSetupCode(` ${code}\n`)).toEqual({
      url: "wss://gw.tail1234.ts.net",
      bootstrapToken: "bt-1",
      expiresAtMs: 1,
    });
    expect(parseOpenClawSetupCode("not a code")).toBeNull();
  });
});
