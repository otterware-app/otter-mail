/**
 * IMAP's part of a sync run (the engine around it is services/mail-sync.ts).
 *
 * Folders are listed and their STATUS read (the labels and their counts);
 * then each folder, INBOX first, is brought up to date on its own, with its
 * state in kv (UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ):
 *
 *  - first sync: every UID below the UIDNEXT seen at the start, newest first,
 *    200 at a time; resumable (the lowest UID done is kept after each page);
 *  - a new UIDVALIDITY: the folder's cached mail goes and it starts over;
 *  - after that: nothing when STATUS shows no change; else new UIDs from the
 *    stored UIDNEXT, flag changes since the stored HIGHESTMODSEQ (QRESYNC on
 *    SELECT, or CONDSTORE's CHANGEDSINCE), or every UID's flags on servers
 *    without mod-sequences; and when the folder's count doesn't match the
 *    cache, a UID SEARCH ALL finds what was expunged (QRESYNC also says).
 */

import { logger } from "../../logger.js";
import {
  ImapError,
  inUidRanges,
  type FetchedMessage,
  type ImapClient,
  type MailboxStatus,
  type SelectedMailbox,
  type UidRange,
} from "../../protocols/index.js";
import { hasPendingLabelWrites } from "../../services/pending-label-writes.js";
import * as store from "../../services/mail-store.js";
import type { MailLabel, MessageSummary } from "../../types.js";
import type { SyncContext } from "../provider.js";
import { FolderGone, inFolder, withImap } from "./connection.js";
import {
  FLAG_LABELS,
  labelsFor,
  listFolders,
  messageId,
  parseMessageId,
  type Folder,
  type Folders,
} from "./folders.js";
import { SUMMARY_QUERY, toSummary } from "./messages.js";

const PAGE = 200;
/** Without mod-sequences, flags are only compared when STATUS changed, or this often. */
const FLAG_CHECK_MS = 15 * 60_000;

interface FolderState {
  uidValidity: number;
  uidNext: number;
  /** HIGHESTMODSEQ, as text (a bigint); absent on servers without CONDSTORE. */
  modseq?: string;
  /** First sync: UIDs below this are still to fetch; 0 once done. */
  below: number;
  /** The label the folder's cached mail carries. */
  label?: string | null;
  /** STATUS at the last run, to skip folders that didn't change. */
  messages?: number | null;
  unseen?: number | null;
  checkedAt?: number;
}

type SyncState = Record<string, FolderState>;

const stateKey = (accountId: string) => `imapSync:${accountId}`;

function readState(accountId: string): SyncState {
  try {
    return JSON.parse(store.getKv(stateKey(accountId)) ?? "{}") as SyncState;
  } catch {
    return {};
  }
}

const writeState = (accountId: string, state: SyncState) =>
  store.setKv(stateKey(accountId), JSON.stringify(state));

export async function syncImap(accountId: string, ctx: SyncContext): Promise<void> {
  ctx.update({ phase: "labels" });
  const { folders, statuses } = await readFolders(accountId);
  ctx.assertActive();
  if (writeLabels(accountId, labelsOf(folders, statuses))) ctx.bumpRevision();

  const state = readState(accountId);
  // Folders gone from the server (deleted, or renamed elsewhere): their mail goes too.
  for (const [path, folderState] of Object.entries(state)) {
    if (folders.get(path)) continue;
    dropFolder(accountId, path, folderState.uidValidity);
    delete state[path];
    ctx.bumpRevision();
  }
  writeState(accountId, state);

  const first = !store.getSyncState(accountId).fullSyncDone;
  const total = [...statuses.values()].reduce((sum, s) => sum + (s.messages ?? 0), 0);
  ctx.update(
    first
      ? { phase: "full", synced: store.countAllMessages(accountId), total }
      : { phase: "incremental", synced: 0 },
  );

  const newMail: MessageSummary[] = [];
  for (const folder of folders.synced) {
    if (relabelFolder(accountId, folder, state[folder.path])) ctx.bumpRevision();
    const run = new FolderSync(accountId, folder, ctx, state[folder.path]);
    let added: MessageSummary[];
    try {
      added = await run.sync(statuses.get(folder.path));
    } catch (err) {
      // Deleted since the listing: the next run drops it.
      if (!(err instanceof FolderGone)) throw err;
      continue;
    }
    state[folder.path] = run.state!;
    writeState(accountId, state);
    if (folder.role === "INBOX") for (const message of added) newMail.push(message);
  }

  ctx.assertActive();
  store.recountLabels(accountId, ["STARRED", "UNREAD"]);
  if (first) store.setSyncState(accountId, { fullSyncDone: true });
  await ctx.newMail(newMail);
}

// ── Labels ─────────────────────────────────────────────────────────────────

function labelsOf(folders: Folders, statuses: Map<string, MailboxStatus>): MailLabel[] {
  const labels: MailLabel[] = [];
  for (const folder of folders.synced) {
    if (!folder.labelId) continue;
    const status = statuses.get(folder.path);
    labels.push({
      id: folder.labelId,
      name: folder.role ? folder.labelId : folder.name,
      type: folder.role ? "system" : "user",
      unread: status?.unseen ?? undefined,
      total: status?.messages ?? undefined,
    });
  }
  // Counted from the cache (below): there's no folder for them.
  labels.push({ id: "STARRED", name: "STARRED", type: "system" });
  labels.push({ id: "UNREAD", name: "UNREAD", type: "system" });
  return labels;
}

/** Stores the labels; answers whether names or counts changed. */
function writeLabels(accountId: string, labels: MailLabel[]): boolean {
  const before = store.getLabels(accountId);
  store.upsertLabels(accountId, labels);
  store.recountLabels(accountId, ["STARRED", "UNREAD"]);
  const key = (list: MailLabel[]) =>
    JSON.stringify(
      list
        .map((l) => [l.id, l.name, l.unread, l.total])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  return key(before) !== key(store.getLabels(accountId));
}

/** The folders, and each one's STATUS (its counts, and whether it changed). */
function readFolders(accountId: string) {
  return withImap(accountId, async (client) => {
    // Some servers (Dovecot) answer STATUS for the open folder as this
    // session last saw it: NOOP catches the session up first.
    if (client.mailbox) await client.noop();
    const folders = await listFolders(accountId, client);
    const statuses = new Map<string, MailboxStatus>();
    for (const folder of folders.synced) {
      const status = await client.status(folder.path).catch(() => null);
      if (status) statuses.set(folder.path, status);
    }
    return { folders, statuses };
  });
}

/** listLabels: the folders and their counts, straight from the server. */
export async function readLabels(accountId: string): Promise<MailLabel[]> {
  const { folders, statuses } = await readFolders(accountId);
  return labelsOf(folders, statuses);
}

// ── One folder ─────────────────────────────────────────────────────────────

/** Marked for deletion and waiting for an expunge: as good as gone. */
const isDeleted = (message: FetchedMessage) =>
  message.flags?.some((flag) => flag.toLowerCase() === "\\deleted") ?? false;

/** A folder's cached message ids, by UID. */
function cachedUids(accountId: string, uidValidity: number, path: string): Map<number, string> {
  const uids = new Map<number, string>();
  for (const id of store.getMessageIdsWithPrefix(accountId, `${uidValidity}:`)) {
    const ref = parseMessageId(id);
    if (ref.path === path) uids.set(ref.uid, id);
  }
  return uids;
}

function dropFolder(accountId: string, path: string, uidValidity: number): void {
  const ids = [...cachedUids(accountId, uidValidity, path).values()];
  store.applyHistoryChanges(
    accountId,
    ids.map((id) => ({ kind: "deleted", id })),
  );
  if (ids.length > 0) logger.info("imap-sync", `dropped ${ids.length} cached messages of ${path}`);
}

/**
 * A folder whose label changed (the Archive, which had none before ARCHIVE)
 * moves its cached mail to the new label; answers whether it did.
 */
function relabelFolder(accountId: string, folder: Folder, state: FolderState | undefined): boolean {
  if (!state) return false;
  // Synced before folders kept their label: only the Archive's has changed since.
  const had =
    state.label !== undefined ? state.label : folder.role === "ARCHIVE" ? null : folder.labelId;
  state.label = folder.labelId;
  if (had === folder.labelId) return false;
  const ids = [...cachedUids(accountId, state.uidValidity, folder.path).values()];
  store.applyHistoryChanges(
    accountId,
    ids.flatMap((id) => [
      ...(had ? [{ kind: "labelsRemoved" as const, id, labelIds: [had] }] : []),
      ...(folder.labelId ? [{ kind: "labelsAdded" as const, id, labelIds: [folder.labelId] }] : []),
    ]),
  );
  return true;
}

/**
 * A folder renamed here: its cached mail and sync state follow when the
 * server kept its UIDVALIDITY; otherwise the next sync fetches it anew.
 */
export function renameFolderState(
  accountId: string,
  from: string,
  to: string,
  uidValidity: number,
): void {
  const state = readState(accountId);
  const folderState = state[from];
  if (!folderState) return;
  delete state[from];
  if (folderState.uidValidity === uidValidity) {
    for (const [uid, id] of cachedUids(accountId, uidValidity, from)) {
      const labels = store.getMessageLabelIds(accountId, id) ?? [];
      store.renameMessage(
        accountId,
        id,
        messageId(uidValidity, uid, to),
        labels.map((l) => (l === from ? to : l)),
      );
    }
    if (folderState.label === from) folderState.label = to;
    state[to] = folderState;
  } else {
    dropFolder(accountId, from, folderState.uidValidity);
  }
  writeState(accountId, state);
}

class FolderSync {
  constructor(
    private readonly accountId: string,
    private readonly folder: Folder,
    private readonly ctx: SyncContext,
    public state: FolderState | undefined,
  ) {}

  /** Brings the folder up to date; answers the new mail (none on its first sync). */
  async sync(status: MailboxStatus | undefined): Promise<MessageSummary[]> {
    const prev = this.state;
    if (prev && prev.below === 0 && status && this.unchanged(prev, status)) return [];

    const { path } = this.folder;
    const complete = prev?.below === 0;
    const qresync =
      complete && prev.modseq
        ? { uidValidity: prev.uidValidity, modseq: BigInt(prev.modseq) }
        : undefined;
    const opened = await withImap(this.accountId, async (client) => {
      const mailbox = await client.select(path, { qresync }).catch((err: unknown) => {
        throw err instanceof ImapError && err.status === "NO" ? new FolderGone(path) : err;
      });
      return {
        mailbox,
        qresynced:
          !!qresync && client.enabled.has("QRESYNC") && mailbox.uidValidity === qresync.uidValidity,
      };
    });
    const { mailbox } = opened;
    const seen = { messages: status?.messages, unseen: status?.unseen, checkedAt: Date.now() };

    if (prev && prev.uidValidity !== mailbox.uidValidity) {
      logger.info("imap-sync", `${path} has a new UIDVALIDITY; syncing it again`);
      this.ctx.assertActive();
      dropFolder(this.accountId, path, prev.uidValidity);
      this.ctx.bumpRevision();
      this.state = undefined;
    }

    if (!this.state || this.state.below > 0) {
      this.state ??= {
        uidValidity: mailbox.uidValidity,
        uidNext: mailbox.uidNext ?? 1,
        modseq: mailbox.highestModseq?.toString(),
        below: mailbox.uidNext ?? Number.MAX_SAFE_INTEGER,
        label: this.folder.labelId,
      };
      await this.firstSync();
      Object.assign(this.state, seen);
      return [];
    }

    const added = await this.catchUp(this.state, mailbox, opened.qresynced);
    Object.assign(this.state, seen);
    return added;
  }

  private unchanged(prev: FolderState, status: MailboxStatus): boolean {
    if (status.uidValidity !== prev.uidValidity || status.uidNext !== prev.uidNext) return false;
    if (status.messages !== prev.messages) return false;
    if (status.highestModseq !== null) return prev.modseq === String(status.highestModseq);
    return status.unseen === prev.unseen && Date.now() - (prev.checkedAt ?? 0) < FLAG_CHECK_MS;
  }

  /** Runs `fn` with the folder selected, as long as it's still the same folder. */
  private run<T>(fn: (client: ImapClient, mailbox: SelectedMailbox) => Promise<T>): Promise<T> {
    return inFolder(this.accountId, this.folder.path, fn, { uidValidity: this.state!.uidValidity });
  }

  /** Summaries of `uids`, fetched and stored a page at a time; answers them. */
  private async fetchAndStore(uids: number[]): Promise<MessageSummary[]> {
    const stored: MessageSummary[] = [];
    for (let end = uids.length; end > 0; end -= PAGE) {
      for (const summary of await this.fetchPage(uids.slice(Math.max(0, end - PAGE), end))) {
        stored.push(summary);
      }
    }
    return stored;
  }

  private async fetchPage(uids: number[]): Promise<MessageSummary[]> {
    const fetched = await this.run((client) => client.fetch(uids, SUMMARY_QUERY));
    const summaries: MessageSummary[] = [];
    for (const message of fetched) {
      if (isDeleted(message)) continue;
      summaries.push(await toSummary(this.folder, this.state!.uidValidity, message));
    }
    this.ctx.assertActive();
    store.upsertMessages(this.accountId, summaries);
    this.ctx.bumpRevision();
    return summaries;
  }

  /** Every UID below `state.below`, newest first; the cursor is saved after each page. */
  private async firstSync(): Promise<void> {
    const state = this.state!;
    const top = state.below === Number.MAX_SAFE_INTEGER ? "*" : String(state.below - 1);
    const uids =
      state.below > 1
        ? (
            await this.run((client) =>
              client.search({ uids: `1:${top}`, deleted: false, gmailRaw: this.folder.gmailRaw }),
            )
          ).filter((uid) => uid < state.below)
        : [];
    const synced = { count: store.countAllMessages(this.accountId) };
    for (let end = uids.length; end > 0; end -= PAGE) {
      const page = uids.slice(Math.max(0, end - PAGE), end);
      synced.count += (await this.fetchPage(page)).length;
      this.ctx.update({ synced: synced.count });
      state.below = page[0]!;
      this.saveCursor();
    }
    state.below = 0;
  }

  private saveCursor(): void {
    const all = readState(this.accountId);
    all[this.folder.path] = this.state!;
    writeState(this.accountId, all);
  }

  /** A synced folder's changes since `state`: flags, new mail, expunged mail. */
  private async catchUp(
    state: FolderState,
    mailbox: {
      uidNext: number | null;
      highestModseq: bigint | null;
      vanished: UidRange[];
      changed: FetchedMessage[];
    },
    qresynced: boolean,
  ): Promise<MessageSummary[]> {
    const { accountId, folder } = this;
    const since = state.modseq !== undefined ? BigInt(state.modseq) : null;

    // Flags.
    let flags: FetchedMessage[] = [];
    let listing: number[] | null = null;
    if (qresynced) {
      flags = mailbox.changed;
    } else if (since !== null && mailbox.highestModseq !== null) {
      if (mailbox.highestModseq !== since) {
        flags = await this.run((client) =>
          client.fetch("1:*", { flags: true }, { changedSince: since }),
        );
      }
    } else if (!hasPendingLabelWrites(accountId)) {
      // No mod-sequences: every UID's flags (which also lists what's left).
      flags = await this.run((client) => client.fetch("1:*", { flags: true }));
      // (Gmail's All Mail lists more than is synced: its search says what's there.)
      if (!folder.gmailRaw) listing = flags.filter((m) => !isDeleted(m)).map((m) => m.uid);
    }
    const ops: store.HistoryOp[] = [];
    const known = cachedUids(accountId, state.uidValidity, folder.path);
    for (const message of flags) {
      const id = known.get(message.uid);
      if (!id || message.uid >= state.uidNext) continue;
      if (isDeleted(message)) {
        ops.push({ kind: "deleted", id });
        known.delete(message.uid);
        continue;
      }
      const want = labelsFor(folder, message.flags ?? []).filter((l) => FLAG_LABELS.includes(l));
      const have = store.getMessageLabelIds(accountId, id) ?? [];
      const add = want.filter((l) => !have.includes(l));
      const remove = FLAG_LABELS.filter((l) => have.includes(l) && !want.includes(l));
      if (add.length) ops.push({ kind: "labelsAdded", id, labelIds: add });
      if (remove.length) ops.push({ kind: "labelsRemoved", id, labelIds: remove });
    }
    // Ranges may span every UID there could be: checked against the cache, never expanded.
    if (mailbox.vanished.length > 0) {
      const vanished = inUidRanges(mailbox.vanished);
      for (const [uid, id] of known) {
        if (!vanished(uid)) continue;
        ops.push({ kind: "deleted", id });
        known.delete(uid);
      }
    }

    // New mail.
    let fresh: number[] = [];
    if (mailbox.uidNext === null || mailbox.uidNext > state.uidNext) {
      fresh = (
        await this.run((client) =>
          client.search({ uids: `${state.uidNext}:*`, gmailRaw: this.folder.gmailRaw }),
        )
      ).filter((uid) => uid >= state.uidNext);
    }

    // Expunged mail, and anything an earlier run missed: when the counts disagree.
    // (Mail marked \Deleted but not expunged yet counts as gone.)
    const missing: number[] = [];
    const count = await this.run(async (_client, box) => box.exists);
    if (listing || known.size + fresh.length !== count) {
      const onServer = new Set(
        listing ??
          (await this.run((client) =>
            client.search({ deleted: false, gmailRaw: this.folder.gmailRaw }),
          )),
      );
      for (const [uid, id] of known) {
        if (!onServer.has(uid)) ops.push({ kind: "deleted", id });
      }
      const fresher = new Set(fresh);
      for (const uid of onServer) {
        if (!known.has(uid) && !fresher.has(uid)) missing.push(uid);
      }
    }

    this.ctx.assertActive();
    if (ops.length > 0) {
      store.applyHistoryChanges(accountId, ops);
      this.ctx.bumpRevision();
    }
    if (missing.length > 0) {
      logger.info(
        "imap-sync",
        `${folder.path}: fetching ${missing.length} messages the cache missed`,
      );
      await this.fetchAndStore(missing);
    }
    const added = fresh.length > 0 ? await this.fetchAndStore(fresh) : [];
    if (added.length > 0) {
      store.recountLabels(accountId, [...new Set(added.flatMap((m) => m.labelIds))]);
    }

    let uidNext = Math.max(mailbox.uidNext ?? 0, state.uidNext);
    for (const uid of fresh) uidNext = Math.max(uidNext, uid + 1);
    state.uidNext = uidNext;
    if (mailbox.highestModseq !== null) state.modseq = mailbox.highestModseq.toString();
    return added;
  }
}
