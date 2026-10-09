import { useEffect, useState } from "react";
import {
  useQuery,
  useQueries,
  useMutation,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { toast } from "./toast";
import {
  gmailApi,
  type AddImapAccountParams,
  type ModifyMessageParams,
  type ModifyThreadParams,
  type SendMessageParams,
} from "./api";
import { ALL_MAIL_LABEL_ID } from "./label-names";
import { PENDING_LABEL_PREFIX } from "./label-tree";
import type {
  ContactSuggestion,
  GmailAccount,
  GmailLabel,
  GmailMessageDetail,
  GmailMessageSummary,
  MailView,
  SyncStatus,
  ViewRule,
} from "./types";
import type { GmailSearchResult, ListMessagesResult } from "./api";
import { resolveRules } from "./custom-views";
import { registerUndo, clearUndo, isPureMarkRead, isQuiet, type ActionSummary } from "./undo";
import { summarizeLabelChange } from "./action-summary";

const STALE_TIME = 30_000;

/** Gmail write mutations fail silently otherwise — a revoked/expired Google
 *  grant surfaces as an OAuth 401 with no other symptom (the row/badge just
 *  never updates), so calling that out specifically saves a confusing "why
 *  didn't this save" round trip. */
function describeGmailWriteError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // The IPC bridge wraps handler errors as "Error invoking remote method
  // 'gmail:x': <reason>" — only the reason is useful to the user.
  const message = raw.replace(/^Error invoking remote method '[^']*':\s*/, "");
  if (/unauthorized|oauth|signed out of google/i.test(message)) {
    return "Google sign-in expired for this account — sign in again in Settings → Accounts.";
  }
  // "GmailApiError: Gmail API error: 403 Forbidden — <reason>": the reason is what matters.
  const reason = message.match(/Gmail API error: \d+[^—]*—\s*(.+)$/s)?.[1];
  return `Couldn't save the change: ${reason ?? message}`;
}

/** The renderer bridge gives up after 5s. The backend mirrors label writes
 *  locally before calling Gmail and finishes slow ones in the background
 *  (broadcasting `gmail:write-failed` if that fails), so a timeout is not a
 *  failure — keep the optimistic state instead of rolling it back. */
function isIpcTimeout(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Request timeout/i.test(message);
}

function invalidateMailCaches(qc: ReturnType<typeof useQueryClient>): void {
  for (const key of [
    "gmail:message",
    "gmail:messages",
    "gmail:combinedMessages",
    "gmail:combinedCounts",
    "gmail:searchMessages",
    "gmail:thread",
    "gmail:labels",
    "gmail:projectThreads",
  ]) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

/** Surfaces label writes that failed after the backend had already answered
 *  (finished in the background past the IPC budget) and refetches so the
 *  reverted local state shows. Mount once, in the main window. */
export function useGmailWriteFailureToasts(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const offWrite = window.desktopBridge.on("gmail:write-failed", (params: unknown) => {
      const p = params as { message?: string } | undefined;
      toast.error(describeGmailWriteError(new Error(p?.message ?? "Unknown error")));
      invalidateMailCaches(qc);
    });
    // A send that outlasted the IPC budget and then failed: the backend put
    // the message back in Drafts (the composer had already closed).
    const offSend = window.desktopBridge.on("gmail:send-failed", (params: unknown) => {
      const p = params as { subject?: string; savedToDrafts?: boolean } | undefined;
      const what = p?.subject ? `“${p.subject}”` : "your message";
      toast.error(
        p?.savedToDrafts ? `Couldn't send ${what} — it's back in Drafts` : `Couldn't send ${what}`,
      );
      invalidateMailCaches(qc);
    });
    const offSchedule = window.desktopBridge.on("gmail:schedule-failed", () => {
      toast.error("Scheduled mail needs attention", {
        description: "Open Scheduled & snoozed to review or recover it.",
      });
      invalidateMailCaches(qc);
    });
    return () => {
      offWrite();
      offSend();
      offSchedule();
    };
  }, [qc]);
}

/** Refreshes mail caches when the backend changed mail on its own (a scheduled send going out). */
export function useExternalMailChanges(): void {
  const qc = useQueryClient();
  useEffect(
    () => window.desktopBridge.on("gmail:mail-changed", () => invalidateMailCaches(qc)),
    [qc],
  );
}

// ---- Query Keys ----
export const queryKeys = {
  accounts: () => ["gmail:accounts"] as const,
  labels: (accountId: string) => ["gmail:labels", accountId] as const,
  messages: (accountId: string, labelId?: string) =>
    ["gmail:messages", accountId, labelId] as const,
  search: (accountId: string, q: string, scope?: SearchScope | null) =>
    ["gmail:searchMessages", accountId, q, scope ?? null] as const,
  message: (accountId: string, messageId: string) =>
    ["gmail:message", accountId, messageId] as const,
  thread: (accountId: string, threadId: string) => ["gmail:thread", accountId, threadId] as const,
  combinedMessages: (viewId: string, rules: ViewRule[]) =>
    ["gmail:combinedMessages", viewId, rules] as const,
  combinedCounts: (viewId: string, rules: ViewRule[]) =>
    ["gmail:combinedCounts", viewId, rules] as const,
};

// ---- Accounts ----
export function useAccounts() {
  const qc = useQueryClient();

  // Account edits (name/color) can happen in the Settings window, which has its
  // own QueryClient — listen for the backend broadcast so every window refreshes.
  useEffect(() => {
    const unsubscribe = window.desktopBridge.on("gmail:accounts-changed", () => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts() });
    });
    return unsubscribe;
  }, [qc]);

  return useQuery<GmailAccount[]>({
    queryKey: queryKeys.accounts(),
    queryFn: () => {
      console.log("[hooks:useAccounts] fetching accounts");
      return gmailApi.listAccounts();
    },
    staleTime: STALE_TIME,
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      accountId: string;
      displayName?: string;
      color?: string;
      signature?: string;
    }) => {
      console.log("[hooks:useUpdateAccount] updating account", params);
      return gmailApi.updateAccount(params);
    },
    onMutate: async (params) => {
      await qc.cancelQueries({ queryKey: queryKeys.accounts() });
      const prev = qc.getQueryData<GmailAccount[]>(queryKeys.accounts());
      qc.setQueryData<GmailAccount[]>(queryKeys.accounts(), (accounts) =>
        (accounts ?? []).map((a) =>
          a.id === params.accountId
            ? {
                ...a,
                displayName: params.displayName !== undefined ? params.displayName : a.displayName,
                color: params.color !== undefined ? params.color : a.color,
                signature: params.signature !== undefined ? params.signature : a.signature,
              }
            : a,
        ),
      );
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) qc.setQueryData(queryKeys.accounts(), context.prev);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts() });
    },
  });
}

// ---- Labels ----
export function useLabels(accountId: string | null) {
  return useQuery<GmailLabel[]>({
    queryKey: queryKeys.labels(accountId ?? ""),
    queryFn: () => {
      console.log("[hooks:useLabels] fetching labels", { accountId });
      return gmailApi.listLabels(accountId!);
    },
    enabled: accountId != null,
    staleTime: STALE_TIME,
  });
}

export function useCreateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, name }: { accountId: string; name: string }) => {
      console.log("[hooks:useCreateLabel] creating label", { accountId, name });
      return gmailApi.createLabel(accountId, name);
    },
    // Optimistic: the label shows up in the sidebar instantly under a pending
    // id; reconciliation swaps in the real id.
    onMutate: async ({ accountId, name }) => {
      await qc.cancelQueries({ queryKey: queryKeys.labels(accountId) });
      const prev = qc.getQueryData<GmailLabel[]>(queryKeys.labels(accountId));
      qc.setQueryData<GmailLabel[]>(queryKeys.labels(accountId), (old) => [
        ...(old ?? []),
        { id: `${PENDING_LABEL_PREFIX}${name}`, name, type: "user" },
      ]);
      return { prev };
    },
    onError: (_err, { accountId }, context) => {
      if (context?.prev) qc.setQueryData(queryKeys.labels(accountId), context.prev);
    },
    onSettled: (_data, _err, { accountId }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
    },
  });
}

export function useUpdateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      accountId: string;
      labelId: string;
      name?: string;
      color?: { backgroundColor: string; textColor: string };
    }) => {
      console.log("[hooks:useUpdateLabel]", params);
      return gmailApi.updateLabel(params);
    },
    // Optimistic: rename/recolor in the labels cache immediately, cascading
    // renames to nested labels the way the backend does.
    onMutate: async ({ accountId, labelId, name, color }) => {
      await qc.cancelQueries({ queryKey: queryKeys.labels(accountId) });
      const prev = qc.getQueryData<GmailLabel[]>(queryKeys.labels(accountId));
      qc.setQueryData<GmailLabel[]>(queryKeys.labels(accountId), (old) => {
        if (!old) return old;
        const source = old.find((l) => l.id === labelId);
        if (!source) return old;
        const oldName = source.name;
        return old.map((l) => {
          if (l.id === labelId)
            return { ...l, ...(name ? { name } : {}), ...(color ? { color } : {}) };
          if (name && l.name.startsWith(`${oldName}/`)) {
            return { ...l, name: `${name}${l.name.slice(oldName.length)}` };
          }
          return l;
        });
      });
      return { prev };
    },
    onError: (_err, { accountId }, context) => {
      if (context?.prev) qc.setQueryData(queryKeys.labels(accountId), context.prev);
    },
    onSettled: (_data, _err, { accountId }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
    },
  });
}

export function useDeleteLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, labelId }: { accountId: string; labelId: string }) => {
      console.log("[hooks:useDeleteLabel]", { accountId, labelId });
      return gmailApi.deleteLabel(accountId, labelId);
    },
    onMutate: async ({ accountId, labelId }) => {
      await qc.cancelQueries({ queryKey: queryKeys.labels(accountId) });
      const prev = qc.getQueryData<GmailLabel[]>(queryKeys.labels(accountId));
      qc.setQueryData<GmailLabel[]>(queryKeys.labels(accountId), (old) =>
        old?.filter((l) => l.id !== labelId),
      );
      return { prev };
    },
    onError: (_err, { accountId }, context) => {
      if (context?.prev) qc.setQueryData(queryKeys.labels(accountId), context.prev);
    },
    onSettled: (_data, _err, { accountId }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedCounts"] });
    },
  });
}

/** Optimistically drop a thread's rows from every message-list cache. */
export function usePruneThreadRows() {
  const qc = useQueryClient();
  return (accountId: string, threadId: string) => {
    const inThread = (m: GmailMessageSummary) =>
      (m.threadId || m.id) === threadId && (m.accountId ?? accountId) === accountId;
    const prune = (old: InfiniteData<ListMessagesResult> | undefined) =>
      removeMessagesFromInfiniteData(old, inThread);
    for (const [key] of qc.getQueriesData({ queryKey: ["gmail:messages", accountId] })) {
      qc.setQueryData(key, prune);
    }
    for (const [key] of qc.getQueriesData({ queryKey: ["gmail:combinedMessages"] })) {
      qc.setQueryData(key, prune);
    }
  };
}

// ---- Messages (paginated) ----
export function useMessages(accountId: string | null, labelId?: string) {
  return useInfiniteQuery<
    ListMessagesResult,
    Error,
    InfiniteData<ListMessagesResult>,
    ReturnType<typeof queryKeys.messages>,
    string | undefined
  >({
    queryKey: queryKeys.messages(accountId ?? "", labelId),
    queryFn: ({ pageParam }) => {
      console.log("[hooks:useMessages] fetching messages", {
        accountId,
        labelId,
        pageToken: pageParam,
      });
      return gmailApi.listMessages({
        accountId: accountId!,
        labelIds: labelId ? [labelId] : undefined,
        pageToken: pageParam,
        maxResults: 50,
      });
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextPageToken,
    enabled: accountId != null,
    staleTime: STALE_TIME,
  });
}

/** Trailing-edge debounce, for search-as-you-type inputs. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * View restriction + structured filters for search: a label in account mode,
 * rules in Combined, plus flag/importance/attachment/date criteria that work
 * with an empty query too.
 */
export type SearchScope = {
  labelId?: string;
  rules?: ViewRule[];
  starred?: boolean;
  important?: boolean;
  hasAttachments?: boolean;
  withinDays?: number;
};

/**
 * Instant local full-text search (FTS5 over the mail cache). Message-level
 * rows; accountId null searches every account (Combined mode / palette).
 * `scope` restricts results to the current view (the list's filter search).
 */
export function useSearchMessages(
  q: string,
  accountId: string | null,
  enabled = true,
  scope?: SearchScope,
) {
  const hasFilters = Boolean(
    scope?.starred || scope?.important || scope?.hasAttachments || scope?.withinDays,
  );
  return useInfiniteQuery<
    ListMessagesResult,
    Error,
    InfiniteData<ListMessagesResult>,
    ReturnType<typeof queryKeys.search>,
    string | undefined
  >({
    queryKey: queryKeys.search(accountId ?? "", q, scope),
    queryFn: ({ pageParam }) => {
      console.log("[hooks:useSearchMessages] searching", {
        accountId,
        q,
        scope,
        pageToken: pageParam,
      });
      return gmailApi.searchMessages({
        q,
        accountId: accountId ?? undefined,
        labelId: scope?.labelId,
        rules: scope?.rules,
        starred: scope?.starred,
        important: scope?.important,
        hasAttachments: scope?.hasAttachments,
        withinDays: scope?.withinDays,
        pageToken: pageParam,
        maxResults: 50,
      });
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextPageToken,
    enabled: enabled && (q.trim().length > 0 || hasFilters),
    staleTime: STALE_TIME,
  });
}

/**
 * The search mailbox: Gmail's own search across `accountIds`, page by page.
 * Each page is conversations newest first; a conversation seen on an earlier
 * page isn't repeated.
 */
export function useGmailSearch(q: string, accountIds: string[], enabled = true) {
  return useInfiniteQuery<
    GmailSearchResult,
    Error,
    InfiniteData<GmailSearchResult>,
    readonly unknown[],
    Record<string, string | null> | undefined
  >({
    queryKey: ["gmail-search", q, [...accountIds].sort().join(",")],
    queryFn: ({ pageParam }) => {
      console.log("[hooks:useGmailSearch]", {
        q,
        accounts: accountIds.length,
        paged: Boolean(pageParam),
      });
      return gmailApi.gmailSearch({ q, accountIds, cursors: pageParam });
    },
    initialPageParam: undefined,
    getNextPageParam: (last) => last.cursors,
    enabled: enabled && q.trim().length > 0 && accountIds.length > 0,
    staleTime: 60_000,
  });
}

// ---- Combined (cross-account) views ----

/**
 * Cross-account message list for the Combined mailbox. `rules` are the view's
 * per-account filters (union across rules); `viewId` keys the cache per view.
 */
export function useCombinedMessages(rules: ViewRule[], viewId: string, enabled = true) {
  return useInfiniteQuery<
    ListMessagesResult,
    Error,
    InfiniteData<ListMessagesResult>,
    ReturnType<typeof queryKeys.combinedMessages>,
    string | undefined
  >({
    queryKey: queryKeys.combinedMessages(viewId, rules),
    queryFn: ({ pageParam }) => {
      console.log("[hooks:useCombinedMessages] fetching", {
        viewId,
        ruleCount: rules.length,
        pageToken: pageParam,
      });
      return gmailApi.listCombinedMessages({
        rules,
        pageToken: pageParam,
        maxResults: 50,
      });
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextPageToken,
    enabled: enabled && rules.length > 0,
    staleTime: STALE_TIME,
  });
}

/** Total/unread counts for a rule set, from the local store. */
export function useCombinedCounts(rules: ViewRule[], viewId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.combinedCounts(viewId, rules),
    queryFn: () => gmailApi.countCombinedMessages({ rules }),
    enabled: enabled && rules.length > 0,
    staleTime: STALE_TIME,
  });
}

/** Unread count per view id, for the Combined sidebar rows. */
export function useViewUnreadCounts(
  views: MailView[],
  accounts: GmailAccount[],
  enabled = true,
): Record<string, number> {
  const results = useQueries({
    queries: views.map((view) => {
      const rules = resolveRules(view, accounts);
      return {
        queryKey: queryKeys.combinedCounts(view.id, rules),
        queryFn: () => gmailApi.countCombinedMessages({ rules }),
        // All Mail carries no badge (Gmail parity) — skip a whole-mailbox count.
        enabled: enabled && rules.length > 0 && view.kind !== "allmail",
        staleTime: STALE_TIME,
      };
    }),
  });
  return Object.fromEntries(
    views.map((v, i) => {
      const data = results[i]?.data;
      // Drafts badge counts every draft, not unread ones (Gmail parity).
      return [v.id, (v.kind === "drafts" ? data?.total : data?.unread) ?? 0];
    }),
  );
}

/** Full label list per account, keyed by accountId, for the view-editor picker. */
export function useAllAccountLabels(
  accountIds: string[],
  enabled = true,
): { accountId: string; labels: GmailLabel[]; isLoading: boolean }[] {
  const results = useQueries({
    queries: accountIds.map((id) => ({
      queryKey: queryKeys.labels(id),
      queryFn: () => gmailApi.listLabels(id),
      enabled,
      staleTime: STALE_TIME,
    })),
  });
  return accountIds.map((id, i) => ({
    accountId: id,
    labels: (results[i]?.data as GmailLabel[] | undefined) ?? [],
    isLoading: results[i]?.isLoading ?? false,
  }));
}

/**
 * Resolves a message's label id back to its GmailLabel across accounts.
 * Fetches labels for each account and returns a lookup keyed by
 * `${accountId}:${labelId}` (label ids differ per account).
 */
export function useLabelResolver(
  accountIds: string[],
): (accountId: string | undefined, labelId: string) => GmailLabel | undefined {
  const results = useQueries({
    queries: accountIds.map((id) => ({
      queryKey: queryKeys.labels(id),
      queryFn: () => gmailApi.listLabels(id),
      staleTime: STALE_TIME,
    })),
  });

  const map = new Map<string, GmailLabel>();
  results.forEach((r, i) => {
    const acc = accountIds[i];
    for (const label of (r.data as GmailLabel[] | undefined) ?? []) {
      map.set(`${acc}:${label.id}`, label);
    }
  });

  return (accountId, labelId) => (accountId ? map.get(`${accountId}:${labelId}`) : undefined);
}

// ---- Threads ----

/** All messages of a thread from the local store, oldest first. */
export function useThread(accountId: string | null, threadId: string | null) {
  return useQuery<GmailMessageSummary[]>({
    queryKey: queryKeys.thread(accountId ?? "", threadId ?? ""),
    queryFn: () => gmailApi.getThread(accountId!, threadId!),
    enabled: accountId != null && threadId != null,
    staleTime: STALE_TIME,
  });
}

/** Several threads at once (the list's expanded conversations), each oldest first. */
export function useThreads(
  threads: { accountId: string; threadId: string }[],
): Map<string, GmailMessageSummary[]> {
  const results = useQueries({
    queries: threads.map((t) => ({
      queryKey: queryKeys.thread(t.accountId, t.threadId),
      queryFn: () => gmailApi.getThread(t.accountId, t.threadId),
      staleTime: STALE_TIME,
    })),
  });
  const byKey = new Map<string, GmailMessageSummary[]>();
  threads.forEach((t, i) => {
    const data = results[i]?.data as GmailMessageSummary[] | undefined;
    if (data) byKey.set(`${t.accountId}:${t.threadId}`, data);
  });
  return byKey;
}

// ---- Message Detail ----
export function useMessage(accountId: string | null, messageId: string | null) {
  return useQuery<GmailMessageDetail>({
    queryKey: queryKeys.message(accountId ?? "", messageId ?? ""),
    queryFn: () => {
      console.log("[hooks:useMessage] fetching message", {
        accountId,
        messageId,
      });
      return gmailApi.getMessage(accountId!, messageId!);
    },
    enabled: accountId != null && messageId != null,
    staleTime: STALE_TIME,
  });
}

// ---- Optimistic update helpers ----
//
// Mutations below patch the cache in `onMutate` so the UI reacts instantly
// (star/read/archive/trash felt laggy waiting on the Gmail round trip),
// then reconcile with the server-confirmed state in `onSuccess`/`onError`.
// The label-count delta math mirrors the backend's local-cache recompute in
// `mail-store.ts`'s `applyLabelChange`/`deleteMessage`, so sidebar/header
// unread badges move in lockstep with the message list instead of only
// updating once the next label sync happens.

type LabelCountDelta = { total: number; unread: number };

function computeLabelCountDeltas(
  priorLabelIds: string[],
  addLabelIds: string[],
  removeLabelIds: string[],
): Map<string, LabelCountDelta> {
  const priorUnread = priorLabelIds.includes("UNREAD");
  const labelSet = new Set(priorLabelIds);
  for (const lid of removeLabelIds) labelSet.delete(lid);
  for (const lid of addLabelIds) labelSet.add(lid);
  const newLabelIds = [...labelSet];
  const newUnread = newLabelIds.includes("UNREAD");

  const deltas = new Map<string, LabelCountDelta>();
  const bump = (labelId: string, total: number, unread: number) => {
    const cur = deltas.get(labelId) ?? { total: 0, unread: 0 };
    deltas.set(labelId, { total: cur.total + total, unread: cur.unread + unread });
  };

  for (const lid of addLabelIds) {
    if (!priorLabelIds.includes(lid)) bump(lid, 1, newUnread ? 1 : 0);
  }
  for (const lid of removeLabelIds) {
    if (priorLabelIds.includes(lid)) bump(lid, -1, priorUnread ? -1 : 0);
  }
  // Toggling UNREAD itself changes the unread count of every *other* label the
  // message already carries (Gmail's per-label unread counters aggregate across
  // all labels on a message), so sweep those separately from the add/remove diff.
  if (priorUnread !== newUnread) {
    const sign = newUnread ? 1 : -1;
    for (const lid of newLabelIds) {
      if (lid === "UNREAD" || addLabelIds.includes(lid) || removeLabelIds.includes(lid)) continue;
      bump(lid, 0, sign);
    }
  }
  return deltas;
}

function applyLabelCountDeltas(
  labels: GmailLabel[] | undefined,
  deltas: Map<string, LabelCountDelta>,
): GmailLabel[] | undefined {
  if (!labels || deltas.size === 0) return labels;
  return labels.map((l) => {
    const delta = deltas.get(l.id);
    if (!delta) return l;
    return {
      ...l,
      total: Math.max(0, (l.total ?? 0) + delta.total),
      unread: Math.max(0, (l.unread ?? 0) + delta.unread),
    };
  });
}

function messagesFromInfiniteData(
  data: InfiniteData<ListMessagesResult> | undefined,
): GmailMessageSummary[] {
  return data?.pages.flatMap((p) => p.messages) ?? [];
}

function patchMessagesInInfiniteData(
  data: InfiniteData<ListMessagesResult> | undefined,
  match: (m: GmailMessageSummary) => boolean,
  patch: (m: GmailMessageSummary) => GmailMessageSummary,
): InfiniteData<ListMessagesResult> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      messages: page.messages.map((m) => (match(m) ? patch(m) : m)),
    })),
  };
}

function removeMessagesFromInfiniteData(
  data: InfiniteData<ListMessagesResult> | undefined,
  match: (m: GmailMessageSummary) => boolean,
): InfiniteData<ListMessagesResult> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      messages: page.messages.filter((m) => !match(m)),
    })),
  };
}

/** Label add/remove applied to a cached summary; thread rollups follow when present. */
/**
 * Optimistically applies a label change to a row. `scope` says what changed:
 * a whole thread (its label union changes the same way) or one message (an
 * added label joins the thread's union; a removed one may still be on sibling
 * messages, so the union keeps it until the server refresh).
 */
function applyLabelPatch<T extends GmailMessageSummary>(
  m: T,
  addLabelIds: string[],
  removeLabelIds: string[],
  scope: "thread" | "message" = "message",
): T {
  const patch = (ids: string[], removals: string[]) => {
    const set = new Set(ids);
    for (const lid of removals) set.delete(lid);
    for (const lid of addLabelIds) set.add(lid);
    return [...set];
  };
  const labelIds = patch(m.labelIds, removeLabelIds);
  const unread = labelIds.includes("UNREAD");
  const starred = labelIds.includes("STARRED");
  return {
    ...m,
    labelIds,
    unread,
    starred,
    threadUnread: m.threadUnread === undefined ? undefined : unread,
    threadStarred: m.threadStarred === undefined ? undefined : starred,
    threadLabelIds:
      m.threadLabelIds === undefined
        ? undefined
        : patch(m.threadLabelIds, scope === "thread" ? removeLabelIds : []),
  };
}

// ---- Mutations ----

/**
 * Adds a mailbox with its provider's sign-in in the browser: Google's for
 * Gmail, Microsoft's for Outlook. Given an address, signs that mailbox back in.
 */
export function useAddAccount(provider: "gmail" | "outlook" = "gmail") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email?: string) => {
      console.log("[hooks:useAddAccount] adding account", { provider, email });
      return provider === "outlook"
        ? gmailApi.addOutlookAccount(email)
        : gmailApi.addAccount(email);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts() });
    },
  });
}

/** Which kinds of mailbox this app can add besides Gmail and IMAP (Outlook needs an OAuth client). */
export function useMailProviders() {
  return useQuery({
    queryKey: ["gmail:mailProviders"],
    queryFn: () => gmailApi.mailProviders(),
    staleTime: Infinity,
  });
}

export function useAddImapAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: AddImapAccountParams) => {
      console.log("[hooks:useAddImapAccount] adding account", { email: params.email });
      return gmailApi.addImapAccount(params);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts() });
    },
  });
}

export function useSignInImap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { accountId: string; password: string }) => {
      console.log("[hooks:useSignInImap] signing in", { accountId: params.accountId });
      return gmailApi.signInImap(params.accountId, params.password);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts() });
    },
  });
}

export function useRemoveAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => {
      console.log("[hooks:useRemoveAccount] removing account", { accountId });
      return gmailApi.removeAccount(accountId);
    },
    onMutate: async (accountId) => {
      await qc.cancelQueries({ queryKey: queryKeys.accounts() });
      const prev = qc.getQueryData<GmailAccount[]>(queryKeys.accounts());
      qc.setQueryData<GmailAccount[]>(queryKeys.accounts(), (accounts) =>
        (accounts ?? []).filter((a) => a.id !== accountId),
      );
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) qc.setQueryData(queryKeys.accounts(), context.prev);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts() });
    },
  });
}

/** The action toast's summary of a label change. */
function labelChangeSummary(
  qc: ReturnType<typeof useQueryClient>,
  params: { accountId: string; addLabelIds?: string[]; removeLabelIds?: string[] },
  noun: ActionSummary["noun"],
): ActionSummary | undefined {
  const labels = qc.getQueryData<GmailLabel[]>(queryKeys.labels(params.accountId)) ?? [];
  const nameOf = (id: string) => labels.find((l) => l.id === id && l.type === "user")?.name;
  return summarizeLabelChange(params.addLabelIds ?? [], params.removeLabelIds ?? [], noun, nameOf);
}

export function useModifyMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: ModifyMessageParams) => {
      console.log("[hooks:useModifyMessage] modifying message", params);
      return gmailApi.modifyMessage(params);
    },
    onMutate: async (params) => {
      const { accountId, messageId, addLabelIds = [], removeLabelIds = [] } = params;
      if (!isQuiet(params) && !isPureMarkRead(params.addLabelIds, params.removeLabelIds)) {
        registerUndo(
          {
            kind: "modifyMessage",
            params: {
              accountId,
              messageId,
              addLabelIds: removeLabelIds,
              removeLabelIds: addLabelIds,
            },
          },
          labelChangeSummary(qc, params, "message"),
        );
      }
      const messageKey = queryKeys.message(accountId, messageId);
      const labelsKey = queryKeys.labels(accountId);
      const threadsKey = ["gmail:thread", accountId];

      await Promise.all([
        qc.cancelQueries({ queryKey: messageKey }),
        qc.cancelQueries({ queryKey: ["gmail:messages", accountId] }),
        qc.cancelQueries({ queryKey: ["gmail:combinedMessages"] }),
        qc.cancelQueries({ queryKey: ["gmail:searchMessages"] }),
        qc.cancelQueries({ queryKey: threadsKey }),
        qc.cancelQueries({ queryKey: labelsKey }),
      ]);

      const prevMessage = qc.getQueryData<GmailMessageDetail>(messageKey);
      const prevMessagesQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:messages", accountId],
      });
      const prevCombinedQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:combinedMessages"],
      });
      const prevSearchQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:searchMessages"],
      });
      const prevThreadQueries = qc.getQueriesData<GmailMessageSummary[]>({
        queryKey: threadsKey,
      });
      const prevLabels = qc.getQueryData<GmailLabel[]>(labelsKey);

      const priorLabelIds =
        prevMessage?.labelIds ??
        prevMessagesQueries
          .flatMap(([, data]) => messagesFromInfiniteData(data))
          .find((m) => m.id === messageId)?.labelIds ??
        prevCombinedQueries
          .flatMap(([, data]) => messagesFromInfiniteData(data))
          .find((m) => m.id === messageId)?.labelIds ??
        [];

      const isTarget = (m: GmailMessageSummary) => m.id === messageId;
      const applyPatch = (m: GmailMessageSummary) =>
        applyLabelPatch(m, addLabelIds, removeLabelIds);

      if (prevMessage) qc.setQueryData(messageKey, applyPatch(prevMessage));
      qc.setQueriesData(
        { queryKey: ["gmail:messages", accountId] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          patchMessagesInInfiniteData(old, isTarget, applyPatch),
      );
      qc.setQueriesData(
        { queryKey: ["gmail:combinedMessages"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          patchMessagesInInfiniteData(old, isTarget, applyPatch),
      );
      qc.setQueriesData(
        { queryKey: ["gmail:searchMessages"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          patchMessagesInInfiniteData(old, isTarget, applyPatch),
      );
      // Gmail search results (the Search mailbox) show the same rows.
      qc.setQueriesData(
        { queryKey: ["gmail-search"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          patchMessagesInInfiniteData(old, isTarget, applyPatch),
      );
      qc.setQueriesData({ queryKey: threadsKey }, (old: GmailMessageSummary[] | undefined) =>
        old?.map((m) => (isTarget(m) ? applyPatch(m) : m)),
      );

      const deltas = computeLabelCountDeltas(priorLabelIds, addLabelIds, removeLabelIds);
      qc.setQueryData<GmailLabel[]>(labelsKey, (old) => applyLabelCountDeltas(old, deltas));

      return {
        messageKey,
        labelsKey,
        prevMessage,
        prevMessagesQueries,
        prevCombinedQueries,
        prevSearchQueries,
        prevThreadQueries,
        prevLabels,
      };
    },
    onError: (err, _params, context) => {
      if (isIpcTimeout(err)) {
        console.log("[hooks:useModifyMessage] IPC timed out; backend finishes in background");
        invalidateMailCaches(qc);
        return;
      }
      toast.error(describeGmailWriteError(err));
      if (!context) return;
      if (context.prevMessage) qc.setQueryData(context.messageKey, context.prevMessage);
      for (const [key, data] of context.prevMessagesQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevCombinedQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevSearchQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevThreadQueries) qc.setQueryData(key, data);
      if (context.prevLabels) qc.setQueryData(context.labelsKey, context.prevLabels);
    },
    onSuccess: (_data, params) => {
      void qc.invalidateQueries({
        queryKey: queryKeys.message(params.accountId, params.messageId),
      });
      void qc.invalidateQueries({
        queryKey: ["gmail:messages", params.accountId],
      });
      // Combined ("All Inboxes") lists are keyed by viewId, not accountId, so the
      // prefix invalidation above never reaches them — without this, read/unread
      // and star changes never show up there until the 30s staleTime lapses.
      void qc.invalidateQueries({ queryKey: ["gmail:combinedMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedCounts"] });
      void qc.invalidateQueries({ queryKey: ["gmail:searchMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:thread", params.accountId] });
      // Reconcile the optimistic label-count patch with the backend's own
      // recompute (mail-store.ts), which is the source of truth.
      void qc.invalidateQueries({ queryKey: queryKeys.labels(params.accountId) });
    },
  });
}

export function useTrashMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, messageId }: { accountId: string; messageId: string }) => {
      console.log("[hooks:useTrashMessage] trashing message", {
        accountId,
        messageId,
      });
      return gmailApi.trashMessage(accountId, messageId);
    },
    onMutate: async (params) => {
      const { accountId, messageId } = params;
      if (!isQuiet(params)) {
        registerUndo(
          { kind: "untrashMessage", params: { accountId, messageId } },
          { verb: "Moved", suffix: " to Trash", noun: "message" },
        );
      }
      const labelsKey = queryKeys.labels(accountId);
      const messageKey = queryKeys.message(accountId, messageId);
      const threadsKey = ["gmail:thread", accountId];
      await Promise.all([
        qc.cancelQueries({ queryKey: ["gmail:messages", accountId] }),
        qc.cancelQueries({ queryKey: ["gmail:combinedMessages"] }),
        qc.cancelQueries({ queryKey: ["gmail:searchMessages"] }),
        qc.cancelQueries({ queryKey: messageKey }),
        qc.cancelQueries({ queryKey: threadsKey }),
        qc.cancelQueries({ queryKey: labelsKey }),
      ]);

      const prevMessagesQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:messages", accountId],
      });
      const prevCombinedQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:combinedMessages"],
      });
      const prevSearchQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:searchMessages"],
      });
      const prevLabels = qc.getQueryData<GmailLabel[]>(labelsKey);
      const prevMessage = qc.getQueryData<GmailMessageDetail>(messageKey);
      const prevThreadQueries = qc.getQueriesData<GmailMessageSummary[]>({
        queryKey: threadsKey,
      });

      const priorMessage =
        prevMessagesQueries
          .flatMap(([, data]) => messagesFromInfiniteData(data))
          .find((m) => m.id === messageId) ??
        prevCombinedQueries
          .flatMap(([, data]) => messagesFromInfiniteData(data))
          .find((m) => m.id === messageId);

      const isTarget = (m: GmailMessageSummary) => m.id === messageId;
      // An open reader keeps rendering the conversation — mark it trashed there.
      const trashPatch = <T extends GmailMessageSummary>(m: T): T =>
        applyLabelPatch(m, ["TRASH"], ["INBOX"]) as T;
      if (prevMessage) qc.setQueryData(messageKey, trashPatch(prevMessage));
      qc.setQueriesData({ queryKey: threadsKey }, (old: GmailMessageSummary[] | undefined) =>
        old?.map((m) => (isTarget(m) ? trashPatch(m) : m)),
      );
      qc.setQueriesData(
        { queryKey: ["gmail:messages", accountId] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          removeMessagesFromInfiniteData(old, isTarget),
      );
      qc.setQueriesData(
        { queryKey: ["gmail:combinedMessages"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          removeMessagesFromInfiniteData(old, isTarget),
      );
      qc.setQueriesData(
        { queryKey: ["gmail:searchMessages"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          removeMessagesFromInfiniteData(old, isTarget),
      );
      // Gmail search keeps trashed mail in its results (as Gmail does): mark it.
      qc.setQueriesData(
        { queryKey: ["gmail-search"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          patchMessagesInInfiniteData(old, isTarget, trashPatch),
      );

      if (priorMessage) {
        const deltas = new Map<string, LabelCountDelta>(
          priorMessage.labelIds.map((lid) => [
            lid,
            { total: -1, unread: priorMessage.unread ? -1 : 0 },
          ]),
        );
        qc.setQueryData<GmailLabel[]>(labelsKey, (old) => applyLabelCountDeltas(old, deltas));
      }

      return {
        messageKey,
        labelsKey,
        prevMessage,
        prevThreadQueries,
        prevMessagesQueries,
        prevCombinedQueries,
        prevSearchQueries,
        prevLabels,
      };
    },
    onError: (err, _vars, context) => {
      if (isIpcTimeout(err)) {
        // The backend mirrored it locally and finishes in the background.
        invalidateMailCaches(qc);
        return;
      }
      toast.error(describeGmailWriteError(err));
      if (!context) return;
      if (context.prevMessage) qc.setQueryData(context.messageKey, context.prevMessage);
      for (const [key, data] of context.prevThreadQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevMessagesQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevCombinedQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevSearchQueries) qc.setQueryData(key, data);
      if (context.prevLabels) qc.setQueryData(context.labelsKey, context.prevLabels);
    },
    onSuccess: (_data, { accountId }) => {
      void qc.invalidateQueries({ queryKey: ["gmail:messages", accountId] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedCounts"] });
      void qc.invalidateQueries({ queryKey: ["gmail:searchMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:message", accountId] });
      void qc.invalidateQueries({ queryKey: ["gmail:thread", accountId] });
      void qc.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
    },
  });
}

export function useModifyThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: ModifyThreadParams) => {
      console.log("[hooks:useModifyThread] modifying thread", params);
      return gmailApi.modifyThread(params);
    },
    onMutate: async (params) => {
      const { accountId, threadId, addLabelIds = [], removeLabelIds = [] } = params;
      if (!isQuiet(params) && !isPureMarkRead(params.addLabelIds, params.removeLabelIds)) {
        registerUndo(
          {
            kind: "modifyThread",
            params: {
              accountId,
              threadId,
              addLabelIds: removeLabelIds,
              removeLabelIds: addLabelIds,
            },
          },
          labelChangeSummary(qc, params, "conversation"),
        );
      }
      const threadKey = queryKeys.thread(accountId, threadId);
      const labelsKey = queryKeys.labels(accountId);
      const messagesKey = ["gmail:message", accountId];
      const inThread = (m: GmailMessageSummary) =>
        (m.threadId || m.id) === threadId && (m.accountId ?? accountId) === accountId;

      await Promise.all([
        qc.cancelQueries({ queryKey: ["gmail:messages", accountId] }),
        qc.cancelQueries({ queryKey: ["gmail:combinedMessages"] }),
        qc.cancelQueries({ queryKey: ["gmail:searchMessages"] }),
        qc.cancelQueries({ queryKey: ["gmail-search"] }),
        qc.cancelQueries({ queryKey: messagesKey }),
        qc.cancelQueries({ queryKey: threadKey }),
        qc.cancelQueries({ queryKey: labelsKey }),
      ]);

      const prevMessagesQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:messages", accountId],
      });
      const prevCombinedQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:combinedMessages"],
      });
      const prevSearchQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:searchMessages"],
      });
      const prevGmailSearchQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail-search"],
      });
      const prevMessageQueries = qc
        .getQueriesData<GmailMessageDetail>({ queryKey: messagesKey })
        .filter(([, message]) => message && inThread(message));
      const prevThread = qc.getQueryData<GmailMessageSummary[]>(threadKey);
      const prevLabels = qc.getQueryData<GmailLabel[]>(labelsKey);

      const applyPatch = (m: GmailMessageSummary) =>
        applyLabelPatch(m, addLabelIds, removeLabelIds, "thread");

      for (const [key, message] of prevMessageQueries) {
        if (message)
          qc.setQueryData(key, applyLabelPatch(message, addLabelIds, removeLabelIds, "thread"));
      }

      qc.setQueriesData(
        { queryKey: ["gmail:messages", accountId] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          patchMessagesInInfiniteData(old, inThread, applyPatch),
      );
      qc.setQueriesData(
        { queryKey: ["gmail:combinedMessages"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          patchMessagesInInfiniteData(old, inThread, applyPatch),
      );
      qc.setQueriesData(
        { queryKey: ["gmail:searchMessages"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          patchMessagesInInfiniteData(old, inThread, applyPatch),
      );
      // Gmail search results (the Search mailbox) show the same rows.
      qc.setQueriesData(
        { queryKey: ["gmail-search"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          patchMessagesInInfiniteData(old, inThread, applyPatch),
      );
      qc.setQueryData<GmailMessageSummary[]>(threadKey, (old) => old?.map(applyPatch));

      // Thread-scoped removals also drop the row from lists the thread can no
      // longer match, so archive/move/junk clear the view instantly like trash.
      // Safe only here (whole-thread removal); single-message ops can't know
      // whether sibling messages still match.
      // All Mail (per account, or Combined rules without labels) only loses
      // threads that become spam/trash.
      const leavesAllMail = addLabelIds.includes("SPAM") || addLabelIds.includes("TRASH");
      if (removeLabelIds.length > 0 || leavesAllMail) {
        for (const [key] of prevMessagesQueries) {
          const listLabelId = key[2];
          if (
            typeof listLabelId === "string" &&
            (removeLabelIds.includes(listLabelId) ||
              (leavesAllMail && listLabelId === ALL_MAIL_LABEL_ID))
          ) {
            qc.setQueryData(key, (old: InfiniteData<ListMessagesResult> | undefined) =>
              removeMessagesFromInfiniteData(old, inThread),
            );
          }
        }
        for (const [key] of prevCombinedQueries) {
          const rules = key[2] as ViewRule[] | undefined;
          if (
            Array.isArray(rules) &&
            rules.length > 0 &&
            rules.every(
              (r) =>
                r.allOf.some((id) => removeLabelIds.includes(id)) ||
                (leavesAllMail && r.allOf.length === 0),
            )
          ) {
            qc.setQueryData(key, (old: InfiniteData<ListMessagesResult> | undefined) =>
              removeMessagesFromInfiniteData(old, inThread),
            );
          }
        }
      }

      // Per-message count deltas summed across the thread; only possible when
      // the thread's messages are cached (reader open) — invalidation reconciles.
      if (prevThread) {
        const merged = new Map<string, LabelCountDelta>();
        for (const msg of prevThread) {
          for (const [lid, d] of computeLabelCountDeltas(
            msg.labelIds,
            addLabelIds,
            removeLabelIds,
          )) {
            const cur = merged.get(lid) ?? { total: 0, unread: 0 };
            merged.set(lid, { total: cur.total + d.total, unread: cur.unread + d.unread });
          }
        }
        qc.setQueryData<GmailLabel[]>(labelsKey, (old) => applyLabelCountDeltas(old, merged));
      }

      return {
        threadKey,
        labelsKey,
        prevMessagesQueries,
        prevCombinedQueries,
        prevSearchQueries,
        prevGmailSearchQueries,
        prevMessageQueries,
        prevThread,
        prevLabels,
      };
    },
    onError: (err, _params, context) => {
      if (isIpcTimeout(err)) {
        console.log("[hooks:useModifyThread] IPC timed out; backend finishes in background");
        invalidateMailCaches(qc);
        return;
      }
      toast.error(describeGmailWriteError(err));
      if (!context) return;
      for (const [key, data] of context.prevMessagesQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevCombinedQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevSearchQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevGmailSearchQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevMessageQueries) qc.setQueryData(key, data);
      if (context.prevThread) qc.setQueryData(context.threadKey, context.prevThread);
      if (context.prevLabels) qc.setQueryData(context.labelsKey, context.prevLabels);
    },
    onSuccess: (_data, params) => {
      void qc.invalidateQueries({ queryKey: ["gmail:messages", params.accountId] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedCounts"] });
      void qc.invalidateQueries({ queryKey: ["gmail:searchMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:thread", params.accountId] });
      void qc.invalidateQueries({ queryKey: ["gmail:message", params.accountId] });
      void qc.invalidateQueries({ queryKey: queryKeys.labels(params.accountId) });
    },
  });
}

export function useTrashThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, threadId }: { accountId: string; threadId: string }) => {
      console.log("[hooks:useTrashThread] trashing thread", { accountId, threadId });
      return gmailApi.trashThread(accountId, threadId);
    },
    onMutate: async (params) => {
      const { accountId, threadId } = params;
      if (!isQuiet(params)) {
        registerUndo(
          { kind: "untrashThread", params: { accountId, threadId } },
          { verb: "Moved", suffix: " to Trash", noun: "conversation" },
        );
      }
      const threadKey = queryKeys.thread(accountId, threadId);
      const labelsKey = queryKeys.labels(accountId);

      await Promise.all([
        qc.cancelQueries({ queryKey: ["gmail:messages", accountId] }),
        qc.cancelQueries({ queryKey: ["gmail:combinedMessages"] }),
        qc.cancelQueries({ queryKey: ["gmail:searchMessages"] }),
        qc.cancelQueries({ queryKey: threadKey }),
        qc.cancelQueries({ queryKey: labelsKey }),
      ]);

      const prevMessagesQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:messages", accountId],
      });
      const prevCombinedQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:combinedMessages"],
      });
      const prevSearchQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:searchMessages"],
      });
      const prevThread = qc.getQueryData<GmailMessageSummary[]>(threadKey);
      const prevLabels = qc.getQueryData<GmailLabel[]>(labelsKey);

      const inThread = (m: GmailMessageSummary) =>
        (m.threadId || m.id) === threadId && (m.accountId ?? accountId) === accountId;
      const prevDetailQueries = qc.getQueriesData<GmailMessageDetail>({
        queryKey: ["gmail:message", accountId],
      });
      // An open reader keeps rendering the conversation — mark it trashed there.
      const threadTrashPatch = <T extends GmailMessageSummary>(m: T): T =>
        applyLabelPatch(m, ["TRASH"], ["INBOX"], "thread") as T;
      qc.setQueryData(threadKey, (old: GmailMessageSummary[] | undefined) =>
        old?.map(threadTrashPatch),
      );
      for (const [key, detail] of prevDetailQueries) {
        if (detail && (detail.threadId || detail.id) === threadId) {
          qc.setQueryData(key, threadTrashPatch(detail));
        }
      }

      qc.setQueriesData(
        { queryKey: ["gmail:messages", accountId] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          removeMessagesFromInfiniteData(old, inThread),
      );
      qc.setQueriesData(
        { queryKey: ["gmail:combinedMessages"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          removeMessagesFromInfiniteData(old, inThread),
      );
      qc.setQueriesData(
        { queryKey: ["gmail:searchMessages"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          removeMessagesFromInfiniteData(old, inThread),
      );
      // Gmail search keeps trashed mail in its results (as Gmail does): mark it.
      qc.setQueriesData(
        { queryKey: ["gmail-search"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          patchMessagesInInfiniteData(old, inThread, threadTrashPatch),
      );

      if (prevThread) {
        const merged = new Map<string, LabelCountDelta>();
        for (const msg of prevThread) {
          for (const lid of msg.labelIds) {
            const cur = merged.get(lid) ?? { total: 0, unread: 0 };
            merged.set(lid, { total: cur.total - 1, unread: cur.unread - (msg.unread ? 1 : 0) });
          }
        }
        qc.setQueryData<GmailLabel[]>(labelsKey, (old) => applyLabelCountDeltas(old, merged));
      }

      return {
        threadKey,
        labelsKey,
        prevMessagesQueries,
        prevCombinedQueries,
        prevSearchQueries,
        prevThread,
        prevLabels,
        prevDetailQueries,
      };
    },
    onError: (err, _vars, context) => {
      if (isIpcTimeout(err)) {
        // The backend mirrored it locally and finishes in the background.
        invalidateMailCaches(qc);
        return;
      }
      toast.error(describeGmailWriteError(err));
      if (!context) return;
      for (const [key, data] of context.prevMessagesQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevCombinedQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevSearchQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevDetailQueries) qc.setQueryData(key, data);
      if (context.prevThread) qc.setQueryData(context.threadKey, context.prevThread);
      if (context.prevLabels) qc.setQueryData(context.labelsKey, context.prevLabels);
    },
    onSuccess: (_data, { accountId }) => {
      void qc.invalidateQueries({ queryKey: ["gmail:messages", accountId] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedCounts"] });
      void qc.invalidateQueries({ queryKey: ["gmail:searchMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:thread", accountId] });
      void qc.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
    },
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: SendMessageParams) => {
      console.log("[hooks:useSendMessage] sending message", {
        to: params.to,
        subject: params.subject,
      });
      return gmailApi.sendMessage(params);
    },
    onSuccess: (_data, params) => {
      void qc.invalidateQueries({
        queryKey: ["gmail:messages", params.accountId],
      });
      // Replies land inside existing threads/views, so refresh those caches too.
      void qc.invalidateQueries({ queryKey: ["gmail:thread", params.accountId] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedCounts"] });
      void qc.invalidateQueries({ queryKey: ["gmail:searchMessages"] });
      void qc.invalidateQueries({ queryKey: queryKeys.labels(params.accountId) });
    },
  });
}

/** Recipient autocomplete backed by the local mail cache. */
export function useSuggestContacts(q: string, enabled = true) {
  return useQuery<ContactSuggestion[]>({
    queryKey: ["gmail:suggestContacts", q],
    queryFn: () => gmailApi.suggestContacts({ q }),
    enabled: enabled && q.trim().length > 0,
    staleTime: STALE_TIME,
    placeholderData: (prev) => prev,
  });
}

// ---- Local-first sync ----

/** Status poll cadence: quick while syncing, relaxed while downloading for offline, slow idle. */
export function syncStatusPollMs(status: SyncStatus | undefined): number {
  if (status?.syncing) return 1500;
  return status?.download ? 4000 : 10_000;
}

/**
 * Drives background sync for the active account: starts a sync when the
 * account changes, polls progress while syncing, and invalidates the message
 * and label queries as the local store fills in so views refresh live.
 * Returns the current sync status for display.
 */
export function useAccountSync(accountId: string | null): SyncStatus | null {
  const qc = useQueryClient();

  const statusQuery = useQuery<SyncStatus>({
    queryKey: ["gmail:syncStatus", accountId],
    queryFn: () => gmailApi.getSyncStatus(accountId!),
    enabled: accountId != null,
    // Idle poll (vs false) so timer-driven backend syncs are still noticed.
    refetchInterval: (query) => syncStatusPollMs(query.state.data),
  });

  // Start a sync whenever the active account changes.
  useEffect(() => {
    if (!accountId) return;
    console.log("[hooks:useAccountSync] starting sync", { accountId });
    void gmailApi.syncAccount(accountId).then(() => {
      void qc.invalidateQueries({ queryKey: ["gmail:syncStatus", accountId] });
    });
  }, [accountId, qc]);

  // Refresh views when sync changed what they show (revision moves), never
  // just because a routine check for new mail ran.
  useEffect(() => {
    const status = statusQuery.data;
    if (!status || !accountId) return;
    if (shouldRefreshLists(accountId, status)) {
      void qc.invalidateQueries({ queryKey: ["gmail:messages", accountId] });
      void qc.invalidateQueries({ queryKey: ["gmail:searchMessages"] });
      void qc.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
      // Account-owned view badges and an open conversation (new replies).
      void qc.invalidateQueries({ queryKey: ["gmail:combinedCounts"] });
      void qc.invalidateQueries({ queryKey: ["gmail:thread", accountId] });
    }
  }, [statusQuery.data, accountId, qc]);

  return statusQuery.data ?? null;
}

/**
 * Whether sync changed the cache since lists last refreshed (its revision
 * moved). Every refetch of an infinite list reloads ALL its loaded pages, so
 * while a long full sync of a big mailbox keeps writing, lists refresh at
 * most every LIST_REFRESH_MS; once sync is idle a change refreshes at once.
 * Offline body downloads don't change list rows and don't move the revision.
 */
const LIST_REFRESH_MS = 8000;
const lastListRefresh = new Map<string, number>();
const refreshedRevision = new Map<string, number>();
function shouldRefreshLists(key: string, status: SyncStatus): boolean {
  const seen = refreshedRevision.get(key);
  if (seen === undefined) {
    // First status for this view: its lists were just loaded.
    refreshedRevision.set(key, status.revision);
    return false;
  }
  if (status.revision === seen) return false;
  const now = Date.now();
  if (status.syncing && now - (lastListRefresh.get(key) ?? 0) < LIST_REFRESH_MS) return false;
  refreshedRevision.set(key, status.revision);
  lastListRefresh.set(key, now);
  return true;
}

export function syncLabel(status: SyncStatus): string {
  if (status.syncing && status.phase === "full" && status.total) {
    return `Syncing ${status.synced.toLocaleString()} of ~${status.total.toLocaleString()}`;
  }
  if (status.syncing && status.phase === "full") return "Syncing…";
  if (status.download) {
    return `Downloading messages ${status.download.done.toLocaleString()} of ${status.download.total.toLocaleString()}`;
  }
  if (status.phase === "incremental") return "Checking for new mail…";
  return "Syncing…";
}

/** Aggregated sync activity across every account, for the sidebar footer. */
export function useGlobalSyncStatus(accountIds: string[]): { syncing: boolean; label: string } {
  const qc = useQueryClient();
  // The backend broadcasts when any sync starts so idle 10s polls don't miss
  // short syncs (menu-triggered "Synchronize All Mailboxes", the auto timer).
  useEffect(() => {
    const unsubscribe = window.desktopBridge.on("gmail:sync-started", () => {
      void qc.invalidateQueries({ queryKey: ["gmail:syncStatus"] });
    });
    return unsubscribe;
  }, [qc]);

  const results = useQueries({
    queries: accountIds.map((id) => ({
      queryKey: ["gmail:syncStatus", id],
      queryFn: () => gmailApi.getSyncStatus(id),
      refetchInterval: (query: { state: { data?: SyncStatus } }) =>
        syncStatusPollMs(query.state.data),
    })),
  });
  // Routine incremental checks stay silent (they'd blink every auto-sync
  // tick); only long-running work — full syncs and offline downloads — shows.
  const active = results
    .map((r) => r.data as SyncStatus | undefined)
    .filter(
      (s): s is SyncStatus => (s?.syncing === true && s.phase === "full") || s?.download != null,
    );
  if (active.length === 0) return { syncing: false, label: "" };
  return {
    syncing: true,
    label: active.length === 1 ? syncLabel(active[0]) : `Syncing ${active.length} accounts…`,
  };
}

/**
 * Same as `useAccountSync` but for every account at once — the Combined mailbox
 * has no single "active account" to drive `useAccountSync`, so its per-account
 * label counts (used by the mailbox header) would otherwise never refresh once
 * the background sync fills them in.
 */
export function useSyncAccountLabels(accountIds: string[], enabled: boolean): void {
  const qc = useQueryClient();

  const results = useQueries({
    queries: accountIds.map((id) => ({
      queryKey: ["gmail:syncStatus", id],
      queryFn: () => gmailApi.getSyncStatus(id),
      enabled,
      refetchInterval: (query: { state: { data?: SyncStatus } }) =>
        syncStatusPollMs(query.state.data),
    })),
  });

  const accountIdsKey = accountIds.join(",");
  useEffect(() => {
    if (!enabled) return;
    for (const id of accountIdsKey ? accountIdsKey.split(",") : []) {
      void gmailApi.syncAccount(id);
    }
  }, [enabled, accountIdsKey]);

  const progressKey = results
    .map((r) => {
      const s = r.data as SyncStatus | undefined;
      return s ? `${s.revision}:${s.syncing}` : "";
    })
    .join(",");
  useEffect(() => {
    if (!enabled) return;
    let anyProgressed = false;
    results.forEach((r, i) => {
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Serialized account and progress keys track meaningful query changes; result-array identities are unstable.
      const accountId = accountIds[i];
      const status = r.data as SyncStatus | undefined;
      if (!status) return;
      if (shouldRefreshLists(`combined:${accountId}`, status)) {
        anyProgressed = true;
        void qc.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
      }
    });
    // The combined list isn't reachable by any per-account invalidation.
    if (anyProgressed) {
      void qc.invalidateQueries({ queryKey: ["gmail:combinedMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedCounts"] });
      void qc.invalidateQueries({ queryKey: ["gmail:searchMessages"] });
    }
  }, [progressKey, enabled, accountIdsKey, qc]);
}

function useUntrashInvalidation() {
  const qc = useQueryClient();
  return (accountId: string) => {
    void qc.invalidateQueries({ queryKey: ["gmail:messages", accountId] });
    void qc.invalidateQueries({ queryKey: ["gmail:message", accountId] });
    void qc.invalidateQueries({ queryKey: ["gmail:combinedMessages"] });
    void qc.invalidateQueries({ queryKey: ["gmail:combinedCounts"] });
    void qc.invalidateQueries({ queryKey: ["gmail:searchMessages"] });
    void qc.invalidateQueries({ queryKey: ["gmail:thread", accountId] });
    void qc.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
  };
}

/** Optimistically clear TRASH from the open reader's caches (detail + thread);
    restored rows themselves reappear on the settle invalidation, since Gmail
    decides which labels come back. */
function useUntrashOptimism() {
  const qc = useQueryClient();
  return async (accountId: string, match: (m: GmailMessageSummary) => boolean) => {
    const threadsKey = ["gmail:thread", accountId];
    const detailKey = ["gmail:message", accountId];
    await Promise.all([
      qc.cancelQueries({ queryKey: threadsKey }),
      qc.cancelQueries({ queryKey: detailKey }),
    ]);
    const prevThreadQueries = qc.getQueriesData<GmailMessageSummary[]>({ queryKey: threadsKey });
    const prevDetailQueries = qc.getQueriesData<GmailMessageDetail>({ queryKey: detailKey });
    const patch = <T extends GmailMessageSummary>(m: T): T =>
      applyLabelPatch(m, [], ["TRASH"]) as T;
    qc.setQueriesData({ queryKey: threadsKey }, (old: GmailMessageSummary[] | undefined) =>
      old?.map((m) => (match(m) ? patch(m) : m)),
    );
    for (const [key, detail] of prevDetailQueries) {
      if (detail && match(detail)) qc.setQueryData(key, patch(detail));
    }
    return { prevThreadQueries, prevDetailQueries };
  };
}

type UntrashContext = Awaited<ReturnType<ReturnType<typeof useUntrashOptimism>>>;

function rollbackUntrash(
  qc: ReturnType<typeof useQueryClient>,
  err: unknown,
  context?: UntrashContext,
) {
  if (isIpcTimeout(err)) {
    invalidateMailCaches(qc);
    return;
  }
  toast.error(describeGmailWriteError(err));
  if (!context) return;
  for (const [key, data] of context.prevThreadQueries) qc.setQueryData(key, data);
  for (const [key, data] of context.prevDetailQueries) qc.setQueryData(key, data);
}

/** Permanent delete for Trash/Spam threads — one batched call per account.
    No undo entry — irreversible. */
export function useDeleteThreadsForever() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, threadIds }: { accountId: string; threadIds: string[] }) => {
      console.log("[hooks:useDeleteThreadsForever]", { accountId, count: threadIds.length });
      return gmailApi.deleteThreadsForever(accountId, threadIds);
    },
    onMutate: async ({ accountId, threadIds }) => {
      const idSet = new Set(threadIds);
      const labelsKey = queryKeys.labels(accountId);
      await Promise.all([
        qc.cancelQueries({ queryKey: ["gmail:messages", accountId] }),
        qc.cancelQueries({ queryKey: ["gmail:combinedMessages"] }),
        qc.cancelQueries({ queryKey: ["gmail:searchMessages"] }),
        qc.cancelQueries({ queryKey: ["gmail:thread", accountId] }),
        qc.cancelQueries({ queryKey: labelsKey }),
      ]);
      const prevMessagesQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:messages", accountId],
      });
      const prevCombinedQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:combinedMessages"],
      });
      const prevSearchQueries = qc.getQueriesData<InfiniteData<ListMessagesResult>>({
        queryKey: ["gmail:searchMessages"],
      });
      const prevThreads = threadIds.map(
        (threadId) =>
          [
            queryKeys.thread(accountId, threadId),
            qc.getQueryData<GmailMessageSummary[]>(queryKeys.thread(accountId, threadId)),
          ] as const,
      );
      const prevLabels = qc.getQueryData<GmailLabel[]>(labelsKey);

      const inThreads = (m: GmailMessageSummary) =>
        idSet.has(m.threadId || m.id) && (m.accountId ?? accountId) === accountId;
      qc.setQueriesData(
        { queryKey: ["gmail:messages", accountId] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          removeMessagesFromInfiniteData(old, inThreads),
      );
      qc.setQueriesData(
        { queryKey: ["gmail:combinedMessages"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          removeMessagesFromInfiniteData(old, inThreads),
      );
      qc.setQueriesData(
        { queryKey: ["gmail:searchMessages"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          removeMessagesFromInfiniteData(old, inThreads),
      );
      // Deleted forever: gone from Gmail search results too.
      qc.setQueriesData(
        { queryKey: ["gmail-search"] },
        (old: InfiniteData<ListMessagesResult> | undefined) =>
          removeMessagesFromInfiniteData(old, inThreads),
      );

      const merged = new Map<string, LabelCountDelta>();
      for (const [key, rows] of prevThreads) {
        for (const msg of rows ?? []) {
          for (const lid of msg.labelIds) {
            const cur = merged.get(lid) ?? { total: 0, unread: 0 };
            merged.set(lid, { total: cur.total - 1, unread: cur.unread - (msg.unread ? 1 : 0) });
          }
        }
        qc.setQueryData(key, []);
      }
      if (merged.size > 0) {
        qc.setQueryData<GmailLabel[]>(labelsKey, (old) => applyLabelCountDeltas(old, merged));
      }

      return {
        labelsKey,
        prevMessagesQueries,
        prevCombinedQueries,
        prevSearchQueries,
        prevThreads,
        prevLabels,
      };
    },
    onError: (err, _vars, context) => {
      if (isIpcTimeout(err)) {
        // The backend mirrored it locally and finishes in the background.
        invalidateMailCaches(qc);
        return;
      }
      toast.error(describeGmailWriteError(err));
      if (!context) return;
      for (const [key, data] of context.prevMessagesQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevCombinedQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevSearchQueries) qc.setQueryData(key, data);
      for (const [key, data] of context.prevThreads) qc.setQueryData(key, data);
      if (context.prevLabels) qc.setQueryData(context.labelsKey, context.prevLabels);
    },
    onSuccess: (_data, { accountId }) => {
      void qc.invalidateQueries({ queryKey: ["gmail:messages", accountId] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:combinedCounts"] });
      void qc.invalidateQueries({ queryKey: ["gmail:searchMessages"] });
      void qc.invalidateQueries({ queryKey: ["gmail:message", accountId] });
      void qc.invalidateQueries({ queryKey: ["gmail:thread", accountId] });
      void qc.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
    },
  });
}

/** Empty Junk / Empty Trash for some accounts — permanent, so it clears the
    undo slot, and the toast reports what went. */
export function useEmptyFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      accountIds,
      labelId,
    }: {
      accountIds: string[];
      labelId: "SPAM" | "TRASH";
    }) => {
      console.log("[hooks:useEmptyFolder]", { accounts: accountIds.length, labelId });
      const results = await Promise.all(accountIds.map((id) => gmailApi.emptyFolder(id, labelId)));
      return results.reduce((sum, r) => sum + r.deleted, 0);
    },
    onSuccess: (deleted, { labelId }) => {
      clearUndo();
      invalidateMailCaches(qc);
      const where = labelId === "SPAM" ? "Junk" : "Trash";
      toast.success(
        deleted === 0
          ? `${where} was already empty`
          : `Deleted ${deleted.toLocaleString()} message${deleted === 1 ? "" : "s"} from ${where}`,
      );
    },
    onError: (err) => toast.error(`Couldn't empty it: ${describeGmailWriteError(err)}`),
  });
}

export function useUntrashThread() {
  const qc = useQueryClient();
  const invalidate = useUntrashInvalidation();
  const optimism = useUntrashOptimism();
  return useMutation({
    mutationFn: (params: { accountId: string; threadId: string }) => {
      console.log("[hooks:useUntrashThread]", params);
      return gmailApi.untrashThread(params.accountId, params.threadId);
    },
    onMutate: ({ accountId, threadId }) =>
      optimism(accountId, (m) => (m.threadId || m.id) === threadId),
    onError: (err, _vars, context) => rollbackUntrash(qc, err, context),
    onSuccess: (_data, { accountId }) => invalidate(accountId),
  });
}

export function useUntrashMessage() {
  const qc = useQueryClient();
  const invalidate = useUntrashInvalidation();
  const optimism = useUntrashOptimism();
  return useMutation({
    mutationFn: (params: { accountId: string; messageId: string }) => {
      console.log("[hooks:useUntrashMessage]", params);
      return gmailApi.untrashMessage(params.accountId, params.messageId);
    },
    onMutate: ({ accountId, messageId }) => optimism(accountId, (m) => m.id === messageId),
    onError: (err, _vars, context) => rollbackUntrash(qc, err, context),
    onSuccess: (_data, { accountId }) => invalidate(accountId),
  });
}

export function useGetAttachment() {
  return useMutation({
    mutationFn: (params: {
      accountId: string;
      messageId: string;
      attachmentId: string;
      filename: string;
      mimeType: string;
    }) => {
      console.log("[hooks:useGetAttachment] downloading attachment", {
        filename: params.filename,
      });
      return gmailApi.getAttachment(params);
    },
  });
}
