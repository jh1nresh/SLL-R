import type { Config } from "./config.js";
import { SllrMcp } from "./mcp.js";
import { GeminiAgent } from "./llm-gemini.js";
import type { LlmAgent, LlmTool } from "./llm.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

// Buyer-facing tools only. Merchant/server-side tools (issue_receipt,
// attach_payment_proof, create_demo_merchant) are intentionally NOT exposed to
// the consumer agent — those are gated server actions.
const BUYER_TOOL_ALLOWLIST = new Set([
  "list_merchants",
  "get_merchant",
  "get_menu",
  "quote_order",
  "create_order",
  "list_orders",
  "check_order_status",
  "get_payment_options",
  "list_my_orders",
]);

export type AgentSession = {
  agent: LlmAgent;
  buyerId: string;
};

// Observer fired after every successful SLL-R tool call. The channel layer uses
// this to react to side effects (e.g. create_order → push to the merchant)
// without the LLM ever knowing a merchant channel exists.
export type ToolResultHook = (name: string, args: Record<string, unknown>, result: unknown) => void;

// Build a consumer ordering agent bound to a buyer session. The agent's tools
// are SLL-R's MCP tools; tool calls forward to SLL-R with the buyer's Bearer
// token so orders + receipts bind to this buyerId.
export async function createAgentSession(
  config: Config,
  customerLabel: string,
  onToolResult?: ToolResultHook,
): Promise<AgentSession> {
  const mcp = new SllrMcp(config.sllrBaseUrl);
  await mcp.initialize();

  const { token, buyerId } = await mcp.issueBuyerSession(customerLabel);

  const mcpTools = await mcp.listTools();
  const tools: LlmTool[] = mcpTools
    .filter((t) => BUYER_TOOL_ALLOWLIST.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema && Object.keys(t.inputSchema).length > 0
        ? t.inputSchema
        : { type: "object", properties: {} },
    }));

  const agent = new GeminiAgent(config.geminiApiKey, config.geminiModel, {
    systemPrompt: SYSTEM_PROMPT,
    tools,
    callTool: async (name, args) => {
      const result = await mcp.callTool(name, args, token);
      if (onToolResult) {
        // Never let an observer error break the agent turn.
        try { onToolResult(name, args, result); } catch { /* ignore */ }
      }
      return result;
    },
  });

  return { agent, buyerId };
}
