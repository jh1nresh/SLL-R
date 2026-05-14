import { adapterManifest } from "./adapters/registry.js";
import { merchantProfiles } from "./merchants/profiles.js";

export function sllrManifest(origin: string) {
  return {
    name: "SLL-R by Jiagon",
    description: "Installable seller agents for merchants in the agent economy.",
    version: "0.1.0",
    role: "seller_operating_agent",
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
      quote: `${origin}/quote`,
      orders: `${origin}/orders`,
      paymentWebhook: `${origin}/webhooks/payment`,
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
