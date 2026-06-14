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
  // get_payment_options is intentionally NOT exposed: the server calls it after
  // create_order and deterministically appends the pay link + pickup code, so the
  // agent can't skip it or duplicate it.
  "list_my_orders",
]);

export type AgentSession = {
  agent: LlmAgent;
  buyerId: string;
  token: string;
};

// Observer fired after every successful SLL-R tool call. The channel layer uses
// this to react to side effects (e.g. create_order → push to the merchant)
// without the LLM ever knowing a merchant channel exists.
export type ToolResultHook = (name: string, args: Record<string, unknown>, result: unknown) => void;

export type AgentSessionOpts = {
  onToolResult?: ToolResultHook;
  // Reuse an existing buyer (from a persistent channel→buyer mapping) so the
  // customer keeps the same buyerId + order history across restarts. If the
  // token is invalid/expired, a fresh session is issued.
  buyer?: { token: string; buyerId: string };
};

// Build a consumer ordering agent bound to a buyer session. The agent's tools
// are SLL-R's MCP tools; tool calls forward to SLL-R with the buyer's Bearer
// token so orders + receipts bind to this buyerId.
export async function createAgentSession(
  config: Config,
  customerLabel: string,
  opts: AgentSessionOpts = {},
): Promise<AgentSession> {
  const mcp = new SllrMcp(config.sllrBaseUrl);
  await mcp.initialize();

  // Reuse the stored buyer when present + still valid; otherwise issue fresh.
  // Probing list_my_orders both validates the token and warms past-order memory.
  let token: string;
  let buyerId: string;
  let pastOrders: Array<Record<string, unknown>> = [];
  if (opts.buyer) {
    ({ token, buyerId } = opts.buyer);
    try {
      const res = await mcp.callTool("list_my_orders", {}, opts.buyer.token) as { orders?: Array<Record<string, unknown>> };
      pastOrders = res.orders ?? [];
    } catch (error) {
      // Only re-issue when the token is genuinely invalid/expired (auth failure).
      // On a transient error (network/5xx) keep the stored buyer so we never
      // orphan the customer's order history over a blip.
      if (isAuthFailure(error)) {
        ({ token, buyerId } = await mcp.issueBuyerSession(customerLabel));
      }
    }
  } else {
    ({ token, buyerId } = await mcp.issueBuyerSession(customerLabel));
  }

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

  const systemPrompt = pastOrders.length > 0
    ? `${SYSTEM_PROMPT}\n\n${pastOrderMemory(pastOrders)}`
    : SYSTEM_PROMPT;

  const agent = new GeminiAgent(config.geminiApiKey, config.geminiModel, {
    systemPrompt,
    tools,
    callTool: async (name, args) => {
      const result = await mcp.callTool(name, args, token);
      if (opts.onToolResult) {
        // Never let an observer error break the agent turn.
        try { opts.onToolResult(name, args, result); } catch { /* ignore */ }
      }
      return result;
    },
  });

  return { agent, buyerId, token };
}

// True only for token-rejection errors (expired / unknown buyer session), so a
// transient network/5xx blip doesn't cause us to abandon a valid stored buyer.
function isAuthFailure(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes("buyer session") || msg.includes("401") || msg.includes("unauthor") || msg.includes("authentication required");
}

// Summarize the customer's recent orders so the agent can recommend "the usual"
// instead of interrogating them. Most-recent first, capped to keep context tight.
function pastOrderMemory(orders: Array<Record<string, unknown>>): string {
  const lines = orders.slice(-5).reverse().map((o) => {
    const item = (o.item as { name?: string } | undefined)?.name ?? "order";
    const merchant = (o.merchantName as string) || (o.merchantId as string) || "a merchant";
    return `- ${item} from ${merchant}`;
  });
  return [
    "RETURNING CUSTOMER — they have ordered before. Recent orders (newest first):",
    ...lines,
    "When they ask for a recommendation or say \"the usual\", lead with their past favorite (confirm the exact item + current price via the tools first). Greet them as a returning customer, briefly.",
  ].join("\n");
}
