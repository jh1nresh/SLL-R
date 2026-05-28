import { adapterManifest } from "./adapters/registry.js";
import { merchantProfiles } from "./merchants/profiles.js";
import type { AgentShackListing } from "./types.js";

function agentShackListing(origin: string): AgentShackListing {
  return {
    id: "sllr-merchant-order-agent",
    name: "SLL-R",
    type: "merchant_agent",
    category: "local_commerce",
    version: "0.1.0",
    modes: ["one_time_call", "subscription", "fork"],
    runtime: {
      type: "hosted_endpoint",
      manifestUrl: `${origin}/.well-known/sllr-agent.json`,
    },
    evaluator: {
      policy: "order-fulfillment-v0",
      checks: [
        "merchant accepted or rejected the order",
        "merchant marked fulfillment or payment proof was attached",
        "receipt handoff includes order, merchant, item, status, and receipt hash",
      ],
    },
    receipt: {
      requiredFields: [
        "receiptId",
        "agentId",
        "workflowId",
        "operatorId",
        "merchantId",
        "customerId",
        "serviceType",
        "requestHash",
        "status",
        "evaluatorPolicyId",
        "evaluatorVerdict",
        "proofLevel",
        "receiptHash",
        "createdAt",
      ],
      proofLevels: ["order_intent_only", "payment_backed", "fulfilled", "receipt_memory_issued"],
    },
    settlement: {
      pass: "release_or_mark_completed",
      fail: "refund_revision_or_dispute",
    },
    reputation: {
      subjects: ["merchant", "customer", "agent", "evaluator"],
    },
    forking: {
      allowed: true,
      forkable: ["catalog", "merchant_profile", "staff_terminal", "checkout_adapter", "receipt_policy"],
      lineageFeeBps: 0,
    },
  };
}

export function sllrManifest(origin: string) {
  return {
    name: "SLL-R by Jiagon",
    description: "Installable seller agents for merchants in the agent economy.",
    version: "0.1.0",
    role: "seller_operating_agent",
    agentShack: agentShackListing(origin),
    dojo: {
      listingName: "SLL-R by Jiagon",
      category: "merchant agent",
      installModes: ["hosted", "template", "self-hosted"],
      buyerAgents: ["BUY-R", "Hermes", "ChatGPT", "Dojo workflows"],
    },
    boundaries: {
      sllr: "seller agent runtime",
      jiagon: "proof and receipt memory system",
      posAdapters: "internal checkout and POS workflow tools used by SLL-R",
    },
    endpoints: {
      manifest: `${origin}/.well-known/sllr-agent.json`,
      capabilities: `${origin}/capabilities`,
      merchants: `${origin}/merchants`,
      merchantMenu: `${origin}/merchants/{merchantId}/menu`,
      merchantQuote: `${origin}/merchants/{merchantId}/quote`,
      merchantOrders: `${origin}/merchants/{merchantId}/orders`,
      merchantPayment: `${origin}/merchants/{merchantId}/payment`,
      merchantReceipt: `${origin}/merchants/{merchantId}/receipt`,
      quote: `${origin}/quote`,
      orders: `${origin}/orders`,
      paymentWebhook: `${origin}/webhooks/payment`,
      solanaPayMerchants: `${origin}/solana-pay/merchants`,
      solanaPayPreparePayment: `${origin}/solana-pay/prepare-payment`,
      solanaPayVerifyPayment: `${origin}/solana-pay/verify-payment`,
      helioWebhook: `${origin}/webhooks/helio`,
    },
    capabilities: [
      "merchant catalog discovery",
      "quote-first order negotiation",
      "checkout handoff",
      "payment proof intake",
      "Jiagon receipt memory handoff",
      "Solana receipt cNFT ready proof",
    ],
    adapters: adapterManifest(),
    exampleMerchants: Object.values(merchantProfiles).map((merchant) => ({
      id: merchant.id,
      name: merchant.name,
      fulfillment: merchant.fulfillment,
      paymentRails: merchant.paymentRails,
    })),
  };
}
