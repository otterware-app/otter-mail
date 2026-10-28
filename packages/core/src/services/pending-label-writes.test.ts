import { landLabelChange } from "@otter-mail/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { GmailMessageSummary } from "../types.ts";
import { trackLabelWrite, withPendingLabels } from "./pending-label-writes.ts";

describe("How a label change lands", () => {
  const land = (labels: string[], add: string[], remove: string[], archiveFolder = true) =>
    landLabelChange(labels, add, remove, { archiveFolder });

  it("archives Gmail's way: INBOX just goes", () => {
    expect(land(["INBOX", "UNREAD"], [], ["INBOX"], false)).toEqual({ add: [], remove: ["INBOX"] });
    expect(land(["Label_1"], ["INBOX"], [], false)).toEqual({ add: ["INBOX"], remove: [] });
  });

  it("puts mail out of the inbox, or out of a folder of yours, in the Archive", () => {
    expect(land(["INBOX", "UNREAD", "category:Finance"], [], ["INBOX"])).toEqual({
      add: ["ARCHIVE"],
      remove: ["INBOX"],
    });
    expect(land(["folder:Clients"], [], ["folder:Clients"]).add).toEqual(["ARCHIVE"]);
    expect(land(["Work", "STARRED"], [], ["Work"]).add).toEqual(["ARCHIVE"]);
  });

  it("leaves mail that wasn't in the inbox where it is", () => {
    // A conversation's reply in Sent, archived with it.
    expect(land(["SENT"], [], ["INBOX"])).toEqual({ add: [], remove: ["INBOX"] });
    // Moved to Junk or a folder, rather than archived.
    expect(land(["INBOX"], ["SPAM"], ["INBOX"]).add).toEqual(["SPAM"]);
    expect(land(["INBOX"], ["folder:Clients"], ["INBOX"]).add).toEqual(["folder:Clients"]);
    // Out of Junk or Trash: back where it came from, not the Archive.
    expect(land(["SPAM"], ["INBOX"], ["SPAM"]).add).toEqual(["INBOX"]);
    expect(land(["TRASH"], [], ["TRASH"]).add).toEqual([]);
    // Flags and categories aren't folders.
    expect(land(["INBOX"], ["STARRED"], ["UNREAD", "category:Finance"])).toEqual({
      add: ["STARRED"],
      remove: ["UNREAD", "category:Finance"],
    });
  });

  it("takes mail put in a folder out of the Archive", () => {
    expect(land(["ARCHIVE", "UNREAD"], ["INBOX"], [])).toEqual({
      add: ["INBOX"],
      remove: ["ARCHIVE"],
    });
    expect(land(["ARCHIVE"], ["TRASH"], []).remove).toEqual(["ARCHIVE"]);
    expect(land(["ARCHIVE"], ["folder:Clients"], ["ARCHIVE"]).remove).toEqual(["ARCHIVE"]);
    expect(land(["INBOX"], ["ARCHIVE"], ["INBOX"])).toEqual({
      add: ["ARCHIVE"],
      remove: ["INBOX"],
    });
  });

  it("keeps a conversation's own mail in Sent and Drafts unless it's trashed", () => {
    const thread = (labels: string[], add: string[], remove: string[] = []) =>
      landLabelChange(labels, add, remove, { archiveFolder: true, thread: true });
    // Back to the inbox (undoing an archive): your reply stays in Sent.
    expect(thread(["SENT"], ["INBOX"])).toEqual({ add: [], remove: [] });
    expect(thread(["ARCHIVE", "UNREAD"], ["INBOX"])).toEqual({
      add: ["INBOX"],
      remove: ["ARCHIVE"],
    });
    expect(thread(["DRAFT"], ["folder:Clients", "STARRED"])).toEqual({
      add: ["STARRED"],
      remove: [],
    });
    expect(thread(["SENT"], ["TRASH"]).add).toEqual(["TRASH"]);
    // One message of it, moved on its own, goes.
    expect(land(["SENT"], ["INBOX"], []).add).toEqual(["INBOX"]);
    // Gmail's labels go on every message of a conversation.
    expect(landLabelChange(["SENT"], ["INBOX"], [], { thread: true }).add).toEqual(["INBOX"]);
  });
});

describe("Pending label writes", () => {
  const message = (id: string, labelIds: string[]): GmailMessageSummary => ({
    id,
    threadId: id,
    fromName: "",
    fromEmail: "bob@example.com",
    to: "",
    subject: "",
    snippet: "",
    date: 0,
    unread: false,
    starred: false,
    labelIds,
    hasAttachments: false,
  });

  it("keeps mail archived into a folder there while the server still shows it in the inbox", () => {
    const write = trackLabelWrite("me@outlook.test", ["a"], [], ["INBOX"], { archiveFolder: true });
    const [stale] = withPendingLabels("me@outlook.test", [message("a", ["INBOX", "UNREAD"])]);
    expect(stale!.labelIds.sort()).toEqual(["ARCHIVE", "UNREAD"]);
    // Once the server has moved it, its answer stands.
    const [moved] = withPendingLabels("me@outlook.test", [message("a", ["ARCHIVE"])]);
    expect(moved!.labelIds).toEqual(["ARCHIVE"]);
    write.dropped();
  });

  it("keeps Gmail's archive as it is", () => {
    const write = trackLabelWrite("me@gmail.test", ["a"], [], ["INBOX"]);
    const [stale] = withPendingLabels("me@gmail.test", [message("a", ["INBOX", "UNREAD"])]);
    expect(stale!.labelIds).toEqual(["UNREAD"]);
    write.dropped();
  });
});
