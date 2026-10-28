import { describe, expect, it } from "vite-plus/test";
import type { ChatChange } from "./api";
import { mergeChatChanges } from "./chat-changes";

const draft = (accountId: string, action: ChatChange["action"], title: string): ChatChange => ({
  action,
  title,
  target: { kind: "draft", id: "draft-1", accountId },
});

describe("chat change summary", () => {
  it("keeps a created result's latest title without duplicating it", () => {
    expect(
      mergeChatChanges([draft("home", "created", "Dinner"), draft("home", "updated", "Saturday")]),
    ).toEqual([draft("home", "created", "Saturday")]);
  });

  it("doesn't merge matching draft ids across mailboxes", () => {
    expect(
      mergeChatChanges([draft("home", "created", "Dinner"), draft("work", "updated", "Agenda")]),
    ).toHaveLength(2);
  });

  it("keeps a deleted result's name and updates its status", () => {
    expect(
      mergeChatChanges([draft("home", "created", "Dinner"), draft("home", "deleted", "Draft")]),
    ).toEqual([draft("home", "deleted", "Dinner")]);
  });
});
