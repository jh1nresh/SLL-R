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

// Sendblue + channel config for the iMessage server (server.ts). Kept separate
// from loadConfig() so the CLI does not need Sendblue credentials.
export type SendblueConfig = {
  apiKeyId: string;
  apiSecret: string;
  fromNumber: string;        // optional sender number; "" = Sendblue default
  webhookSecret: string;     // optional shared secret; "" = no inbound auth
  merchantNumber: string;    // fallback notify number for ALL merchants (single-merchant demo)
  merchantChannels: Record<string, string>; // per-merchant: merchantId -> notify number (multi-merchant)
  port: number;
};

// Parse SLLR_MERCHANT_CHANNELS, a JSON map of merchantId -> notify number, e.g.
// {"raposa-coffee":"+13055551234","louisa-coffee":"+886912345678"}. Each merchant
// gets its own line; orders route by merchantId. Bad JSON -> empty (logged by caller).
function parseMerchantChannels(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [id, num] of Object.entries(parsed)) {
      if (typeof num === "string" && num.trim()) out[id] = num.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function loadSendblueConfig(): SendblueConfig {
  const apiKeyId = (process.env.SENDBLUE_API_KEY_ID || "").trim();
  const apiSecret = (process.env.SENDBLUE_API_SECRET || "").trim();
  if (!apiKeyId || !apiSecret) {
    throw new Error("SENDBLUE_API_KEY_ID and SENDBLUE_API_SECRET are required. Get them from the Sendblue dashboard (Settings → API).");
  }
  const port = Number.parseInt(process.env.PORT || "8787", 10);
  return {
    apiKeyId,
    apiSecret,
    fromNumber: (process.env.SENDBLUE_FROM_NUMBER || "").trim(),
    webhookSecret: (process.env.SENDBLUE_WEBHOOK_SECRET || "").trim(),
    merchantNumber: (process.env.SLLR_MERCHANT_NUMBER || "").trim(),
    merchantChannels: parseMerchantChannels(process.env.SLLR_MERCHANT_CHANNELS || ""),
    port: Number.isFinite(port) ? port : 8787,
  };
}
