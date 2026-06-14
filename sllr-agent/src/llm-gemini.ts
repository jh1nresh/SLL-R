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
    let response = await this.chat.sendMessage({ message: userText });
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
      response = await this.chat.sendMessage({ message: parts });
    }
    return response.text ?? "";
  }
}
