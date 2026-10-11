import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProviderSettings } from "./types.js";

const fixture = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../platform.js", () => ({ platform: () => ({ kind: "desktop", appVersion: "test" }) }));
vi.mock("./settings.js", () => ({
  clearOpenClawBootstrapToken: vi.fn(),
  clearOpenClawDeviceToken: vi.fn(),
  getOpenClawBootstrapToken: async () => "",
  getOpenClawDeviceKey: async () => "",
  getOpenClawDeviceToken: async () => "",
  getOpenClawToken: async () => "test-token",
  setOpenClawDeviceKey: vi.fn(),
  setOpenClawDeviceToken: vi.fn(),
}));
vi.mock("@openclaw/gateway-client/browser", () => ({
  GatewayBrowserDeviceAuthLifecycle: class {
    buildPlan = vi.fn();
    acceptHello = vi.fn();
  },
  GatewayProtocolClient: class {
    constructor(private options: { onHello: (hello: object) => void }) {}
    start() {
      this.options.onHello({});
    }
    stop() {}
    request = fixture.request;
  },
}));
const { openClawProvider } = await import("./openclaw.js");
const settings = { openclaw: { url: "wss://gateway.test/openclaw" } } as ProviderSettings;
afterEach(() => {
  openClawProvider.shutdown();
  fixture.request.mockReset();
  vi.unstubAllGlobals();
});

describe("OpenClaw image previews", () => {
  it("reads remote screenshots through session media assets, including encoded file paths", async () => {
    fixture.request.mockResolvedValue({
      assets: [{ content: btoa("pixels"), mimeType: "image/png" }],
    });
    const file = await openClawProvider.readFile!(
      settings,
      "session",
      "file:///home/agent/test%20image.png",
    );
    expect(fixture.request).toHaveBeenCalledWith("sessions.files.assets", {
      sessionKey: "session",
      path: "/home/agent/test image.png",
      refs: ["test%20image.png"],
    });
    expect(file).toEqual({
      name: "test image.png",
      mimeType: "image/png",
      data: btoa("pixels"),
      size: 6,
    });
  });

  it("downloads canonical image artifacts over the existing authenticated connection", async () => {
    fixture.request.mockResolvedValue({
      artifact: { title: "Confirmation", mimeType: "image/png" },
      encoding: "base64",
      data: btoa("pixels"),
    });
    const file = await openClawProvider.readFile!(
      settings,
      "session",
      "otter-artifact:managed%3Aimage%3A123",
    );
    expect(fixture.request).toHaveBeenCalledWith("artifacts.download", {
      sessionKey: "session",
      artifactId: "managed:image:123",
    });
    expect(file.data).toBe(btoa("pixels"));
  });

  it("keeps the gateway base path for ticketed downloads without forwarding its token", async () => {
    fixture.request.mockResolvedValue({
      artifact: { title: "Confirmation", mimeType: "image/png" },
      url: "/api/chat/media/outgoing/image/id/full?ticket=one-use",
    });
    const fetch = vi.fn(
      async () => new Response("pixels", { headers: { "Content-Type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const file = await openClawProvider.readFile!(
      settings,
      "session",
      "otter-artifact:managed%3Aimage%3A123",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://gateway.test/openclaw/api/chat/media/outgoing/image/id/full?ticket=one-use",
      { signal: expect.any(AbortSignal) },
    );
    expect(file.name).toBe("Confirmation");
    expect(file.data).toBe(btoa("pixels"));
  });

  it("reports denied or unavailable media without treating a remote path as a local file", async () => {
    fixture.request.mockResolvedValue({ assets: [{ error: "outside_session_boundary" }] });
    await expect(
      openClawProvider.readFile!(settings, "session", "/home/agent/image.png"),
    ).rejects.toThrow("couldn't read this image");
  });
});
