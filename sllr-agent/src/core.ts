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

// Build a consumer ordering agent bound to a buyer session. The agent's tools
// are SLL-R's MCP tools; tool calls forward to SLL-R with the buyer's Bearer
// token so orders + receipts bind to this buyerId.
export async function createAgentSession(config: Config, customerLabel: string): Promise<AgentSession> {
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
    callTool: (name, args) => mcp.callTool(name, args, token),
  });

  return { agent, buyerId };
}
