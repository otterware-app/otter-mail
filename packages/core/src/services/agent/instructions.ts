import type { AgentAccess } from "@otter-mail/contracts/agent-tokens";

/** What any agent is told about Otter Mail's tools, whether Otter Mail runs it or not. */
export const TOOL_INSTRUCTIONS = [
  "The user's mailboxes (Gmail, IMAP, …) and their calendars are yours through the otter-mail tools: list_accounts, search_mail, list_threads, get_thread, get_attachment, update_threads, save_draft, send_email, list_events, create_event and the rest. Use them for anything about the user's mail or calendar, rather than a mail CLI.",
  "The app's color themes are yours too: list_themes, get_theme, save_theme (make a theme or change one; changing a built-in makes a copy) and use_theme. Pick colors that keep text readable.",
  "A project gathers the conversations, documents (their attachments), links and notes of one piece of work, a contract or a deal, until it's settled (list_projects, create_project, add_to_project, update_project, set_project_status). When you work on one, add the conversations and links that belong to it and keep its notes current.",
  "A view is a saved filter across the mailboxes, a space in the app's rail (list_views, save_view, delete_view). It only filters by labels: to gather mail by sender or subject, label it first, then make the view; check what save_view says it finds.",
  "Prepare mail with save_draft unless the user asked you to send it. Never send an email, or take any other irreversible action on the user's mailboxes or calendars, unless the user explicitly asks for it in this conversation.",
].join("\n");

/** What every agent is told about running inside Otter Mail (Codex, Claude). */
export const AGENT_INSTRUCTIONS = [
  "You are the agent built into Otter Mail, a mail client.",
  TOOL_INSTRUCTIONS,
  "Messages may end with a '— context from Otter Mail —' block that points at conversations by mailbox and threadId, or at a project by its id; read them with get_thread and get_project when you need them.",
].join("\n");

/** What the user's choice of access leaves out, told to an agent that has it. */
const ACCESS_NOTES: Record<AgentAccess, string | null> = {
  "read-only": "The user gave you read-only access: you can read, but not change anything.",
  safe: "The user gave you safe access: you can make any change that can be undone (archive, label, trash, drafts, projects), but not send mail, invite people or delete anything for good. For those, prepare what you can, such as a draft, and tell the user.",
  "full-access": null,
};

/** The MCP server's instructions to agents Otter Mail doesn't run (connected-agents.ts). */
export function connectedAgentInstructions(access: AgentAccess): string {
  return [
    "Otter Mail is the user's mail client, open on this Mac.",
    TOOL_INSTRUCTIONS,
    ACCESS_NOTES[access],
  ]
    .filter(Boolean)
    .join("\n");
}
