import { describe, expect, it } from "vite-plus/test";

import { isMoveSourceLabel } from "./thread-drag";

describe("Outlook folder moves", () => {
  it("keeps categories and flags when moving mail from their views", () => {
    for (const source of ["category:Finance", "STARRED", "IMPORTANT", "UNREAD"])
      for (const target of ["folder:Clients", "INBOX"])
        expect(isMoveSourceLabel(source, target, true)).toBe(false);
  });

  it("keeps the current folder and other categories when categorizing", () => {
    for (const source of ["INBOX", "folder:Clients", "category:Finance"])
      expect(isMoveSourceLabel(source, "category:Urgent", true)).toBe(false);
  });

  it("leaves the source folder while retaining Gmail's label-move behavior", () => {
    expect(isMoveSourceLabel("INBOX", "folder:Clients", true)).toBe(true);
    expect(isMoveSourceLabel("folder:Clients", "INBOX", true)).toBe(true);
    expect(isMoveSourceLabel("ARCHIVE", "folder:Clients", true)).toBe(true);
    expect(isMoveSourceLabel("ARCHIVE", "category:Urgent", true)).toBe(false);
    expect(isMoveSourceLabel("Label_1", "Label_2")).toBe(true);
    expect(isMoveSourceLabel("SENT", "Label_2")).toBe(false);
  });
});
