import { describe, expect, it, vi } from "vite-plus/test";
import type { ImapSettings } from "@otter-mail/contracts";
import type { RelayAccount } from "@otter-mail/contracts/relay";

vi.mock("electron", () => ({ app: {}, safeStorage: {}, shell: {}, BrowserWindow: {} }));

// Signed in to an Otter account that links a@x.com, with the relay's requests kept.
const relayRequests = vi.hoisted((): unknown[][] => []);
vi.mock("./otter-account.ts", () => ({
  getOtterUser: () => ({ id: "u" }),
  relayRequest: async (...args: unknown[]) => {
    relayRequests.push(args);
    return null;
  },
  RelayError: class extends Error {},
}));
vi.mock("./mail-store.ts", () => ({ getKv: () => '["a@x.com"]', setKv: () => {} }));

const { accountEdited, accountFromRelay, linkRequest, planReconcile } =
  await import("./linked-accounts.ts");

const local = (
  email: string,
  extra: {
    signedIn?: boolean;
    displayName?: string;
    color?: string;
    name?: string;
    picture?: string;
    imap?: ImapSettings;
  } = {},
) => ({
  email,
  name: extra.name ?? "A",
  picture: extra.picture,
  imap: extra.imap,
  signedIn: extra.signedIn ?? true,
  displayName: extra.displayName,
  color: extra.color,
});

const remote = (email: string, extra: Partial<RelayAccount> = {}): RelayAccount => ({
  email,
  provider: "gmail",
  imap: null,
  name: null,
  picture: null,
  displayName: null,
  color: null,
  ...extra,
});

const none = { link: [], unlink: [], add: [], remove: [], update: [], moved: [] };

describe("planReconcile", () => {
  it("does nothing when both sides agree", () => {
    const plan = planReconcile([local("a@x.com")], [remote("a@x.com")], new Set(["a@x.com"]));
    expect(plan).toEqual(none);
  });

  it("a signed-out Gmail account follows the relay's name and picture", () => {
    const here = local("a@x.com", { signedIn: false, picture: "old" });
    const there = remote("a@x.com", { name: "A", picture: "new" });
    expect(planReconcile([here], [there], new Set(["a@x.com"]))).toEqual({
      ...none,
      update: [there],
    });
  });

  it("a signed-in Gmail account keeps its own name and picture", () => {
    const there = remote("a@x.com", { name: "Other", picture: "new" });
    const plan = planReconcile(
      [local("a@x.com", { picture: "old" })],
      [there],
      new Set(["a@x.com"]),
    );
    expect(plan).toEqual(none);
  });

  it("a signed-in Gmail account recolored elsewhere still keeps its own picture", () => {
    const there = remote("a@x.com", { name: "Other", picture: "new", color: "#f00" });
    const plan = planReconcile(
      [local("a@x.com", { picture: "old" })],
      [there],
      new Set(["a@x.com"]),
    );
    expect(plan).toEqual({ ...none, update: [{ ...there, name: null, picture: null }] });
  });

  it("a relay row without a picture never blanks the local one", () => {
    const here = local("a@x.com", { signedIn: false, picture: "mine" });
    expect(planReconcile([here], [remote("a@x.com")], new Set(["a@x.com"]))).toEqual(none);
  });

  it("an IMAP account follows the relay's picture", () => {
    const settings = { imap: { host: "i" }, smtp: { host: "s" } } as ImapSettings;
    const there = remote("a@x.com", { provider: "imap", imap: settings, picture: "new" });
    const here = local("a@x.com", { imap: settings, picture: "old" });
    expect(planReconcile([here], [there], new Set(["a@x.com"]))).toEqual({
      ...none,
      update: [there],
    });
  });

  it("first sign-in merges: links what's here, adds what's there", () => {
    const plan = planReconcile(
      [local("here@x.com"), local("both@x.com")],
      [remote("there@x.com"), remote("both@x.com")],
      new Set(),
    );
    expect(plan).toEqual({ ...none, link: ["here@x.com"], add: [remote("there@x.com")] });
  });

  it("can't link a signed-out account (no proof); leaves it alone", () => {
    const plan = planReconcile([local("out@x.com", { signedIn: false })], [], new Set());
    expect(plan).toEqual(none);
  });

  it("an account linked last time and now gone from the relay was removed elsewhere", () => {
    const plan = planReconcile(
      [local("a@x.com"), local("b@x.com")],
      [remote("a@x.com")],
      new Set(["a@x.com", "b@x.com"]),
    );
    expect(plan).toEqual({ ...none, remove: ["b@x.com"] });
  });

  it("an account linked last time and now gone from here was removed here", () => {
    const plan = planReconcile(
      [local("a@x.com")],
      [remote("a@x.com"), remote("b@x.com")],
      new Set(["a@x.com", "b@x.com"]),
    );
    expect(plan).toEqual({ ...none, unlink: ["b@x.com"] });
  });

  it("takes profile edits made elsewhere", () => {
    const edited = remote("a@x.com", { displayName: "Work", color: "#f00" });
    const plan = planReconcile([local("a@x.com")], [edited], new Set(["a@x.com"]));
    expect(plan).toEqual({ ...none, update: [edited] });

    const same = planReconcile(
      [local("a@x.com", { displayName: "Work", color: "#f00" })],
      [edited],
      new Set(["a@x.com"]),
    );
    expect(same).toEqual(none);
  });

  it("compares addresses without case", () => {
    const plan = planReconcile([local("Me@X.com")], [remote("me@x.com")], new Set());
    expect(plan).toEqual(none);
  });
});

const imapSettings = {
  username: "me@fastmail.com",
  imap: { host: "imap.fastmail.com", port: 993, security: "tls" as const },
  smtp: { host: "smtp.fastmail.com", port: 465, security: "tls" as const },
};

describe("IMAP mailboxes", () => {
  it("adds one linked elsewhere, like Gmail", () => {
    const linked = remote("me@fastmail.com", { provider: "imap", imap: imapSettings });
    const plan = planReconcile([], [linked], new Set());
    expect(plan).toEqual({ ...none, add: [linked] });
  });

  it("arrives with its settings, signed out (no password here)", () => {
    const linked = remote("me@fastmail.com", {
      provider: "imap",
      imap: imapSettings,
      name: "Me",
      color: "#0a0",
    });
    expect(accountFromRelay(linked)).toEqual({
      id: "me@fastmail.com",
      email: "me@fastmail.com",
      name: "Me",
      provider: "imap",
      imap: imapSettings,
      signature: undefined,
      picture: undefined,
      displayName: undefined,
      color: "#0a0",
    });
  });

  it("never adopts other servers for a mailbox signed in here; asks for the password", () => {
    const here = { ...local("me@fastmail.com"), imap: imapSettings };
    const elsewhere = (host: string) =>
      remote("me@fastmail.com", {
        provider: "imap",
        imap: { ...imapSettings, imap: { ...imapSettings.imap, host } },
      });
    const linked = new Set(["me@fastmail.com"]);
    expect(planReconcile([here], [elsewhere("IMAP.fastmail.com")], linked)).toEqual(none);
    expect(planReconcile([here], [elsewhere("imap.evil.example")], linked)).toEqual({
      ...none,
      moved: ["me@fastmail.com"],
    });
    // Signed out here: nothing to protect (the prompt names the host).
    const out = { ...here, signedIn: false };
    expect(planReconcile([out], [elsewhere("imap.evil.example")], linked)).toEqual(none);
  });

  it("a Gmail account from the relay stays a plain Gmail account", () => {
    const account = accountFromRelay(remote("a@gmail.com"));
    expect(account.provider).toBeUndefined();
    expect(account.imap).toBeUndefined();
  });

  it("links with its settings and no ID token", async () => {
    const idToken = vi.fn(async () => "token");
    const body = await linkRequest(
      {
        id: "me@fastmail.com",
        email: "me@fastmail.com",
        name: "Me",
        provider: "imap",
        imap: imapSettings,
        color: "#0a0",
      },
      idToken,
    );
    expect(body).toEqual({
      provider: "imap",
      imap: imapSettings,
      name: "Me",
      picture: null,
      displayName: null,
      color: "#0a0",
    });
    expect(idToken).not.toHaveBeenCalled();
  });

  it("Gmail still links with an ID token", async () => {
    const body = await linkRequest(
      { id: "a@gmail.com", email: "a@gmail.com", name: "A" },
      async (id) => `token-for-${id}`,
    );
    expect(body).toMatchObject({ idToken: "token-for-a@gmail.com", name: "A" });
    expect(body).not.toHaveProperty("provider");
  });

  it("Outlook links with a Microsoft ID token, never its photo", async () => {
    const body = await linkRequest(
      {
        id: "me@contoso.com",
        email: "me@contoso.com",
        name: "Me",
        provider: "outlook",
        picture: "data:image/jpeg;base64,AAAA",
      },
      async (id) => `token-for-${id}`,
    );
    expect(body).toEqual({
      provider: "outlook",
      idToken: "token-for-me@contoso.com",
      name: "Me",
      picture: null,
      displayName: null,
      color: null,
    });
  });

  it("an Outlook mailbox from the relay stays Outlook", () => {
    const account = accountFromRelay({ ...remote("me@contoso.com"), provider: "outlook" });
    expect(account.provider).toBe("outlook");
    expect(account.imap).toBeUndefined();
  });
});

describe("accountEdited", () => {
  const account = {
    id: "a@x.com",
    email: "a@x.com",
    name: "Ada",
    picture: "https://example.com/a.png",
    displayName: "Work",
    color: "#f00",
  };

  it("a new label or color sends just those, never this device's name and picture", async () => {
    relayRequests.length = 0;
    await accountEdited(account, ["displayName", "color"]);
    expect(relayRequests).toEqual([
      [
        "PUT",
        "/v1/accounts/a%40x.com?providers=gmail,imap,outlook",
        { displayName: "Work", color: "#f00" },
      ],
    ]);
  });

  it("Google's name and picture go without the label and color", async () => {
    relayRequests.length = 0;
    await accountEdited(account, ["name", "picture"]);
    expect(relayRequests[0]?.[2]).toEqual({ name: "Ada", picture: "https://example.com/a.png" });
  });
});
