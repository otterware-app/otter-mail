/**
 * An IMAP client (RFC 9051, RFC 3501 and the extensions mail apps lean on:
 * CONDSTORE/QRESYNC, SPECIAL-USE, MOVE, UIDPLUS, IDLE, LITERAL+, ENABLE,
 * UTF8=ACCEPT) over the platform's ByteStream. Commands run one at a time;
 * reading happens only while one is waiting, so nothing reads behind a
 * STARTTLS upgrade, and an IDLE connection holds the queue until it stops.
 */

import { utf8Encode } from "../../bytes.js";
import type { ByteStream } from "../../platform.js";
import {
  DEFAULT_TIMEOUT_MS,
  errorText,
  MailProtocolError,
  openStream,
  readChunk,
  saslPlain,
  saslXoauth2,
  writeBytes,
  type MailErrorKind,
  type ServerOptions,
} from "../common.js";
import {
  ResponseReader,
  tokenList,
  tokenNumber,
  tokenText,
  type ImapResponse,
  type ImapToken,
} from "./parser.js";
import {
  formatInternalDate,
  parseFetch,
  parseUidRanges,
  parseUidSet,
  toBigInt,
  uidSet,
  type FetchedMessage,
  type UidRange,
} from "./structures.js";
import { decodeMailboxName, encodeMailboxName } from "./utf7.js";

export interface ImapOptions extends ServerOptions {
  /** Sent with ID when the server has it (some servers, like NetEase's, insist on one). */
  clientId?: Record<string, string>;
}

/** A command the server refused, or a connection that failed; `kind` says which. */
export class ImapError extends MailProtocolError {
  /** NO, BAD or BYE, when the server answered. */
  readonly status?: string;
  /** The response code: AUTHENTICATIONFAILED, TRYCREATE, OVERQUOTA, … */
  readonly code?: string;
  /** What the server said, as it said it. */
  readonly serverText?: string;

  constructor(
    message: string,
    kind: MailErrorKind,
    details: { status?: string; code?: string; serverText?: string; cause?: unknown } = {},
  ) {
    super(message, kind, { cause: details.cause });
    this.name = "ImapError";
    this.status = details.status;
    this.code = details.code;
    this.serverText = details.serverText;
  }
}

const SPECIAL_USES = [
  "\\All",
  "\\Archive",
  "\\Drafts",
  "\\Flagged",
  "\\Junk",
  "\\Sent",
  "\\Trash",
] as const;

/** RFC 6154's folder roles. */
export type SpecialUse = (typeof SPECIAL_USES)[number];

export interface ImapFolder {
  /** The full name, decoded: "Work/Receipts". INBOX is always "INBOX". */
  path: string;
  /** The last segment: "Receipts". */
  name: string;
  /** The hierarchy separator ("/", "."); null in a flat namespace. */
  delimiter: string | null;
  flags: string[];
  specialUse: SpecialUse | null;
  /** False for \Noselect and \NonExistent folders (placeholders in the hierarchy). */
  selectable: boolean;
}

export interface MailboxStatus {
  messages: number | null;
  uidNext: number | null;
  uidValidity: number | null;
  unseen: number | null;
  highestModseq: bigint | null;
}

export interface SelectedMailbox {
  path: string;
  readOnly: boolean;
  exists: number;
  uidValidity: number;
  uidNext: number | null;
  /** Null when the server keeps no mod-sequences (no CONDSTORE, or NOMODSEQ). */
  highestModseq: bigint | null;
  flags: string[];
  permanentFlags: string[];
  /** With `qresync`: UIDs expunged since the given modseq (ranges: they may be huge) … */
  vanished: UidRange[];
  /** … and the messages whose flags changed since it (UID, FLAGS, MODSEQ). */
  changed: FetchedMessage[];
}

export interface FetchQuery {
  flags?: boolean;
  envelope?: boolean;
  bodyStructure?: boolean;
  internalDate?: boolean;
  size?: boolean;
  modseq?: boolean;
  /** Header fields by name (BODY.PEEK[HEADER.FIELDS (…)]), or `true` for the whole header. */
  headers?: string[] | true;
  /** The whole message (BODY.PEEK[]). */
  source?: boolean;
  /** The first n bytes of the body (BODY.PEEK[TEXT]<0.n>). */
  textStart?: number;
  /** Gmail's own ids and labels (X-GM-MSGID, X-GM-THRID, X-GM-LABELS). */
  gmail?: boolean;
}

export interface SearchCriteria {
  uids?: readonly number[] | string;
  since?: Date;
  before?: Date;
  seen?: boolean;
  flagged?: boolean;
  deleted?: boolean;
  header?: { name: string; value: string };
  messageId?: string;
  text?: string;
  /** Messages changed since this mod-sequence (CONDSTORE). */
  modseq?: bigint;
}

/** Where copied or moved messages landed (UIDPLUS): source UID → UID in the destination. */
export interface CopyResult {
  uidValidity: number;
  uids: Map<number, number>;
}

export type ImapUpdate =
  | { type: "exists"; count: number }
  | { type: "expunge"; seq: number }
  | { type: "vanished"; ranges: UidRange[] }
  | { type: "fetch"; message: FetchedMessage };

export interface IdleSession {
  /** Ends IDLE (DONE) and waits for the server to confirm. */
  stop(): Promise<void>;
  /** Settles when IDLE ends: resolves once stopped, rejects when the connection fails. */
  done: Promise<void>;
}

/** A piece of a command: text as is, bytes as a literal. */
type Part = string | Uint8Array;

type CommandOptions = {
  /** Answers a "+" continuation (AUTHENTICATE). */
  onContinue?: (text: string) => string;
  /** What a NO means: bad credentials for LOGIN and AUTHENTICATE. */
  failure?: MailErrorKind;
};

type CommandResult = { tagged: ImapResponse; untagged: ImapResponse[] };

/** Connects, upgrades with STARTTLS if asked to, and logs in. */
export async function connectImap(options: ImapOptions): Promise<ImapClient> {
  let stream: ByteStream;
  try {
    stream = await openStream(options);
  } catch (err) {
    throw asImapError(err);
  }
  const client = new ImapClient(stream, options);
  try {
    await client.start();
  } catch (err) {
    client.close();
    throw err;
  }
  return client;
}

export class ImapClient {
  /** Upper-cased: "IMAP4REV1", "IDLE", "AUTH=PLAIN", … */
  readonly capabilities = new Set<string>();
  /** What ENABLE turned on. */
  readonly enabled = new Set<string>();
  mailbox: SelectedMailbox | null = null;

  private readonly reader = new ResponseReader();
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private tags = 0;
  private closed = false;
  private bye: string | null = null;
  private capabilityUpdates = 0;
  private listener: ((update: ImapUpdate) => void) | null = null;

  constructor(
    private readonly stream: ByteStream,
    private readonly options: ImapOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  has(capability: string): boolean {
    return this.capabilities.has(capability.toUpperCase());
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Called by connectImap: greeting, STARTTLS, login, capabilities. */
  async start(): Promise<void> {
    const greeting = await this.readResponse(this.timeoutMs);
    if (greeting.type === "BYE") {
      throw new ImapError(
        `${this.options.host} refused the connection: ${greeting.text}`,
        "server",
        {
          status: "BYE",
          serverText: greeting.text,
        },
      );
    }
    this.applyCode(greeting);

    if (this.options.security === "starttls") {
      if (this.capabilities.size === 0) await this.capability();
      if (!this.has("STARTTLS")) {
        throw new ImapError(`${this.options.host} doesn't offer STARTTLS.`, "protocol");
      }
      await this.command(["STARTTLS"]);
      // Anything already read came before the upgrade and can't be trusted.
      if (this.reader.pending > 0) {
        throw new ImapError(`${this.options.host} sent data before TLS.`, "protocol");
      }
      try {
        await this.stream.startTls();
      } catch (err) {
        throw new ImapError(`TLS with ${this.options.host} failed: ${errorText(err)}`, "network", {
          cause: err,
        });
      }
      this.capabilities.clear();
    }

    if (greeting.type !== "PREAUTH") {
      if (this.capabilities.size === 0) await this.capability();
      // Logging in may unlock more; most servers list them in the tagged OK.
      const before = this.capabilityUpdates;
      await this.login();
      if (this.capabilityUpdates === before) this.capabilities.clear();
    }
    if (this.capabilities.size === 0) await this.capability();
    if (this.options.clientId && this.has("ID")) {
      await this.id(this.options.clientId).catch(() => null);
    }
  }

  private async login(): Promise<void> {
    const { auth } = this.options;
    if ("accessToken" in auth) {
      await this.authenticate("XOAUTH2", saslXoauth2(auth.user, auth.accessToken));
    } else if (this.has("AUTH=PLAIN")) {
      await this.authenticate("PLAIN", saslPlain(auth.user, auth.pass));
    } else if (this.has("LOGINDISABLED")) {
      throw new ImapError(`${this.options.host} doesn't allow logging in without TLS.`, "protocol");
    } else {
      await this.command(["LOGIN", this.astring(auth.user), this.astring(auth.pass)], {
        failure: "auth",
      });
    }
  }

  /** SASL: the first response inline with SASL-IR; any later challenge (an error) gets "". */
  private async authenticate(mechanism: string, initial: string): Promise<void> {
    const inline = this.has("SASL-IR");
    let sent = inline;
    await this.command(["AUTHENTICATE", mechanism, ...(inline ? [initial] : [])], {
      failure: "auth",
      onContinue: () => {
        if (sent) return "";
        sent = true;
        return initial;
      },
    });
  }

  async capability(): Promise<Set<string>> {
    await this.command(["CAPABILITY"]);
    return this.capabilities;
  }

  /** Turns on what the server has of `extensions` (CONDSTORE, QRESYNC, UTF8=ACCEPT). */
  async enable(extensions: string[]): Promise<Set<string>> {
    const wanted = extensions.filter((name) => this.has(name));
    if (wanted.length > 0 && this.has("ENABLE")) await this.command(["ENABLE", ...wanted]);
    return this.enabled;
  }

  /** RFC 2971: tells the server who we are; returns who it is. */
  async id(fields: Record<string, string>): Promise<Record<string, string> | null> {
    const list = Object.entries(fields).flatMap(([key, value]) => [quote(key), quote(value)]);
    const { untagged } = await this.command(["ID", `(${list.join(" ")})`]);
    const items = tokenList(untagged.find((r) => r.type === "ID")?.args[0]);
    if (items.length === 0) return null;
    const server: Record<string, string> = {};
    for (let i = 0; i + 1 < items.length; i += 2) {
      server[tokenText(items[i]) ?? ""] = tokenText(items[i + 1]) ?? "";
    }
    return server;
  }

  async noop(): Promise<void> {
    await this.command(["NOOP"]);
  }

  /** Every folder, with its special use (RFC 6154) when the server tells. */
  async list(): Promise<ImapFolder[]> {
    const extended = this.has("SPECIAL-USE") && this.has("LIST-EXTENDED");
    const { untagged } = await this.command([
      "LIST",
      '""',
      '"*"',
      ...(extended ? ["RETURN (SPECIAL-USE)"] : []),
    ]);
    return untagged
      .filter((r) => r.type === "LIST")
      .map((r) => {
        const [flagList, delimiter, name] = r.args;
        const flags = tokenList(flagList).map((flag) => tokenText(flag) ?? "");
        const path = this.decodePath(tokenText(name) ?? "");
        const separator = tokenText(delimiter);
        const lower = new Set(flags.map((flag) => flag.toLowerCase()));
        return {
          path,
          name: separator ? (path.split(separator).pop() ?? path) : path,
          delimiter: separator,
          flags,
          specialUse: SPECIAL_USES.find((use) => lower.has(use.toLowerCase())) ?? null,
          selectable: !lower.has("\\noselect") && !lower.has("\\nonexistent"),
        };
      });
  }

  async status(path: string): Promise<MailboxStatus> {
    const items = ["MESSAGES", "UIDNEXT", "UIDVALIDITY", "UNSEEN"];
    if (this.has("CONDSTORE")) items.push("HIGHESTMODSEQ");
    const { untagged } = await this.command([
      "STATUS",
      this.mailboxName(path),
      `(${items.join(" ")})`,
    ]);
    const values = tokenList(untagged.find((r) => r.type === "STATUS")?.args[1]);
    const status: MailboxStatus = {
      messages: null,
      uidNext: null,
      uidValidity: null,
      unseen: null,
      highestModseq: null,
    };
    for (let i = 0; i + 1 < values.length; i += 2) {
      const key = tokenText(values[i])?.toUpperCase();
      const value = values[i + 1];
      if (key === "MESSAGES") status.messages = tokenNumber(value);
      else if (key === "UIDNEXT") status.uidNext = tokenNumber(value);
      else if (key === "UIDVALIDITY") status.uidValidity = tokenNumber(value);
      else if (key === "UNSEEN") status.unseen = tokenNumber(value);
      else if (key === "HIGHESTMODSEQ") status.highestModseq = toBigInt(value) ?? null;
    }
    return status;
  }

  /**
   * Opens a folder (EXAMINE when `readOnly`), asking for mod-sequences when
   * the server keeps them. With `qresync` (and QRESYNC enabled), the answer
   * also says what vanished and changed since that modseq.
   */
  async select(
    path: string,
    options: { readOnly?: boolean; qresync?: { uidValidity: number; modseq: bigint } } = {},
  ): Promise<SelectedMailbox> {
    const params: string[] = [];
    if (options.qresync && this.enabled.has("QRESYNC")) {
      params.push(`(QRESYNC (${options.qresync.uidValidity} ${options.qresync.modseq}))`);
    } else if (this.has("CONDSTORE")) {
      params.push("(CONDSTORE)");
    }
    this.mailbox = null;
    const { tagged, untagged } = await this.command([
      options.readOnly ? "EXAMINE" : "SELECT",
      this.mailboxName(path),
      ...params,
    ]);
    const mailbox: SelectedMailbox = {
      path,
      readOnly: tagged.code?.name === "READ-ONLY" || !!options.readOnly,
      exists: 0,
      uidValidity: 0,
      uidNext: null,
      highestModseq: null,
      flags: [],
      permanentFlags: [],
      vanished: [],
      changed: [],
    };
    for (const response of untagged) {
      if (response.type === "EXISTS") mailbox.exists = response.number ?? 0;
      else if (response.type === "FLAGS") mailbox.flags = texts(response.args[0]);
      else if (response.type === "VANISHED") {
        for (const range of vanishedRanges(response)) mailbox.vanished.push(range);
      } else if (response.type === "FETCH") mailbox.changed.push(parseFetch(response));
      const code = response.code;
      if (!code) continue;
      if (code.name === "UIDVALIDITY") mailbox.uidValidity = tokenNumber(code.args[0]) ?? 0;
      else if (code.name === "UIDNEXT") mailbox.uidNext = tokenNumber(code.args[0]);
      else if (code.name === "HIGHESTMODSEQ")
        mailbox.highestModseq = toBigInt(code.args[0]) ?? null;
      else if (code.name === "PERMANENTFLAGS") mailbox.permanentFlags = texts(code.args[0]);
    }
    this.mailbox = mailbox;
    return mailbox;
  }

  /** UID FETCH in the selected folder. `uids` may be a set like "1:*". */
  async fetch(
    uids: readonly number[] | string,
    query: FetchQuery,
    options: { changedSince?: bigint } = {},
  ): Promise<FetchedMessage[]> {
    return (await this.fetchChanges(uids, query, options.changedSince)).messages;
  }

  /**
   * UID FETCH … (CHANGEDSINCE modseq): what changed since, and (with QRESYNC
   * enabled) which of `uids` were expunged meanwhile.
   */
  async fetchChanges(
    uids: readonly number[] | string,
    query: FetchQuery,
    changedSince?: bigint,
  ): Promise<{ messages: FetchedMessage[]; vanished: UidRange[] }> {
    const set = uidSet(uids);
    if (!set) return { messages: [], vanished: [] };
    const items = ["UID"];
    if (query.flags) items.push("FLAGS");
    if (query.envelope) items.push("ENVELOPE");
    if (query.bodyStructure) items.push("BODYSTRUCTURE");
    if (query.internalDate) items.push("INTERNALDATE");
    if (query.size) items.push("RFC822.SIZE");
    if (query.modseq && this.has("CONDSTORE")) items.push("MODSEQ");
    if (query.headers === true) items.push("BODY.PEEK[HEADER]");
    else if (query.headers?.length) {
      items.push(
        `BODY.PEEK[HEADER.FIELDS (${query.headers.map((name) => name.toUpperCase()).join(" ")})]`,
      );
    }
    if (query.source) items.push("BODY.PEEK[]");
    if (query.textStart) items.push(`BODY.PEEK[TEXT]<0.${query.textStart}>`);
    if (query.gmail) items.push("X-GM-MSGID", "X-GM-THRID", "X-GM-LABELS");
    const modifiers: string[] = [];
    if (changedSince !== undefined) {
      const vanished = this.enabled.has("QRESYNC") ? " VANISHED" : "";
      modifiers.push(`(CHANGEDSINCE ${changedSince}${vanished})`);
    }
    const { untagged } = await this.command([
      "UID FETCH",
      set,
      `(${items.join(" ")})`,
      ...modifiers,
    ]);

    // A server may split one message's items over several FETCH responses.
    const byUid = new Map<number, FetchedMessage>();
    const vanished: UidRange[] = [];
    for (const response of untagged) {
      if (response.type === "VANISHED") {
        for (const range of vanishedRanges(response)) vanished.push(range);
      }
      if (response.type !== "FETCH") continue;
      const message = parseFetch(response);
      if (!message.uid) continue;
      const known = byUid.get(message.uid);
      byUid.set(message.uid, known ? { ...known, ...definedOnly(message) } : message);
    }
    return { messages: [...byUid.values()], vanished };
  }

  /** UID SEARCH; the matching UIDs, ascending. */
  async search(criteria: SearchCriteria | string): Promise<number[]> {
    const parts = typeof criteria === "string" ? [criteria] : this.searchKeys(criteria);
    const needsCharset =
      !this.enabled.has("UTF8=ACCEPT") && parts.some((part) => part instanceof Uint8Array);
    const { untagged } = await this.command([
      "UID SEARCH",
      ...(needsCharset ? ["CHARSET UTF-8"] : []),
      ...parts,
    ]);
    const uids = untagged
      .filter((r) => r.type === "SEARCH")
      .flatMap((r) => r.args.map(tokenNumber).filter((uid): uid is number => uid !== null));
    return uids.sort((a, b) => a - b);
  }

  private searchKeys(criteria: SearchCriteria): Part[] {
    const keys: Part[] = [];
    if (criteria.uids !== undefined) keys.push("UID", uidSet(criteria.uids) || "0");
    if (criteria.since) keys.push("SINCE", searchDate(criteria.since));
    if (criteria.before) keys.push("BEFORE", searchDate(criteria.before));
    if (criteria.seen !== undefined) keys.push(criteria.seen ? "SEEN" : "UNSEEN");
    if (criteria.flagged !== undefined) keys.push(criteria.flagged ? "FLAGGED" : "UNFLAGGED");
    if (criteria.deleted !== undefined) keys.push(criteria.deleted ? "DELETED" : "UNDELETED");
    if (criteria.header) {
      keys.push("HEADER", this.astring(criteria.header.name), this.astring(criteria.header.value));
    }
    if (criteria.messageId) keys.push("HEADER Message-ID", this.astring(criteria.messageId));
    if (criteria.text) keys.push("TEXT", this.astring(criteria.text));
    if (criteria.modseq !== undefined) keys.push("MODSEQ", String(criteria.modseq));
    return keys.length > 0 ? keys : ["ALL"];
  }

  /** Adds, removes or replaces flags (silently: the server doesn't echo them back). */
  async store(
    uids: readonly number[] | string,
    change: { add?: string[]; remove?: string[]; set?: string[] },
    options: { unchangedSince?: bigint } = {},
  ): Promise<void> {
    const set = uidSet(uids);
    if (!set) return;
    const unchanged =
      options.unchangedSince !== undefined ? [`(UNCHANGEDSINCE ${options.unchangedSince})`] : [];
    const run = (op: string, flags: string[]) =>
      this.command(["UID STORE", set, ...unchanged, `${op}FLAGS.SILENT`, `(${flags.join(" ")})`]);
    if (change.set) await run("", change.set);
    if (change.add?.length) await run("+", change.add);
    if (change.remove?.length) await run("-", change.remove);
  }

  async copy(uids: readonly number[] | string, destination: string): Promise<CopyResult | null> {
    const set = uidSet(uids);
    if (!set) return null;
    return copyUid(
      await this.command(["UID COPY", set, this.mailboxName(destination)]),
      sentCount(uids),
    );
  }

  /** UID MOVE, or where there's none: COPY, flag \Deleted, expunge those. */
  async move(uids: readonly number[] | string, destination: string): Promise<CopyResult | null> {
    const set = uidSet(uids);
    if (!set) return null;
    if (this.has("MOVE")) {
      return copyUid(
        await this.command(["UID MOVE", set, this.mailboxName(destination)]),
        sentCount(uids),
      );
    }
    const copied = await this.copy(uids, destination);
    await this.store(set, { add: ["\\Deleted"] });
    await this.expunge(set);
    return copied;
  }

  /**
   * Removes \Deleted messages: only `uids` with UIDPLUS; without it, every
   * \Deleted message in the folder (IMAP has no narrower way).
   */
  async expunge(uids?: readonly number[] | string): Promise<void> {
    const set = uids === undefined ? "" : uidSet(uids);
    if (uids !== undefined && !set) return;
    if (set && this.has("UIDPLUS")) await this.command(["UID EXPUNGE", set]);
    else await this.command(["EXPUNGE"]);
  }

  /** Stores a message in a folder; its new UID when the server says (UIDPLUS). */
  async append(
    path: string,
    message: Uint8Array | string,
    options: { flags?: string[]; date?: Date } = {},
  ): Promise<{ uidValidity: number; uid: number } | null> {
    const { tagged } = await this.command([
      "APPEND",
      this.mailboxName(path),
      ...(options.flags ? [`(${options.flags.join(" ")})`] : []),
      ...(options.date ? [quote(formatInternalDate(options.date))] : []),
      typeof message === "string" ? utf8Encode(message) : message,
    ]);
    if (tagged.code?.name !== "APPENDUID") return null;
    const uidValidity = tokenNumber(tagged.code.args[0]);
    const uid = tokenNumber(tagged.code.args[1]);
    return uidValidity !== null && uid !== null ? { uidValidity, uid } : null;
  }

  /** Creates a folder; `specialUse` flags its role where the server can (CREATE-SPECIAL-USE). */
  async createMailbox(path: string, options: { specialUse?: SpecialUse } = {}): Promise<void> {
    const use =
      options.specialUse && this.has("CREATE-SPECIAL-USE") ? [`(USE (${options.specialUse}))`] : [];
    await this.command(["CREATE", this.mailboxName(path), ...use]);
  }

  async renameMailbox(from: string, to: string): Promise<void> {
    await this.command(["RENAME", this.mailboxName(from), this.mailboxName(to)]);
  }

  async deleteMailbox(path: string): Promise<void> {
    await this.command(["DELETE", this.mailboxName(path)]);
  }

  /**
   * IDLE (RFC 2177): reports new mail, expunges and flag changes in the
   * selected folder until stopped. Resolves once the server is idling. Other
   * commands wait until it stops; servers drop IDLE after about 30 minutes,
   * so re-IDLE sooner.
   */
  async idle(onUpdate: (update: ImapUpdate) => void): Promise<IdleSession> {
    if (!this.has("IDLE"))
      throw new ImapError(`${this.options.host} doesn't support IDLE.`, "protocol");
    let stopping = false;
    let started!: () => void;
    const idling = new Promise<void>((resolve) => (started = resolve));
    const done = this.enqueue(async () => {
      const tag = this.nextTag();
      await this.write(`${tag} IDLE\r\n`);
      this.listener = onUpdate;
      try {
        for (;;) {
          const response = await this.readResponse(stopping ? this.timeoutMs : null);
          if (response.tag === "+") started();
          else if (response.tag === "*") this.untagged(response);
          else if (response.tag === tag) {
            if (response.type !== "OK") throw failure("IDLE", response, "server");
            return;
          }
        }
      } finally {
        this.listener = null;
      }
    });
    await Promise.race([idling, done]);
    return {
      done,
      stop: async () => {
        if (!stopping && !this.closed) {
          stopping = true;
          // The read already waiting has no timeout; give up on the server after this one.
          const timer = setTimeout(() => this.close(), this.timeoutMs);
          void done.finally(() => clearTimeout(timer)).catch(() => {});
          await this.write("DONE\r\n").catch(() => {});
        }
        await done.catch(() => {});
      },
    };
  }

  /** Says goodbye and closes; never throws. */
  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      await this.command(["LOGOUT"]);
    } catch {
      // Closing anyway.
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.close();
  }

  /** Any command, for what the methods above don't cover. Bytes are sent as literals. */
  command(parts: Part[], options: CommandOptions = {}): Promise<CommandResult> {
    return this.enqueue(() => this.execute(parts, options));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private nextTag(): string {
    return `A${++this.tags}`;
  }

  private async execute(parts: Part[], options: CommandOptions): Promise<CommandResult> {
    if (this.closed)
      throw new ImapError(`The connection to ${this.options.host} is closed.`, "network");
    const name = typeof parts[0] === "string" ? parts[0] : "Command";
    const tag = this.nextTag();
    const untagged: ImapResponse[] = [];
    let line = tag;
    for (const part of parts) {
      if (typeof part === "string") {
        line += ` ${part}`;
        continue;
      }
      // LITERAL+ sends right away; otherwise wait for the server's "+".
      const plus = this.has("LITERAL+") || (this.has("LITERAL-") && part.length <= 4096);
      await this.write(`${line} {${part.length}${plus ? "+" : ""}}\r\n`);
      line = "";
      if (!plus) {
        const response = await this.untilTagged(tag, untagged, true);
        if (response.tag !== "+") throw failure(name, response, options.failure ?? "server");
      }
      await this.write(part);
    }
    await this.write(`${line}\r\n`);

    for (;;) {
      const response = await this.untilTagged(tag, untagged, !!options.onContinue);
      if (response.tag === "+") {
        await this.write(`${options.onContinue!(response.text)}\r\n`);
        continue;
      }
      this.applyCode(response);
      if (response.type === "OK") return { tagged: response, untagged };
      throw failure(name, response, options.failure ?? "server");
    }
  }

  /** Reads until the tagged response (or a continuation, when one is expected). */
  private async untilTagged(
    tag: string,
    untagged: ImapResponse[],
    continuation: boolean,
  ): Promise<ImapResponse> {
    for (;;) {
      const response = await this.readResponse(this.timeoutMs);
      if (response.tag === "*") {
        this.untagged(response);
        untagged.push(response);
      } else if (response.tag === tag || (continuation && response.tag === "+")) {
        return response;
      } else if (response.tag === "+") {
        this.close();
        throw new ImapError(`${this.options.host} asked for more than we had to send.`, "protocol");
      }
    }
  }

  private async readResponse(timeoutMs: number | null): Promise<ImapResponse> {
    for (;;) {
      let response: ImapResponse | null;
      try {
        response = this.reader.next();
      } catch (err) {
        this.close();
        throw new ImapError(errorText(err), "protocol", { cause: err });
      }
      if (response) return response;
      let chunk: Uint8Array | null;
      try {
        chunk = await readChunk(this.stream, timeoutMs, this.options.host);
      } catch (err) {
        this.close();
        throw asImapError(err);
      }
      if (!chunk) {
        this.close();
        const reason = this.bye ? `: ${this.bye}` : ".";
        throw new ImapError(`${this.options.host} closed the connection${reason}`, "network", {
          status: this.bye ? "BYE" : undefined,
          serverText: this.bye ?? undefined,
        });
      }
      this.reader.push(chunk);
    }
  }

  private async write(data: string | Uint8Array): Promise<void> {
    try {
      await writeBytes(this.stream, data, this.options.host);
    } catch (err) {
      this.close();
      throw asImapError(err);
    }
  }

  /** Keeps what untagged responses say about the connection and the selected folder. */
  private untagged(response: ImapResponse): void {
    this.applyCode(response);
    switch (response.type) {
      case "CAPABILITY":
        this.setCapabilities(response.args);
        return;
      case "ENABLED":
        for (const name of response.args.map(tokenText)) {
          if (name) this.enabled.add(name.toUpperCase());
        }
        return;
      case "BYE":
        this.bye = response.text;
        return;
      case "EXISTS":
        if (this.mailbox) this.mailbox.exists = response.number ?? 0;
        this.listener?.({ type: "exists", count: response.number ?? 0 });
        return;
      case "EXPUNGE":
        if (this.mailbox) this.mailbox.exists = Math.max(0, this.mailbox.exists - 1);
        this.listener?.({ type: "expunge", seq: response.number ?? 0 });
        return;
      case "VANISHED":
        if (tokenList(response.args[0]).length === 0) {
          this.listener?.({ type: "vanished", ranges: vanishedRanges(response) });
        }
        return;
      case "FETCH":
        this.listener?.({ type: "fetch", message: parseFetch(response) });
        return;
    }
  }

  private applyCode(response: ImapResponse): void {
    if (response.code?.name === "CAPABILITY") this.setCapabilities(response.code.args);
  }

  private setCapabilities(tokens: ImapToken[]): void {
    this.capabilities.clear();
    for (const name of tokens.map(tokenText)) {
      if (name) this.capabilities.add(name.toUpperCase());
    }
    this.capabilityUpdates++;
  }

  /** A string argument: quoted when it can be, a literal otherwise. */
  private astring(value: string): Part {
    const utf8 = this.enabled.has("UTF8=ACCEPT");
    const quotable = utf8 ? !/[\r\n\0]/.test(value) : /^[\x20-\x7e]*$/.test(value);
    return quotable ? quote(value) : utf8Encode(value);
  }

  private mailboxName(path: string): Part {
    if (path.toUpperCase() === "INBOX") return "INBOX";
    return this.astring(this.enabled.has("UTF8=ACCEPT") ? path : encodeMailboxName(path));
  }

  private decodePath(name: string): string {
    if (name.toUpperCase() === "INBOX") return "INBOX";
    return this.enabled.has("UTF8=ACCEPT") ? name : decodeMailboxName(name);
  }
}

const quote = (value: string): string => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

const texts = (token: ImapToken | undefined): string[] =>
  tokenList(token)
    .map(tokenText)
    .filter((text): text is string => text !== null);

function failure(command: string, response: ImapResponse, kind: MailErrorKind): ImapError {
  const code = response.code?.name;
  // A login refused because the server is unwell isn't a wrong password.
  const unwell = code === "UNAVAILABLE" || code === "SERVERBUG" || code === "LIMIT";
  const text = response.text || response.type;
  return new ImapError(`${command} failed: ${text}`, kind === "auth" && unwell ? "server" : kind, {
    status: response.type,
    code,
    serverText: response.text,
  });
}

function asImapError(err: unknown): ImapError {
  if (err instanceof ImapError) return err;
  if (err instanceof MailProtocolError) return new ImapError(err.message, err.kind, { cause: err });
  return new ImapError(errorText(err), "network", { cause: err });
}

/** Where copied messages went; `limit`: how many were sent (the server can't have moved more). */
function copyUid({ tagged, untagged }: CommandResult, limit?: number): CopyResult | null {
  // MOVE sends COPYUID in an untagged OK before its expunges; COPY in the tagged OK.
  const code = [tagged, ...untagged].find((r) => r.code?.name === "COPYUID")?.code;
  if (!code) return null;
  const uidValidity = tokenNumber(code.args[0]);
  const from = parseUidSet(tokenText(code.args[1]) ?? "", limit);
  const to = parseUidSet(tokenText(code.args[2]) ?? "", limit);
  if (uidValidity === null || !from || !to || from.length !== to.length) return null;
  return { uidValidity, uids: new Map(from.map((uid, i) => [uid, to[i]!])) };
}

/** How many UIDs a command named (a set like "1:*" can't say). */
const sentCount = (uids: readonly number[] | string): number | undefined =>
  typeof uids === "string" ? undefined : new Set(uids).size;

/** `* VANISHED (EARLIER) 1:3,7` → [[1, 3], [7, 7]]. */
const vanishedRanges = (response: ImapResponse): UidRange[] =>
  parseUidRanges(tokenText(response.args.at(-1)) ?? "");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** SEARCH's date: `1-Feb-2026` (the day as the server's clock sees it). */
const searchDate = (date: Date): string =>
  `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
