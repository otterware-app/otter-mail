/**
 * `pnpm dev:demo` and `pnpm dev:demo:desktop`: the demo mailboxes
 * (@otter-mail/contracts/demo) this device doesn't have yet are added at
 * startup, before the windows ask for any, so a fresh data home opens on
 * mail, past the setup. The shells call this in development only.
 */

import { parseDemoMailboxes, type DemoMailbox } from "@otter-mail/contracts/demo";

import { broadcast } from "../ipc.js";
import { logger } from "../logger.js";
import { platform } from "../platform.js";
import { addImapAccount } from "../handlers/imap-accounts.js";
import { saveOutlookAccount } from "../handlers/outlook-accounts.js";
import * as accountStore from "./account-store.js";
import { accountAdded } from "./linked-accounts.js";
import * as mailSync from "./mail-sync.js";
import { refreshSignatures } from "./signatures.js";

async function addDemoMailbox(mailbox: DemoMailbox): Promise<void> {
  if (mailbox.provider === "imap") {
    await addImapAccount({
      email: mailbox.email,
      password: mailbox.password,
      imap: { username: mailbox.username ?? mailbox.email, imap: mailbox.imap, smtp: mailbox.smtp },
    });
    return;
  }
  if (mailbox.provider === "outlook") {
    const addDemoAccount = platform().microsoft?.addDemoAccount;
    if (!addDemoAccount) throw new Error("This app can't add a demo Outlook mailbox.");
    await saveOutlookAccount(await addDemoAccount(mailbox));
    return;
  }
  const addDemoAccount = platform().google.addDemoAccount;
  if (!addDemoAccount) throw new Error("This app can't add a demo Gmail mailbox.");
  // As gmail:addAccount does after a sign-in.
  const account = await addDemoAccount(mailbox);
  mailSync.syncAccount(account.id, { force: true });
  void accountAdded(account);
  void refreshSignatures();
  broadcast("gmail:accounts-changed");
}

/** Adds the mailboxes in `json` (OTTER_MAIL_DEMO_MAILBOXES) that aren't here yet. */
export async function addDemoMailboxes(json: string): Promise<void> {
  const mailboxes = parseDemoMailboxes(json);
  const here = new Set((await accountStore.listAccounts()).map((account) => account.id));
  await Promise.all(
    mailboxes
      .filter((mailbox) => !here.has(mailbox.email.toLowerCase()))
      .map(async (mailbox) => {
        try {
          await addDemoMailbox(mailbox);
          logger.info("demo", `Added ${mailbox.email}`);
        } catch (err) {
          logger.warn("demo", `Couldn't add ${mailbox.email}: ${String(err)}`);
        }
      }),
  );
}
