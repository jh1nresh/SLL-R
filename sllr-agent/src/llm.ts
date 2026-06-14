// Provider-agnostic LLM agent seam. v0 = Gemini (llm-gemini.ts); swap for an
// Anthropic/Claude impl later without touching the channel or MCP code.

export type LlmTool = {
  name: string;
  description: string;
  // JSON Schema for the tool's arguments (SLL-R returns this verbatim).
  parameters: Record<string, unknown>;
};

// callTool forwards a tool invocation to SLL-R's MCP and returns the result JSON.
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface LlmAgent {
  // One conversational turn: the agent reasons, performs any tool calls via the
  // injected callTool, and returns the assistant's reply text. Conversation
  // history is held inside the implementation (in-process for the CLI).
  send(userText: string): Promise<string>;
}

export type LlmAgentDeps = {
  systemPrompt: string;
  tools: LlmTool[];
  callTool: CallTool;
};
