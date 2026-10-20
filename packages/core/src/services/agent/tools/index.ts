/**
 * The tools Otter Mail gives the agents it runs: the user's mailboxes and
 * calendars, whatever provider each one uses, so an agent needs no mail CLI
 * of its own, the app's color themes and the user's views. The shell serves them (the Mac app:
 * an MCP server that Claude and Codex are pointed at, and other agents on the Mac given a token, apps/desktop
 * agent/mcp-server.ts) and says who is calling; tools that change a mailbox ask that chat's user first, the way
 * the agents' own approvals do, unless the chat has full access.
 */

import { logger } from "../../../logger.js";
import type { ApprovalDecision, ApprovalRequest } from "../types.js";
import { calendarTools } from "./calendar.js";
import { mailTools } from "./mail.js";
import { themeTools } from "./themes.js";
import { viewTools } from "./views.js";
import type { AgentTool, ToolArgs, ToolCaller } from "./tool.js";

export type { AgentTool, ToolCaller, ToolFiles } from "./tool.js";

const TOOLS: AgentTool[] = [...mailTools, ...calendarTools, ...themeTools, ...viewTools];

/** The MCP server's name: Claude sees the tools as `mcp__otter-mail__<tool>`. */
export const OTTER_TOOLS_SERVER = "otter-mail";

/** A tool's title ("Search mail"), for the chat's step rows. */
export function toolTitle(name: string): string | undefined {
  return TOOLS.find((t) => t.name === name)?.title;
}

/** The tools a caller can use: attachments need files on the device, and its access may leave out changes. */
export function agentTools(caller: ToolCaller): AgentTool[] {
  const access = caller.access?.() ?? "full-access";
  return TOOLS.filter(
    (t) =>
      (!t.needsFiles || caller.files) &&
      (t.readOnly || access === "full-access" || (access === "safe" && !t.permanent)),
  );
}

type Pending = { caller: ToolCaller; resolve: (decision: ApprovalDecision | "cancel") => void };

const pending = new Map<string, Pending>();
/** Tools each chat's user allowed for the rest of the chat. */
const allowed = new WeakMap<ToolCaller, Set<string>>();

/** Answers an approval a tool waits on; false when it isn't one of the tools'. */
export function answerToolApproval(approvalId: string, decision: ApprovalDecision): boolean {
  const waiting = pending.get(approvalId);
  waiting?.resolve(decision);
  return Boolean(waiting);
}

/** Drops a chat's open approvals (its turn stopped): those tool calls fail. */
export function cancelToolApprovals(caller: ToolCaller): void {
  for (const waiting of pending.values()) if (waiting.caller === caller) waiting.resolve("cancel");
}

async function confirm(
  tool: AgentTool,
  caller: ToolCaller,
  detail: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (caller.mode() === "full-access" || allowed.get(caller)?.has(tool.name)) return;
  const turn = caller.turn();
  if (!turn) throw new Error("No one is there to approve this.");
  signal?.throwIfAborted();
  const approval: ApprovalRequest = {
    id: crypto.randomUUID(),
    kind: "tool",
    title: tool.title,
    detail,
    choices: ["once", "session", "deny"],
  };
  const decision = await new Promise<ApprovalDecision | "cancel">((resolve) => {
    pending.set(approval.id, { caller, resolve });
    // The agent stopped waiting: allowing it now would act behind its back.
    signal?.addEventListener("abort", () => resolve("cancel"), { once: true });
    turn.emit({ requestId: turn.requestId, type: "approval", approval });
  });
  pending.delete(approval.id);
  turn.emit({ requestId: turn.requestId, type: "approvalResolved", approvalId: approval.id });
  if (decision === "session" || decision === "always") {
    const tools = allowed.get(caller) ?? new Set<string>();
    allowed.set(caller, tools.add(tool.name));
  } else if (decision !== "once") {
    throw new Error(decision === "cancel" ? "Stopped by the user." : "The user declined.");
  }
}

/** Each caller's latest change, which its next one waits for. */
const lastChange = new WeakMap<ToolCaller, Promise<unknown>>();

/**
 * Runs a tool for a caller: its result as JSON text, or what went wrong.
 * Changes run one after another in the order they were asked for (agents
 * send "add a label" and "remove it" at once); reads don't wait. `signal`
 * aborts when the caller stops waiting for the answer.
 */
export function runAgentTool(
  caller: ToolCaller,
  name: string,
  args: ToolArgs,
  signal?: AbortSignal,
): Promise<{ text: string; isError: boolean }> {
  const tool = agentTools(caller).find((t) => t.name === name);
  if (!tool) return Promise.resolve({ text: `No tool "${name}".`, isError: true });
  if (tool.readOnly) return run(tool, caller, args, signal);
  const result = (lastChange.get(caller) ?? Promise.resolve()).then(() =>
    run(tool, caller, args, signal),
  );
  lastChange.set(caller, result);
  return result;
}

async function run(
  tool: AgentTool,
  caller: ToolCaller,
  args: ToolArgs,
  signal: AbortSignal | undefined,
): Promise<{ text: string; isError: boolean }> {
  const name = tool.name;
  logger.info("agent", "tool", { tool: name });
  const turn = caller.turn();
  try {
    const result = await tool.run(args, {
      caller,
      confirm: (detail) => confirm(tool, caller, detail, signal),
      changed: (change) => {
        if (turn) turn.emit({ requestId: turn.requestId, type: "change", change });
      },
    });
    return { text: JSON.stringify(result ?? { ok: true }), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.info("agent", "tool failed", { tool: name, error: message });
    return { text: message, isError: true };
  }
}
