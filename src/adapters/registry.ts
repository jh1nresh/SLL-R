import type { PaymentRail } from "../types.js";

export type AdapterStatus = "ready" | "stubbed" | "planned";
export type AdapterRole = "staff_terminal" | "checkout_handoff" | "payment_proof" | "receipt_memory";

export type SellerAgentAdapter = {
  id: string;
  role: AdapterRole;
  label: string;
  status: AdapterStatus;
  supportedRails: PaymentRail[];
  responsibilities: string[];
  requiredEnv: string[];
};

const adapters: SellerAgentAdapter[] = [
  {
    id: "telegram-staff-terminal",
    role: "staff_terminal",
    label: "Telegram staff terminal",
    status: "ready",
    supportedRails: ["counter", "telegram_staff"],
    responsibilities: [
      "notify staff about incoming orders",
      "let staff confirm paid and done",
      "turn a completed pickup into receipt proof",
    ],
    requiredEnv: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_STAFF_CHAT_ID"],
  },
  {
    id: "shopify-checkout",
    role: "checkout_handoff",
    label: "Shopify checkout adapter",
    status: "stubbed",
    supportedRails: ["shopify"],
    responsibilities: [
      "map merchant catalog items to Shopify products",
      "create checkout handoff links",
      "normalize Shopify payment webhooks into SLL-R payment proof",
    ],
    requiredEnv: ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN", "SHOPIFY_WEBHOOK_SECRET"],
  },
  {
    id: "moonpay-commerce",
    role: "payment_proof",
    label: "MoonPay Commerce / Helio webhook adapter",
    status: "stubbed",
    supportedRails: ["moonpay", "helio", "solana_pay"],
    responsibilities: [
      "accept MoonPay Commerce or Helio checkout events",
      "verify payment amount and merchant order binding",
      "promote a paid order into SLL-R receipt memory",
    ],
    requiredEnv: ["MOONPAY_COMMERCE_WEBHOOK_SECRET", "SLLR_HELIO_WEBHOOK_SECRET"],
  },
  {
    id: "stripe-agentic-payments",
    role: "payment_proof",
    label: "Stripe agentic payments adapter",
    status: "planned",
    supportedRails: ["stripe"],
    responsibilities: [
      "accept Stripe payment intent events",
      "bind buyer-agent authorization to merchant order proof",
    ],
    requiredEnv: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  },
  {
    id: "solana-pay-reference",
    role: "payment_proof",
    label: "Solana Pay reference verification",
    status: "stubbed",
    supportedRails: ["solana_pay"],
    responsibilities: [
      "create Solana Pay URLs from SLL-R orders",
      "verify Solana Pay reference transactions",
      "bind crypto payment proof to an SLL-R order",
    ],
    requiredEnv: ["SLLR_SOLANA_PAY_RECIPIENT", "SLLR_SOLANA_PAY_VERIFY_SECRET"],
  },
  {
    id: "binance-pay-order-proof",
    role: "payment_proof",
    label: "Binance Pay order proof adapter",
    status: "planned",
    supportedRails: ["binance_pay"],
    responsibilities: [
      "create Binance Pay checkout handoff orders when the merchant enables the rail",
      "ingest Binance Pay PAY and PAY_REFUND webhooks as advisory events",
      "confirm final payment or refund state through Query Order before issuing receipt memory",
      "bind merchantTradeNo, prepayId, and transactionId to the SLL-R order proof",
    ],
    requiredEnv: ["BINANCE_PAY_API_KEY", "BINANCE_PAY_API_SECRET", "BINANCE_PAY_WEBHOOK_PUBLIC_KEY"],
  },
  {
    id: "sllr-receipts",
    role: "receipt_memory",
    label: "SLL-R receipt memory handoff",
    status: process.env.SLLR_RECEIPT_API_URL ? "ready" : "stubbed",
    supportedRails: ["counter", "telegram_staff", "shopify", "moonpay", "helio", "stripe", "solana_pay", "binance_pay"],
    responsibilities: [
      "issue portable receipt memory",
      "prepare Solana cNFT mint metadata",
      "return claim URLs for buyer agents and wallets",
    ],
    requiredEnv: ["SLLR_RECEIPT_API_URL", "SLLR_RECEIPT_API_KEY"],
  },
];

export function listAdapters() {
  return adapters;
}

export function adapterManifest() {
  return adapters.map((adapter) => ({
    id: adapter.id,
    role: adapter.role,
    label: adapter.label,
    status: adapter.status,
    supportedRails: adapter.supportedRails,
    responsibilities: adapter.responsibilities,
    requiredEnv: adapter.requiredEnv,
  }));
}
