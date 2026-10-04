/** The server agent API, shared by the Mac, web, and iPhone clients. */
export type OpenRouterModel = {
  slug: string;
  name: string;
  subProvider?: string;
  isDefault?: boolean;
  inputModalities: string[];
};

export type OpenRouterConnection = { connected: boolean; models: OpenRouterModel[] };

export type OpenRouterTool = {
  name: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
};

export type OpenRouterFile = { name: string; mime: string; data: string };
export type OpenRouterToolOutput = { text: string; isError: boolean; file?: OpenRouterFile };

export type OpenRouterTurn = {
  requestId: string;
  sessionId?: string;
  title?: string;
  input: string;
  model: string;
  tools: OpenRouterTool[];
  attachments?: OpenRouterFile[];
};

export type OpenRouterStep = {
  kind: "tool";
  title: string;
  source: string;
  detail: string;
};

export type OpenRouterMessage = {
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  toolCalls?: OpenRouterStep[];
};

export type OpenRouterSession = {
  id: string;
  title: string;
  source: string;
  lastActive: number;
  messageCount: number;
  preview: string | null;
};

export type OpenRouterEvent =
  | { requestId: string; type: "session"; sessionId: string }
  | { requestId: string; type: "delta"; text: string }
  | { requestId: string; type: "tool"; id: string; step: OpenRouterStep }
  | { requestId: string; type: "toolResult"; id: string; output: string }
  | { requestId: string; type: "done"; responseId: null }
  | { requestId: string; type: "error"; message: string }
  | {
      requestId: string;
      type: "toolRequest";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };
