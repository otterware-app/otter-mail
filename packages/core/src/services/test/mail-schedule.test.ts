import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Platform, SqlDatabase } from "../../platform.js";
import type { GmailMessageSummary } from "../../types.js";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  saveDraft: vi.fn(),
  getSummaries: vi.fn(),
  modifyThread: vi.fn(),
  modifyMessage: vi.fn(),
  getAccount: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock("../../providers/index.js", () => ({ providerFor: () => mocks }));
vi.mock("../account-store.js", () => ({ getAccount: mocks.getAccount }));
vi.mock("../notifier.js", () => ({ updateDockBadge: () => {} }));
let database: DatabaseSync;
let schedule: typeof import("../mail-schedule.js");
let store: typeof import("../mail-store.js");
const mail = {
  to: "you@example.com",
  subject: "Later",
  body: "Hello",
  bodyHtml: "<b>Hello</b>",
  inReplyTo: "reply-id",
  attachments: [{ name: "file.txt", mimeType: "text/plain", size: 1, base64: "YQ==" }],
};
const row = (id: string, labels: string[]): GmailMessageSummary => ({
  id,
  threadId: "thread",
  subject: "Later",
  fromEmail: "you@example.com",
  fromName: "You",
  to: "me@example.com",
  snippet: "Hello",
  date: 1,
  unread: false,
  starred: false,
  labelIds: labels,
  hasAttachments: false,
});

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  database = new DatabaseSync(":memory:");
  const { setPlatform } = await import("../../platform.js");
  setPlatform({
    database: () => database as unknown as SqlDatabase,
    broadcast: mocks.broadcast,
    onResume: () => () => {},
    log: () => {},
  } as unknown as Platform);
  schedule = await import("../mail-schedule.js");
  store = await import("../mail-store.js");
  mocks.getAccount.mockResolvedValue({ id: "me" });
  mocks.send.mockResolvedValue({});
  mocks.getSummaries.mockResolvedValue([]);
  mocks.saveDraft.mockResolvedValue({ draftId: "draft" });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  database.close();
});

describe("persistent mail scheduling", () => {
  it("sends only when due, with replies and attachments intact, even with concurrent ticks", async () => {
    schedule.scheduleSend("me", mail, Date.now() + 60_000);
    await schedule.processSchedules();
    expect(mocks.send).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 60_000);
    await Promise.all([schedule.processSchedules(), schedule.processSchedules()]);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith("me", mail);
    expect(schedule.listSchedules()).toEqual([]);
  });
  it("loads overdue work from the durable queue after restarting the service", async () => {
    schedule.scheduleSend("me", mail, Date.now() + 60_000);
    vi.resetModules();
    const { setPlatform } = await import("../../platform.js");
    setPlatform({
      database: () => database as unknown as SqlDatabase,
      broadcast: mocks.broadcast,
    } as unknown as Platform);
    const restarted = await import("../mail-schedule.js");
    vi.setSystemTime(Date.now() + 120_000);
    await restarted.processSchedules();
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith("me", mail);
    expect(restarted.listSchedules()).toEqual([]);
  });
  it("rejects invalid and past times", () => {
    for (const time of [NaN, Infinity, Date.now(), Date.now() - 1])
      expect(() => schedule.scheduleSend("me", mail, time)).toThrow("future");
    expect(schedule.listSchedules()).toEqual([]);
  });
  it("does not retry an uncertain delivery", async () => {
    mocks.send.mockRejectedValue(new Error("Connection lost"));
    schedule.scheduleSend("me", mail, Date.now() + 1);
    vi.setSystemTime(Date.now() + 2);
    await schedule.processSchedules();
    await schedule.processSchedules();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(schedule.listSchedules()[0]).toMatchObject({
      state: "failed",
      error: "Connection lost",
    });
  });
  it("cancels into Drafts without sending, even if mirroring fails", async () => {
    mocks.saveDraft.mockResolvedValue({ draftId: "draft", messageId: "new-draft" });
    mocks.getSummaries.mockRejectedValue(new Error("Offline"));
    schedule.scheduleSend("me", mail, Date.now() + 1);
    await schedule.cancelSchedule(schedule.listSchedules()[0].id);
    vi.setSystemTime(Date.now() + 2);
    await schedule.processSchedules();
    expect(mocks.saveDraft).toHaveBeenCalledExactlyOnceWith("me", mail);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(schedule.listSchedules()).toEqual([]);
  });
  it("retains the payload when restoring to Drafts fails", async () => {
    mocks.saveDraft.mockRejectedValue(new Error("Offline"));
    schedule.scheduleSend("me", mail, Date.now() + 1);
    await expect(schedule.cancelSchedule(schedule.listSchedules()[0].id)).rejects.toThrow(
      "Offline",
    );
    expect(schedule.listSchedules()[0].state).toBe("failed");
    expect(
      JSON.parse(String(database.prepare("SELECT payload FROM mail_schedule").get()!.payload)),
    ).toEqual(mail);
  });
  it("honors cancellation while a due tick is looking up the account", async () => {
    let release!: (account: { id: string }) => void;
    mocks.getAccount.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    mocks.saveDraft.mockRejectedValue(new Error("Offline"));
    schedule.scheduleSend("me", mail, Date.now() + 1);
    vi.setSystemTime(Date.now() + 2);
    const tick = schedule.processSchedules();
    await expect(schedule.cancelSchedule(schedule.listSchedules()[0].id)).rejects.toThrow(
      "Offline",
    );
    release({ id: "me" });
    await tick;
    expect(mocks.send).not.toHaveBeenCalled();
    expect(schedule.listSchedules()[0].state).toBe("failed");
  });
  it("never sends queued mail for a removed account", async () => {
    mocks.getAccount.mockResolvedValue(null);
    schedule.scheduleSend("me", mail, Date.now() + 1);
    vi.setSystemTime(Date.now() + 2);
    await schedule.processSchedules();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(schedule.listSchedules()).toEqual([]);
  });
  it("recovers interrupted claims without resending them on restart", async () => {
    schedule.scheduleSend("me", mail, Date.now() + 1);
    database.prepare("UPDATE mail_schedule SET state = 'running'").run();
    vi.setSystemTime(Date.now() + 2);
    schedule.startMailSchedule();
    await schedule.processSchedules();
    expect(schedule.listSchedules()[0]).toMatchObject({ state: "failed" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("archives snoozed conversations and restores received mail, leaving Sent and Trash alone", async () => {
    store.upsertMessages("me", [row("received", ["INBOX"]), row("reply", ["SENT"])]);
    await schedule.snoozeThread("me", "thread", Date.now() + 1);
    expect(store.getMessageLabelIds("me", "received")).not.toContain("INBOX");
    expect(mocks.modifyThread).toHaveBeenCalledWith("me", "thread", { removeLabelIds: ["INBOX"] });
    mocks.getSummaries.mockResolvedValue([
      row("received", []),
      row("reply", ["SENT"]),
      row("trashed", ["TRASH"]),
    ]);
    vi.setSystemTime(Date.now() + 2);
    await schedule.processSchedules();
    expect(mocks.modifyMessage).toHaveBeenCalledExactlyOnceWith("me", "received", {
      addLabelIds: ["INBOX"],
    });
    expect(store.getMessageLabelIds("me", "received")).toContain("INBOX");
    expect(schedule.listSchedules()).toEqual([]);
  });
  it("returns a snoozed email sent to yourself to the inbox", async () => {
    store.upsertMessages("me", [row("self", ["SENT", "INBOX"])]);
    await schedule.snoozeThread("me", "thread", Date.now() + 60_000);
    mocks.getSummaries.mockResolvedValue([row("self", ["SENT"])]);
    await schedule.cancelSchedule(schedule.listSchedules()[0].id);
    expect(mocks.modifyMessage).toHaveBeenCalledExactlyOnceWith("me", "self", {
      addLabelIds: ["INBOX"],
    });
  });
  it("prevents overlapping snoozes and supports waking early", async () => {
    store.upsertMessages("me", [row("received", ["INBOX"])]);
    await schedule.snoozeThread("me", "thread", Date.now() + 60_000);
    await expect(schedule.snoozeThread("me", "thread", Date.now() + 90_000)).rejects.toThrow(
      "already snoozed",
    );
    mocks.getSummaries.mockResolvedValue([row("received", [])]);
    await schedule.cancelSchedule(schedule.listSchedules()[0].id);
    expect(mocks.modifyMessage).toHaveBeenCalledTimes(1);
    expect(schedule.listSchedules()).toEqual([]);
  });
  it("keeps a failed archive recoverable", async () => {
    store.upsertMessages("me", [row("received", ["INBOX"])]);
    mocks.modifyThread.mockRejectedValue(new Error("Offline"));
    await expect(schedule.snoozeThread("me", "thread", Date.now() + 60_000)).rejects.toThrow(
      "Offline",
    );
    expect(schedule.listSchedules()[0].state).toBe("failed");
    expect(store.getMessageLabelIds("me", "received")).toContain("INBOX");
  });
});
