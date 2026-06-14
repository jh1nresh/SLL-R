import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.js";
import { createAgentSession } from "./core.js";

// CLI harness: chat with the SLL-R ordering agent in your terminal. Text in,
// agent reply out — the same AgentCore a channel adapter (Sendblue/LINE) will
// drive later. Validates the brain (Gemini + SLL-R MCP) before any channel.
async function main() {
  const config = loadConfig();
  process.stdout.write(`SLL-R agent CLI — model ${config.geminiModel}, backend ${config.sllrBaseUrl}\n`);

  const { agent, buyerId } = await createAgentSession(config, "CLI customer");
  process.stdout.write(`buyer: ${buyerId}\n`);
  process.stdout.write(`Type an order in natural language (e.g. "iced latte from Raposa, ready in 10 min"). Ctrl-D to quit.\n\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const line = (await rl.question("you ▸ ")).trim();
      if (!line) continue;
      let reply: string;
      try {
        reply = await agent.send(line);
      } catch (error) {
        reply = `⚠️ ${error instanceof Error ? error.message : "agent error"}`;
      }
      process.stdout.write(`\nsll-r ▸ ${reply}\n\n`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
