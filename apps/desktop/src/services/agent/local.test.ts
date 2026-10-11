import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("../../backend-protocol.js", () => ({ appInfo: () => ({ stateDir: state.home }) }));
vi.mock("../../main-link.js", () => ({ requestMain: vi.fn() }));
vi.mock("@otter-mail/core", async () => ({
  ...(await import("../../../../../packages/core/src/services/agent/files.js")),
  ATTACHMENTS_DIR: "assistant-attachments",
}));
const { agentWorkspace, readAgentFile } = await import("./local.js");

beforeEach(async () => {
  state.home = await fs.mkdtemp(path.join(os.tmpdir(), "otter-agent-files-"));
});
afterEach(async () => {
  await fs.rm(state.home, { recursive: true, force: true });
});

describe("local agent images", () => {
  it("reads both relative Markdown images and encoded absolute file links from the agent workspace", async () => {
    const workspace = await agentWorkspace();
    const name = "test image.png";
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XYAAAAASUVORK5CYII=",
      "base64",
    );
    const file = path.join(workspace, name);
    await fs.writeFile(file, bytes);
    for (const href of ["./test%20image.png", `file://${file.replaceAll(" ", "%20")}`, file]) {
      const result = await readAgentFile(href);
      expect(result.name).toBe(name);
      expect(result.size).toBe(bytes.length);
      expect(Buffer.from(result.data, "base64")).toEqual(bytes);
    }
  });

  it("reports missing files and rejects directories and remote file URLs", async () => {
    await expect(readAgentFile("./missing.png")).rejects.toThrow();
    await expect(readAgentFile(await agentWorkspace())).rejects.toThrow("doesn't point to a file");
    await expect(readAgentFile("file://another-computer/image.png")).rejects.toThrow(
      "another computer",
    );
  });
});
