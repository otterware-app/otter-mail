/**
 * IPC timing helpers. Handlers doing slow Gmail work answer inside a budget
 * and finish in the background, so the UI never sits on a stalled request.
 */

import { broadcast } from "../ipc.js";

/** A label write can take several seconds while the first full sync is
 *  hogging the event loop or Gmail rate-limits us (the 429 backoff alone
 *  sleeps up to 7s), and the UI shouldn't wait on it. So: mirror the change locally right away, answer
 *  inside the budget, and let a slow write finish in the background — if that
 *  eventually fails, the mirror is reverted and the renderer is told. */
export const IPC_WRITE_BUDGET_MS = 4_000;

export async function settleWrite(
  channel: string,
  write: Promise<unknown>,
  revert: () => void,
): Promise<{ ok: true; pending?: boolean }> {
  const settled = write.then(
    () => "done" as const,
    (err: unknown) => {
      revert();
      throw err;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), IPC_WRITE_BUDGET_MS);
  });
  try {
    if ((await Promise.race([settled, deadline])) === "done") return { ok: true };
  } finally {
    clearTimeout(timer);
  }
  console.log(`[${channel}] still running past the IPC budget — finishing in the background`);
  settled.catch((err: unknown) => {
    console.log(`[${channel}] background write failed`, { error: String(err) });
    broadcast("gmail:write-failed", {
      channel,
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return { ok: true, pending: true };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Work that can take long — a file dialog waiting
 * on the user, a large attachment download. With a `taskId` the call returns
 * at once and the outcome arrives as a `task:done` notification (the
 * renderer's `task()` helper turns that back into a promise).
 */
export function runAsTask(
  taskId: string | undefined,
  work: () => Promise<unknown>,
): Promise<unknown> {
  if (!taskId) return work();
  void work().then(
    (result) => broadcast("task:done", { taskId, result }),
    (err: unknown) =>
      broadcast("task:done", {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      }),
  );
  return Promise.resolve({ accepted: true });
}

/** Lets slow background work run on, but never holds a reply longer than `ms`. */
export async function atMost(work: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([work.catch(() => {}), sleep(ms)]);
}
