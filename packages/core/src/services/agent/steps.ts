/**
 * Every agent's tool calls as ToolSteps, side by side so they read the same
 * whichever agent ran them (Otter Code's canonical tool items, in small):
 * Claude's tool_use blocks, Codex's thread items and Hermes' tool events
 * each map here, and the chat renders only the steps.
 */

import { OTTER_TOOLS_SERVER, toolTitle } from "./tools/index.js";
import type { ToolStep } from "./types.js";

const DETAIL_CHARS = 2_000;

/** How much of a step's output the chat keeps, to show when the step opens. */
export const TOOL_OUTPUT_CHARS = 4_000;

/** `search_mail` / `getThread` → "Search mail". */
export function sentence(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/** `chris-google-accounts` → "Chris Google Accounts". */
function titled(name: string): string {
  return sentence(name).replace(/\b\w/g, (c) => c.toUpperCase());
}

const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

function oneLine(text: string, max = 80): string {
  const line = text.trim().split("\n")[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Arguments as compact JSON (the chat pretty-prints it). */
function argsDetail(args: unknown): string | undefined {
  if (args === undefined || args === null || args === "") return undefined;
  let value = args;
  if (typeof args === "string") {
    try {
      value = JSON.parse(args);
    } catch {
      return args.slice(0, DETAIL_CHARS);
    }
  }
  if (typeof value === "object" && Object.keys(value as object).length === 0) return undefined;
  return JSON.stringify(value).slice(0, DETAIL_CHARS);
}

const skillOf = (path: string) => path.match(/\/skills\/([^/]+)\/SKILL\.md$/i)?.[1];

// ── Kinds of step ────────────────────────────────────────────────────────────

export function commandStep(command: string): ToolStep {
  // Reading a skill's instructions is reading the skill.
  const skill = command.match(/\/skills\/([^/\s'"]+)\/SKILL\.md/i)?.[1];
  if (skill && /^\s*(cat|sed|head|less|bat|nl)\b/.test(command))
    return { kind: "skill", title: `Read ${titled(skill)} skill`, detail: command };
  return { kind: "command", title: `Ran ${oneLine(command)}`, detail: command };
}

export function readStep(path: string): ToolStep {
  const skill = skillOf(path);
  if (skill) return { kind: "skill", title: `Read ${titled(skill)} skill`, detail: path };
  return { kind: "read", title: `Read ${basename(path)}`, detail: path };
}

export function editStep(paths: string[]): ToolStep {
  return {
    kind: "edit",
    title: paths.length === 1 ? `Edited ${basename(paths[0])}` : `Edited ${paths.length} files`,
    detail: paths.join("\n"),
  };
}

function searchStep(pattern: string): ToolStep {
  return { kind: "search", title: `Searched for ${oneLine(pattern, 60)}`, detail: pattern };
}

function webSearchStep(query: string): ToolStep {
  return { kind: "web", title: "Searched the web", ...(query ? { detail: query } : {}) };
}

function fetchStep(url: string): ToolStep {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // not a URL: show it as it is
  }
  return { kind: "web", title: `Read ${host}`, detail: url };
}

function skillStep(name: string): ToolStep {
  return { kind: "skill", title: `Used ${titled(name)} skill` };
}

/** A tool of an MCP server; Otter Mail's own read by their titles. */
export function mcpStep(server: string, tool: string, args: unknown): ToolStep {
  const ours = server.replace(/_/g, "-") === OTTER_TOOLS_SERVER;
  return {
    kind: "tool",
    title: (ours && toolTitle(tool)) || sentence(tool),
    source: ours ? "Otter Mail" : titled(server),
    ...withDetail(argsDetail(args)),
  };
}

const withDetail = (detail: string | undefined) => (detail ? { detail } : {});

function genericStep(name: string, args: unknown): ToolStep {
  return { kind: "tool", title: sentence(name), ...withDetail(argsDetail(args)) };
}

// ── Each agent's tools ───────────────────────────────────────────────────────

/** A Claude Code tool_use; null for its own bookkeeping (loading deferred tools). */
export function claudeStep(name: string, input: Record<string, unknown>): ToolStep | null {
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (name) {
    case "Bash":
      return commandStep(text("command"));
    case "Read":
      return readStep(text("file_path"));
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return editStep([text("file_path") || text("notebook_path")]);
    case "Grep":
    case "Glob":
      return searchStep(text("pattern"));
    case "WebSearch":
      return webSearchStep(text("query"));
    case "WebFetch":
      return fetchStep(text("url"));
    case "Skill":
      return skillStep(text("skill") || text("command"));
    case "Task":
    case "Agent":
      return { kind: "tool", title: "Ran a subagent", ...withDetail(text("description")) };
    case "TodoWrite":
      return { kind: "tool", title: "Updated the plan" };
    case "ToolSearch":
      return null;
  }
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  return mcp ? mcpStep(mcp[1], mcp[2], input) : genericStep(name, input);
}

type CodexItem = { type?: string } & Record<string, unknown>;

/** A Codex thread item that is a step; null for messages and reasoning. */
export function codexStep(item: CodexItem): ToolStep | null {
  switch (item.type) {
    case "commandExecution": {
      // Codex parses what a command does: reading a file reads like Claude's Read.
      const actions = (item.commandActions ?? []) as {
        type?: string;
        command?: string;
        path?: string;
        query?: string;
      }[];
      const [action] = actions;
      if (actions.length === 1 && action.type === "read" && action.path)
        return readStep(action.path);
      if (actions.length === 1 && action.type === "search" && action.query)
        return searchStep(action.query);
      const command = action?.command ?? String(item.command ?? "command");
      // The shell wrapper Codex reports (`/bin/zsh -lc 'echo hi'`) → `echo hi`.
      return commandStep(command.replace(/^\/bin\/\w+ -l?c '(.*)'$/s, "$1"));
    }
    case "mcpToolCall":
      return mcpStep(String(item.server), String(item.tool), item.arguments);
    case "dynamicToolCall":
      return genericStep(String(item.tool ?? "tool"), item.arguments);
    case "webSearch":
      return webSearchStep(String(item.query ?? ""));
    case "fileChange":
      return editStep(
        ((item.changes ?? []) as { path?: string }[]).map((c) => c.path ?? "").filter(Boolean),
      );
    case "imageView":
      return { kind: "read", title: "Viewed an image", ...withDetail(item.path as string) };
    default:
      return null;
  }
}

/** A Hermes tool call (its own tools: terminal, read_file, skill_view, …). */
export function hermesStep(name: string, args: unknown): ToolStep {
  let parsed: Record<string, unknown> = {};
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } catch {
      // a preview, not JSON
    }
  } else if (args && typeof args === "object") parsed = args as Record<string, unknown>;
  const text = (key: string) => (typeof parsed[key] === "string" ? (parsed[key] as string) : "");
  // The session stream sends a preview of the input rather than JSON.
  const preview = typeof args === "string" && Object.keys(parsed).length === 0 ? args : "";
  switch (name) {
    case "terminal":
      if (text("command") || preview) return commandStep(text("command") || preview);
      break;
    case "read_file":
      if (text("path") || preview) return readStep(text("path") || preview);
      break;
    case "write_file":
    case "patch":
      if (text("path")) return editStep([text("path")]);
      break;
    case "search_files":
      return searchStep(text("pattern") || text("query"));
    case "web_search":
      return webSearchStep(text("query"));
    case "skill_view":
      if (text("name") || preview)
        return { kind: "skill", title: `Read ${titled(text("name") || preview)} skill` };
      break;
  }
  return genericStep(name, args);
}

/** An OpenClaw tool call: its shell (`bash`, `/usr/bin/bash -lc <command>`), else the tool by name. */
export function openClawStep(name: string, args: unknown): ToolStep {
  const command = (args as { command?: unknown } | null)?.command;
  if (name === "bash" && typeof command === "string")
    return commandStep(command.replace(/^(\S*\/)?bash -l?c /, "").replace(/^(['"])(.*)\1$/s, "$2"));
  return genericStep(name, args);
}
