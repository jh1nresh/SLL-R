import { GoogleGenAI } from "@google/genai";
import type { LlmAgent, LlmAgentDeps } from "./llm.js";

// Gemini implementation of LlmAgent. Uses a chat session so history + thought
// signatures are managed by the SDK. SLL-R tool JSON Schemas map directly to
// Gemini's `parametersJsonSchema` — no conversion.
export class GeminiAgent implements LlmAgent {
  private readonly chat: ReturnType<GoogleGenAI["chats"]["create"]>;
  private readonly callTool: LlmAgentDeps["callTool"];

  constructor(apiKey: string, model: string, deps: LlmAgentDeps) {
    const ai = new GoogleGenAI({ apiKey });
    this.callTool = deps.callTool;
    this.chat = ai.chats.create({
      model,
      config: {
        systemInstruction: deps.systemPrompt,
        tools: [{
          functionDeclarations: deps.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.parameters,
          })),
        }],
      },
    });
  }

  async send(userText: string): Promise<string> {
    let response = await this.sendWithRetry({ message: userText });
    // Resolve function calls until the model returns plain text.
    for (let guard = 0; guard < 12; guard++) {
      const calls = response.functionCalls ?? [];
      if (calls.length === 0) break;
      const parts = [];
      for (const fc of calls) {
        let result: unknown;
        try {
          result = await this.callTool(fc.name ?? "", (fc.args as Record<string, unknown>) ?? {});
        } catch (error) {
          result = { error: error instanceof Error ? error.message : "tool call failed" };
        }
        parts.push({ functionResponse: { name: fc.name ?? "", response: { result } } });
      }
      response = await this.sendWithRetry({ message: parts });
    }
    return response.text ?? "";
  }

  // Gemini occasionally returns transient 503 UNAVAILABLE / 429 overloaded. Retry
  // with exponential backoff so a blip doesn't surface to the customer.
  private async sendWithRetry(
    message: Parameters<GeminiAgent["chat"]["sendMessage"]>[0],
  ): Promise<Awaited<ReturnType<GeminiAgent["chat"]["sendMessage"]>>> {
    const delays = [400, 1200, 3000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.chat.sendMessage(message);
      } catch (error) {
        if (attempt >= delays.length || !isTransient(error)) throw error;
        await sleep(delays[attempt]);
      }
    }
  }
}

function isTransient(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /\b(503|429|500)\b/.test(msg) || msg.includes("unavailable") || msg.includes("overloaded") || msg.includes("rate limit");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
