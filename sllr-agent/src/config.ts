export type Config = {
  geminiApiKey: string;
  geminiModel: string;
  sllrBaseUrl: string;
};

export function loadConfig(): Config {
  const geminiApiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set. Get one at https://aistudio.google.com and `export GEMINI_API_KEY=...`.");
  }
  return {
    geminiApiKey,
    geminiModel: (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim(),
    sllrBaseUrl: (process.env.SLLR_BASE_URL || "https://sll-r.vercel.app").trim().replace(/\/$/, ""),
  };
}
