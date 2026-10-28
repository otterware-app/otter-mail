import { GMAIL_CAPABILITIES, IMAP_CAPABILITIES, OUTLOOK_CAPABILITIES } from "@otter-mail/contracts";
import { describe, expect, it } from "vite-plus/test";

import { summarizeLabelChange } from "./action-summary";
import { archiveFrom } from "./archive";
import { folderName } from "./label-names";
import type { GmailLabel } from "./types";

const folder = (id: string): GmailLabel => ({ id, name: id, type: "user" });
const system = (id: string): GmailLabel => ({ id, name: id, type: "system" });

describe("What archiving takes off", () => {
  it("takes INBOX off, and offers Move to Inbox elsewhere, in Gmail", () => {
    expect(archiveFrom(["INBOX", "UNREAD"], system("INBOX"), GMAIL_CAPABILITIES)).toBe("INBOX");
    // A Gmail label is a label, not a folder: archive still means the inbox.
    expect(archiveFrom(["INBOX", "Label_1"], folder("Label_1"), GMAIL_CAPABILITIES)).toBe("INBOX");
    expect(archiveFrom(["Label_1"], folder("Label_1"), GMAIL_CAPABILITIES)).toBeNull();
  });

  it("archives from the folder listed where the Archive is a folder", () => {
    expect(archiveFrom(["folder:ops"], folder("folder:ops"), OUTLOOK_CAPABILITIES)).toBe(
      "folder:ops",
    );
    expect(archiveFrom(["Work", "STARRED"], folder("Work"), IMAP_CAPABILITIES)).toBe("Work");
    // An Outlook category is a tag: from its list, archive means the inbox.
    expect(
      archiveFrom(["INBOX", "category:Finance"], folder("category:Finance"), OUTLOOK_CAPABILITIES),
    ).toBe("INBOX");
    // In the Archive, Sent or a view: nothing to archive but the inbox's.
    expect(archiveFrom(["ARCHIVE"], system("ARCHIVE"), OUTLOOK_CAPABILITIES)).toBeNull();
    expect(archiveFrom(["INBOX", "folder:ops"], undefined, OUTLOOK_CAPABILITIES)).toBe("INBOX");
  });
});

describe("The toast for an archive", () => {
  const name = (id: string) => (id.startsWith("folder:") || id === "Work" ? id : undefined);
  it("says Archived when mail leaves a folder for the Archive", () => {
    expect(summarizeLabelChange([], ["folder:ops"], "conversation", name, true).verb).toBe(
      "Archived",
    );
    expect(summarizeLabelChange([], ["Work"], "conversation", name, false)).toMatchObject({
      verb: "Removed",
    });
    expect(summarizeLabelChange(["ARCHIVE"], ["INBOX"], "conversation", name, true).verb).toBe(
      "Archived",
    );
    expect(summarizeLabelChange([], ["ARCHIVE"], "conversation", name, true)).toMatchObject({
      verb: "Moved",
      suffix: " to Inbox",
    });
  });
});

describe("Folder names", () => {
  it("call Outlook's and IMAP's flag Flagged, Gmail's star Starred", () => {
    expect(folderName("STARRED", GMAIL_CAPABILITIES)).toBe("Starred");
    expect(folderName("STARRED", OUTLOOK_CAPABILITIES)).toBe("Flagged");
    expect(folderName("STARRED", IMAP_CAPABILITIES)).toBe("Flagged");
    expect(folderName("ARCHIVE", OUTLOOK_CAPABILITIES)).toBe("Archive");
    expect(folderName("SPAM", GMAIL_CAPABILITIES)).toBe("Junk");
  });
});
