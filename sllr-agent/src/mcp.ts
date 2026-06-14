// Thin JSON-RPC client for SLL-R's stateless Streamable HTTP MCP endpoint (/mcp).
// No MCP SDK needed — SLL-R's /mcp speaks plain JSON-RPC over POST.

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export class SllrMcp {
  private nextId = 0;

  constructor(private readonly baseUrl: string) {}

  private async rpc(method: string, params: unknown, bearer?: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.nextId, method, params }),
    });
    const payload = await res.json() as { result?: unknown; error?: { code?: number; message?: string } };
    if (!res.ok || payload.error) {
      throw new Error(`MCP ${method} failed: ${payload.error?.message || res.status}`);
    }
    return payload.result;
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "sllr-agent", version: "0.1.0" },
    });
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.rpc("tools/list", {}) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  // Returns the tool's structuredContent (the JSON object), or throws on a tool error.
  async callTool(name: string, args: Record<string, unknown>, bearer?: string): Promise<unknown> {
    const result = await this.rpc("tools/call", { name, arguments: args }, bearer) as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (result.isError) {
      const msg = result.content?.find((c) => c.type === "text")?.text || "tool error";
      throw new Error(msg);
    }
    return result.structuredContent ?? result.content;
  }

  // Mint a buyer session so orders/receipts bind to a stable buyerId.
  async issueBuyerSession(label: string): Promise<{ token: string; buyerId: string }> {
    const res = await fetch(`${this.baseUrl}/buyer/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    const payload = await res.json() as { token?: string; buyerId?: string };
    if (!res.ok || !payload.token || !payload.buyerId) {
      throw new Error(`buyer session failed: ${JSON.stringify(payload)}`);
    }
    return { token: payload.token, buyerId: payload.buyerId };
  }
}
