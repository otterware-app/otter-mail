/** Provider readers for alert decisions. Requests explicitly exclude headers, bodies, snippets and attachments. */
import { connect } from "cloudflare:sockets";
import { connectImap, type ImapClient } from "@otter-mail/core/imap";
import type { MailProviderKind } from "@otter-mail/contracts/mail";
import {
  accessToken,
  credential,
  sameSettings,
  NotificationFailure,
  type Connection,
} from "./notification-connections.ts";
import * as outlook from "./outlook.ts";
import type { Env } from "./worker.ts";

export type IncomingMessage = {
  messageId: string;
  inbox: boolean;
  folder?: string;
  uidValidity?: number;
};
export type MailCursor = {
  provider: MailProviderKind;
  historyId?: string;
  watchedUntil?: number;
  subscriptionId?: string;
  since?: string;
  seen?: string[];
  folders?: Record<string, { uidValidity: number; uidNext: number; checkedAt: number }>;
  folderOffset?: number;
};
export type CheckResult = { cursor: MailCursor; messages: IncomingMessage[] };
type Json = Record<string, unknown>;

async function json(url: string, token: string, options: RequestInit = {}): Promise<Json> {
  const response = await fetch(url, {
    ...options,
    redirect: "manual",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Prefer: 'IdType="ImmutableId"',
      ...options.headers,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    if (response.status === 404) throw new MissingResource();
    const body = (await response.json().catch(() => null)) as {
      error?: { errors?: { reason?: string }[]; status?: string };
    } | null;
    // Gmail uses 403 for quota limits too. Those need retry, not fresh consent.
    const quota =
      body?.error?.errors?.some((e) =>
        [
          "rateLimitExceeded",
          "userRateLimitExceeded",
          "dailyLimitExceeded",
          "quotaExceeded",
        ].includes(e.reason ?? ""),
      ) || body?.error?.status === "RESOURCE_EXHAUSTED";
    throw new NotificationFailure(response.status === 401 || (response.status === 403 && !quota));
  }
  return response.json() as Promise<Json>;
}
class MissingResource extends Error {}

export async function gmailCheck(
  env: Env,
  row: Connection,
  previous?: MailCursor,
): Promise<CheckResult> {
  const token = await accessToken(env, row);
  const root = `${env.NOTIFICATION_GOOGLE_API_ORIGIN ?? "https://gmail.googleapis.com"}/gmail/v1/users/me`;
  const get = (path: string) => json(root + path, token);
  const cursor: MailCursor =
    previous?.provider === "gmail" ? { ...previous } : { provider: "gmail" };
  if (!cursor.historyId)
    cursor.historyId = String((await get("/profile?fields=historyId")).historyId);
  if ((cursor.watchedUntil ?? 0) < Date.now() + 86_400_000) {
    const watch = await json(root + "/watch", token, {
      method: "POST",
      body: JSON.stringify({
        topicName:
          env.NOTIFICATION_GOOGLE_PUSH_TOPIC ||
          ((env.NOTIFICATION_GOOGLE_CLIENT_ID || env.GOOGLE_WEB_CLIENT_ID).startsWith(
            "187875144740-",
          )
            ? (env.PUSH_TOPIC_LEGACY ?? env.PUSH_TOPIC)
            : env.PUSH_TOPIC),
      }),
    });
    cursor.watchedUntil = Number(watch.expiration);
    // watch.historyId is an ending marker, never the start of the history walk.
  }
  if (!previous?.historyId) return { cursor, messages: [] };
  const ids = new Set<string>();
  let page: string | undefined;
  let historyId = cursor.historyId;
  for (let pages = 0; pages < 5; pages++) {
    let result: Json;
    try {
      const params = new URLSearchParams({
        startHistoryId: cursor.historyId!,
        historyTypes: "messageAdded",
        maxResults: "100",
        fields: "history/messagesAdded/message/id,historyId,nextPageToken",
        ...(page ? { pageToken: page } : {}),
      });
      result = await get("/history?" + params);
    } catch (error) {
      if (!(error instanceof MissingResource)) throw error;
      return {
        cursor: {
          ...cursor,
          historyId: String((await get("/profile?fields=historyId")).historyId),
        },
        messages: [],
      };
    }
    for (const record of (result.history ?? []) as {
      messagesAdded?: { message: { id: string } }[];
    }[]) {
      for (const added of record.messagesAdded ?? [])
        if (/^[a-f0-9]{1,32}$/i.test(added.message.id)) ids.add(added.message.id);
    }
    historyId = String(result.historyId);
    page = typeof result.nextPageToken === "string" ? result.nextPageToken : undefined;
    if (!page) break;
    if (pages === 4) throw new NotificationFailure(false);
  }
  const messages: IncomingMessage[] = [];
  // Bound a large catch-up; a single alert can represent several arrivals, and only the latest is enriched.
  const candidates = [...ids].slice(-100);
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = await Promise.all(
      candidates.slice(offset, offset + 4).map(async (id) => {
        try {
          return await get(`/messages/${id}?format=minimal&fields=id,labelIds`);
        } catch (error) {
          if (error instanceof MissingResource) return null;
          throw error;
        }
      }),
    );
    for (const message of batch) {
      if (!message) continue;
      const labels = new Set((message.labelIds as string[]) ?? []);
      if (
        labels.has("UNREAD") &&
        !["SENT", "DRAFT", "SPAM", "TRASH"].some((label) => labels.has(label))
      ) {
        messages.push({ messageId: String(message.id), inbox: labels.has("INBOX") });
      }
    }
  }
  return { cursor: { ...cursor, historyId }, messages };
}

export async function outlookCheck(
  env: Env,
  row: Connection,
  previous?: MailCursor,
): Promise<CheckResult> {
  const token = await accessToken(env, row);
  const root = `${env.MICROSOFT_GRAPH_URL ?? "https://graph.microsoft.com"}/v1.0`;
  const cursor: MailCursor =
    previous?.provider === "outlook"
      ? { ...previous }
      : { provider: "outlook", since: new Date().toISOString(), seen: [] };
  if ((cursor.watchedUntil ?? 0) < Date.now() + 86_400_000) {
    const expirationDateTime = new Date(Date.now() + 70 * 3_600_000).toISOString();
    let subscription: Json | undefined;
    if (cursor.subscriptionId) {
      try {
        subscription = await json(
          root + `/subscriptions/${encodeURIComponent(cursor.subscriptionId)}`,
          token,
          { method: "PATCH", body: JSON.stringify({ expirationDateTime }) },
        );
      } catch (error) {
        if (!(error instanceof MissingResource)) throw error;
      }
    }
    subscription ??= await json(root + "/subscriptions", token, {
      method: "POST",
      body: JSON.stringify({
        changeType: "created",
        resource: "me/messages",
        notificationUrl: outlook.notificationUrl(env, row.email),
        clientState: await outlook.clientState(env, row.email),
        expirationDateTime,
      }),
    });
    cursor.subscriptionId = String(subscription.id);
    cursor.watchedUntil = Date.parse(expirationDateTime);
  }
  if (!previous?.since) return { cursor, messages: [] };
  const folders = await Promise.all(
    ["inbox", "sentitems", "drafts", "junkemail", "deleteditems"].map((name) =>
      json(root + `/me/mailFolders/${name}?$select=id`, token),
    ),
  );
  const inboxId = String(folders[0]!.id);
  const excluded = new Set(folders.slice(1).map((f) => String(f.id)));
  const seen = new Set(cursor.seen ?? []);
  const params = new URLSearchParams({
    $filter: `receivedDateTime ge ${cursor.since}`,
    $orderby: "receivedDateTime asc",
    $select: "id,parentFolderId,isRead,isDraft,receivedDateTime",
    $top: "100",
  });
  let url: string | undefined = root + "/me/messages?" + params;
  const messages: IncomingMessage[] = [];
  let newest = cursor.since!;
  for (let pages = 0; url && pages < 5; pages++) {
    const result = await json(url, token);
    for (const message of (result.value ?? []) as {
      id: string;
      parentFolderId: string;
      isRead: boolean;
      isDraft: boolean;
      receivedDateTime: string;
    }[]) {
      if (message.receivedDateTime > newest) newest = message.receivedDateTime;
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      if (!message.isRead && !message.isDraft && !excluded.has(message.parentFolderId)) {
        messages.push({ messageId: message.id, inbox: message.parentFolderId === inboxId });
      }
    }
    url = typeof result["@odata.nextLink"] === "string" ? result["@odata.nextLink"] : undefined;
    if (
      url &&
      (new URL(url).origin !== new URL(root).origin || !new URL(url).pathname.startsWith("/v1.0/"))
    )
      throw new NotificationFailure(false);
    if (url && pages === 4) throw new NotificationFailure(false);
  }
  return { cursor: { ...cursor, since: newest, seen: [...seen].slice(-500) }, messages };
}

/** A TLS ByteStream adapter for the existing, tested IMAP client. No credential-bearing commands are logged. */
async function tcp(host: string, port: number, options: { tls: boolean }) {
  let socket = connect(
    { hostname: host, port },
    { secureTransport: options.tls ? "on" : "starttls", allowHalfOpen: false },
  );
  await socket.opened;
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  return {
    read: async () => {
      const chunk = await reader.read();
      return chunk.done ? null : chunk.value;
    },
    write: async (data: Uint8Array) => {
      await writer.write(data);
    },
    startTls: async () => {
      reader.releaseLock();
      writer.releaseLock();
      socket = socket.startTls();
      await socket.opened;
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
    },
    close: () => {
      void socket.close().catch(() => {});
    },
  };
}

function imapOptions(
  env: Env,
  settings: import("@otter-mail/contracts/mail").ImapSettings,
  password: string,
) {
  const localTest =
    `${settings.imap.host}:${settings.imap.port}` === env.NOTIFICATION_IMAP_TEST_TARGET;
  return {
    ...settings.imap,
    security: localTest ? ("none" as const) : settings.imap.security,
    auth: { user: settings.username, pass: password },
    connect: localTest ? (host: string, port: number) => tcp(host, port, { tls: false }) : tcp,
    timeoutMs: 8000,
  };
}

export async function imapCheck(
  env: Env,
  row: Connection,
  previous: MailCursor | undefined,
  all: boolean,
  listen: boolean,
): Promise<CheckResult> {
  const saved = await credential(env, row);
  if (saved.provider !== "imap") throw new NotificationFailure(true);
  // Remote edits cannot redirect a saved password to a different server.
  const linked = await env.DB.prepare(
    "SELECT imap FROM linked_accounts WHERE user_id=? AND email=? AND provider='imap'",
  )
    .bind(row.user_id, row.email)
    .first<{ imap: string }>();
  if (!linked || !sameSettings(JSON.parse(linked.imap), saved.settings))
    throw new NotificationFailure(true);
  let client: ImapClient;
  try {
    client = await connectImap(imapOptions(env, saved.settings, saved.password));
  } catch (error) {
    throw new NotificationFailure((error as { kind?: string }).kind === "auth");
  }
  const cursor: MailCursor =
    previous?.provider === "imap" ? structuredClone(previous) : { provider: "imap", folders: {} };
  const messages: IncomingMessage[] = [];
  const timer = setTimeout(() => client.close(), listen ? 35_000 : 15_000);
  try {
    const listed = await client.list();
    const excluded = listed.filter(
      (folder) =>
        ["\\Sent", "\\Drafts", "\\Junk", "\\Trash"].includes(folder.specialUse ?? "") ||
        /^(sent|sent items|sent messages|sent mail|drafts?|junk|junk e-mail|junk email|spam|trash|deleted items|deleted messages|bin|bulk mail)$/i.test(
          folder.path.split(folder.delimiter ?? "/").at(-1) ?? "",
        ),
    );
    const eligible = listed.filter(
      (folder) =>
        folder.selectable &&
        !["\\All", "\\Flagged"].includes(folder.specialUse ?? "") &&
        !excluded.some(
          (blocked) =>
            folder.path === blocked.path ||
            folder.path.startsWith(blocked.path + (blocked.delimiter ?? "/")),
        ),
    );
    if (
      listed.some((f) => f.path.toUpperCase() === "INBOX") &&
      !eligible.some((f) => f.path.toUpperCase() === "INBOX")
    )
      eligible.unshift(listed.find((f) => f.path.toUpperCase() === "INBOX")!);
    const inbox = eligible.find((folder) => folder.path.toUpperCase() === "INBOX");
    const others = all ? eligible.filter((folder) => folder !== inbox) : [];
    const offset = (cursor.folderOffset ?? 0) % Math.max(1, others.length);
    const folders = [
      ...(inbox ? [inbox] : []),
      ...[...others.slice(offset), ...others.slice(0, offset)].slice(0, 49),
    ];
    cursor.folderOffset = (offset + 49) % Math.max(1, others.length);
    const seen = new Set(cursor.seen ?? []);
    async function check(path: string) {
      const selected = await client.select(path, { readOnly: true });
      const baseline = cursor.folders?.[path];
      const next = selected.uidNext ?? (await client.status(path)).uidNext;
      if (next === null) throw new NotificationFailure(false);
      if (baseline?.uidValidity === selected.uidValidity && next > baseline.uidNext) {
        const found = await client.fetch(`${baseline.uidNext}:*`, {
          flags: true,
          internalDate: true,
          headers: ["Message-ID"],
        });
        for (const message of found.slice(-100)) {
          const reference = message.headers?.["message-id"]?.trim();
          const digest = reference
            ? new Uint8Array(
                await crypto.subtle.digest("SHA-256", new TextEncoder().encode(reference)),
              )
            : undefined;
          const fingerprint = digest
            ? Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
            : undefined;
          if (fingerprint && seen.has(fingerprint)) continue;
          if (fingerprint) seen.add(fingerprint);
          if (
            message.uid < baseline.uidNext ||
            message.flags?.some((f) => ["\\seen", "\\deleted", "\\draft"].includes(f.toLowerCase()))
          )
            continue;
          // A copy/move of old mail has a new UID but retains its old INTERNALDATE.
          if (
            !message.internalDate ||
            message.internalDate.getTime() < Math.floor(baseline.checkedAt / 1000) * 1000
          )
            continue;
          messages.push({
            messageId: String(message.uid),
            inbox: path.toUpperCase() === "INBOX",
            folder: path,
            uidValidity: selected.uidValidity,
          });
        }
      }
      cursor.folders ??= {};
      cursor.folders[path] = {
        uidValidity: selected.uidValidity,
        uidNext: next,
        checkedAt: Date.now(),
      };
    }
    for (const folder of folders) await check(folder.path);
    if (
      listen &&
      client.capabilities.has("IDLE") &&
      folders.some((f) => f.path.toUpperCase() === "INBOX")
    ) {
      await client.select("INBOX", { readOnly: true });
      let arrived!: () => void;
      const changed = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const idle = await client.idle((update) => {
        if (update.type === "exists") arrived();
      });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          changed,
          idle.done,
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, 20_000);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        await idle.stop();
      }
      await check("INBOX");
    }
    cursor.seen = [...seen].slice(-500);
    return { cursor, messages };
  } catch (error) {
    if (error instanceof NotificationFailure) throw error;
    throw new NotificationFailure((error as { kind?: string }).kind === "auth");
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

/** Recheck immediately before APNs: mail read/deleted/moved during burst coalescing must not alert. */
export async function stillEligible(
  env: Env,
  row: Connection,
  message: IncomingMessage,
  mode: "inbox" | "all",
): Promise<boolean> {
  if (row.provider === "gmail") {
    const token = await accessToken(env, row);
    try {
      const root = env.NOTIFICATION_GOOGLE_API_ORIGIN ?? "https://gmail.googleapis.com";
      const current = await json(
        `${root}/gmail/v1/users/me/messages/${encodeURIComponent(message.messageId)}?format=minimal&fields=id,labelIds`,
        token,
      );
      const labels = new Set((current.labelIds as string[]) ?? []);
      return (
        labels.has("UNREAD") &&
        !["SENT", "DRAFT", "SPAM", "TRASH"].some((label) => labels.has(label)) &&
        (mode === "all" || labels.has("INBOX"))
      );
    } catch (error) {
      if (error instanceof MissingResource) return false;
      throw error;
    }
  }
  if (row.provider === "outlook") {
    const token = await accessToken(env, row);
    const root = `${env.MICROSOFT_GRAPH_URL ?? "https://graph.microsoft.com"}/v1.0`;
    try {
      const current = await json(
        `${root}/me/messages/${encodeURIComponent(message.messageId)}?$select=id,isRead,isDraft,parentFolderId`,
        token,
      );
      if (current.isRead !== false || current.isDraft !== false) return false;
      const names =
        mode === "inbox" ? ["inbox"] : ["sentitems", "drafts", "junkemail", "deleteditems"];
      const folders = await Promise.all(
        names.map((name) => json(`${root}/me/mailFolders/${name}?$select=id`, token)),
      );
      const member = folders.some((folder) => folder.id === current.parentFolderId);
      return mode === "inbox" ? member : !member;
    } catch (error) {
      if (error instanceof MissingResource) return false;
      throw error;
    }
  }
  const saved = await credential(env, row);
  if (
    saved.provider !== "imap" ||
    !message.folder ||
    !message.uidValidity ||
    !/^\d+$/.test(message.messageId)
  )
    return false;
  if (mode === "inbox" && message.folder.toUpperCase() !== "INBOX") return false;
  let client: ImapClient | undefined;
  try {
    const linked = await env.DB.prepare(
      "SELECT imap FROM linked_accounts WHERE user_id=? AND email=? AND provider='imap'",
    )
      .bind(row.user_id, row.email)
      .first<{ imap: string }>();
    if (!linked || !sameSettings(JSON.parse(linked.imap), saved.settings)) return false;
    client = await connectImap(imapOptions(env, saved.settings, saved.password));
    if (
      (await client.select(message.folder, { readOnly: true })).uidValidity !== message.uidValidity
    )
      return false;
    const current = (await client.fetch(message.messageId, { flags: true })).find(
      (m) => String(m.uid) === message.messageId,
    );
    return Boolean(
      current &&
      !current.flags?.some((flag) =>
        ["\\seen", "\\deleted", "\\draft"].includes(flag.toLowerCase()),
      ),
    );
  } catch (error) {
    throw new NotificationFailure((error as { kind?: string }).kind === "auth");
  } finally {
    client?.close();
  }
}
