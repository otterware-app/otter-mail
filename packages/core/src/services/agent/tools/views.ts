/**
 * The user's views, for the agent: saved filters across the mailboxes, each
 * a space in the app's rail (its list alone). A view is, for each mailbox,
 * the labels its mail must have and must not have; the mailboxes' matches
 * are combined. Agents name mailboxes by address and labels by name; the
 * tools go through the same handlers as the app's view dialog, so a change
 * shows at once and follows the account to every device.
 */

import { VIEW_COLORS, VIEW_ICON_KEYS } from "@otter-mail/shared/view-marks";
import type { MailAccount, MailView, ViewRule } from "../../../types.js";
import { labelId, labelsOf } from "./mail.js";
import {
  invoke,
  listMailboxes,
  mailbox,
  optStr,
  str,
  type AgentTool,
  type ToolArgs,
} from "./tool.js";

const listViews = async () =>
  (await invoke<MailView[]>("gmail:listViews", {})).filter((v) => v.kind === "custom");

async function findView(id: string): Promise<MailView> {
  const view = (await listViews()).find((v) => v.id === id);
  if (!view) throw new Error(`No view ${id}; list_views has their ids.`);
  return view;
}

const counts = (rules: ViewRule[]) =>
  invoke<{ total: number; unread: number }>("gmail:countCombinedMessages", { rules });

/** A view as agents see it: mailboxes by address, labels by name, and what it finds now. */
async function describe(view: MailView, accounts: MailAccount[]) {
  const rules = view.rules ?? [];
  const mailboxes = [];
  for (const rule of rules) {
    const account = accounts.find((a) => a.id === rule.accountId);
    if (!account) continue;
    const names = new Map((await labelsOf(account)).map((l) => [l.id, l.name]));
    mailboxes.push({
      account: account.email,
      mustHave: rule.allOf.map((id) => names.get(id) ?? id),
      mustNotHave: rule.noneOf.map((id) => names.get(id) ?? id),
    });
  }
  return {
    id: view.id,
    name: view.name,
    ...(view.icon ? { icon: view.icon } : {}),
    ...(view.color ? { color: view.color } : {}),
    rules: mailboxes,
    matches: await counts(rules),
  };
}

/** `rules` as the store keeps them: label names resolved in each mailbox. */
async function parseRules(args: ToolArgs): Promise<{ rules: ViewRule[]; summary: string[] }> {
  const raw = args.rules;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error(`"rules" must list at least one mailbox's labels.`);
  const rules: ViewRule[] = [];
  const summary: string[] = [];
  for (const entry of raw) {
    const rule = (entry ?? {}) as ToolArgs;
    const account = await mailbox(rule);
    const labels = await labelsOf(account);
    const names = (key: string) => {
      const list = rule[key];
      if (list === undefined || list === null) return [];
      if (!Array.isArray(list) || !list.every((v) => typeof v === "string"))
        throw new Error(`"${key}" must be a list of label names.`);
      return list as string[];
    };
    const mustHave = names("mustHave");
    const mustNotHave = names("mustNotHave");
    if (mustHave.length + mustNotHave.length === 0)
      throw new Error(`${account.email}: give it labels to have or not have.`);
    rules.push({
      accountId: account.id,
      allOf: mustHave.map((name) => labelId(account, labels, name)),
      noneOf: mustNotHave.map((name) => labelId(account, labels, name)),
    });
    summary.push(
      `${account.email}: ${[
        mustHave.length ? mustHave.join(" and ") : "any mail",
        mustNotHave.length ? `not ${mustNotHave.join(", not ")}` : "",
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
  }
  return { rules, summary };
}

/** An icon key or an emoji; null clears it. */
function iconArg(args: ToolArgs): string | null | undefined {
  if (args.icon === null) return null;
  const icon = optStr(args, "icon");
  if (icon === undefined) return undefined;
  if ((VIEW_ICON_KEYS as readonly string[]).includes(icon)) return icon;
  // Anything else short that isn't plain letters is taken for an emoji.
  if (icon.length <= 8 && !/^[\w\s-]+$/.test(icon)) return icon;
  throw new Error(`"${icon}" isn't an icon. Icons: ${VIEW_ICON_KEYS.join(", ")}; or an emoji.`);
}

/** A view color's name ("blue"), for approvals. */
const colorName = (hex: string) =>
  Object.entries(VIEW_COLORS).find(([, value]) => value === hex)?.[0] ?? hex;

/** A color by name (or its hex); null clears it. */
function colorArg(args: ToolArgs): string | null | undefined {
  if (args.color === null) return null;
  const color = optStr(args, "color")?.toLowerCase();
  if (color === undefined) return undefined;
  const hex = VIEW_COLORS[color as keyof typeof VIEW_COLORS] ?? color;
  if ((Object.values(VIEW_COLORS) as string[]).includes(hex)) return hex;
  throw new Error(`"${color}" isn't a view color: ${Object.keys(VIEW_COLORS).join(", ")}.`);
}

const RULES = {
  type: "array",
  description:
    "For each mailbox the view draws on: the labels its mail must have (all of them) and must not have (any). The mailboxes' matches are combined. Labels by name (list_labels), or inbox, starred, sent, drafts, important, unread.",
  items: {
    type: "object",
    properties: {
      account: { type: "string", description: "The mailbox, by address." },
      mustHave: { type: "array", items: { type: "string" } },
      mustNotHave: { type: "array", items: { type: "string" } },
    },
    required: ["account"],
  },
};

export const viewTools: AgentTool[] = [
  {
    name: "list_views",
    title: "List views",
    description:
      "The user's views: saved filters across their mailboxes, each a space in the app's rail. Each with its rules (per mailbox, labels it must and must not have) and how many conversations it finds now.",
    input: { type: "object", properties: {} },
    readOnly: true,
    async run() {
      const accounts = await listMailboxes();
      return { views: await Promise.all((await listViews()).map((v) => describe(v, accounts))) };
    },
  },
  {
    name: "save_view",
    title: "Save view",
    description:
      "Makes a view, or changes one (by `view`, its id; what's left out stays). A view only filters by labels: to gather mail by sender or subject, label it first. " +
      `It can wear an icon (${VIEW_ICON_KEYS.join(", ")}) or an emoji, in a color (${Object.keys(VIEW_COLORS).join(", ")}). Answers what it finds, to check the rules are right.`,
    input: {
      type: "object",
      properties: {
        view: { type: "string", description: "The view to change, by id. Leave out to make one." },
        name: { type: "string" },
        rules: RULES,
        icon: { type: "string", description: "An icon's key or an emoji; null for its initial." },
        color: { type: "string", description: "A color's name; null for none." },
      },
    },
    async run(args, ctx) {
      const id = optStr(args, "view");
      const existing = id ? await findView(id) : undefined;
      const name = existing ? (optStr(args, "name") ?? existing.name) : str(args, "name");
      const parsed = args.rules === undefined && existing ? undefined : await parseRules(args);
      const icon = iconArg(args);
      const color = colorArg(args);
      await ctx.confirm(
        [
          existing
            ? `Change the view “${existing.name}”${name !== existing.name ? `, renamed “${name}”` : ""}`
            : `Make the view “${name}”`,
          ...(parsed?.summary ?? []),
          ...(icon !== undefined || color !== undefined
            ? [
                `Wearing ${icon ?? existing?.icon ?? "its initial"}${color ? ` in ${colorName(color)}` : ""}`,
              ]
            : []),
        ].join("\n"),
      );
      const saved = await invoke<MailView>("gmail:saveView", {
        id: existing?.id,
        name,
        rules: parsed?.rules ?? existing?.rules ?? [],
        ...(icon !== undefined ? { icon } : {}),
        ...(color !== undefined ? { color } : {}),
      });
      ctx.changed?.({
        action: existing ? "updated" : "created",
        title: saved.name,
        target: { kind: "view", id: saved.id },
      });
      return describe(saved, await listMailboxes());
    },
  },
  {
    name: "delete_view",
    title: "Delete view",
    permanent: true,
    description: "Deletes a view. The mail and its labels stay as they are.",
    input: {
      type: "object",
      properties: { view: { type: "string", description: "Its id (from list_views)." } },
      required: ["view"],
    },
    async run(args, ctx) {
      const view = await findView(str(args, "view"));
      await ctx.confirm(`Delete the view “${view.name}” (the mail and its labels stay)`);
      await invoke("gmail:deleteView", { viewId: view.id });
      ctx.changed?.({
        action: "deleted",
        title: view.name,
        target: { kind: "view", id: view.id },
      });
      return { deleted: view.name };
    },
  },
];
