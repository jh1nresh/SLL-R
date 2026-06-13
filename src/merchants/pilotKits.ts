import { merchantForId } from "./profiles.js";

function baseUrls(origin: string, merchantId: string) {
  return {
    manifest: `${origin}/.well-known/sllr-agent.json`,
    capabilities: `${origin}/capabilities?merchantId=${encodeURIComponent(merchantId)}`,
    pilotKit: `${origin}/pilot-kit?merchantId=${encodeURIComponent(merchantId)}`,
    orderQueue: `${origin}/orders?merchantId=${encodeURIComponent(merchantId)}`,
    quote: `${origin}/quote`,
    orders: `${origin}/orders`,
    paymentWebhook: `${origin}/webhooks/payment`,
  };
}

const merchantUseCases: Record<string, {
  pilotName: string;
  firstUseCase: string;
  buyerPrompt: string;
  staffFlow: string[];
  requiredSetup: string[];
  optionalSetup: string[];
}> = {
  "raposa-coffee": {
    pilotName: "Raposa pickup order agent",
    firstUseCase: "Let customers or buyer agents place pickup coffee orders without replacing Raposa's current counter payment flow.",
    buyerPrompt: "Get me an iced latte from Raposa Coffee under $10 and make sure it can be ready in 15 minutes.",
    staffFlow: [
      "Open the Raposa order queue.",
      "Accept orders the staff can fulfill in the requested pickup window.",
      "Take payment at the counter as usual.",
      "Mark fulfilled after handoff so SLL-R can issue receipt memory.",
    ],
    requiredSetup: [
      "Confirm menu items, prices, and prep-time estimates.",
      "Choose staff channel: hosted terminal first, Telegram later.",
      "Choose customer entry point: QR code, buyer-agent API, or Telegram bot.",
      "Decide whether receipt claim requires customer phone, wallet, or app account.",
    ],
    optionalSetup: ["Solana Pay link", "MoonPay checkout", "review eligibility page"],
  },
  "raposa-shop": {
    pilotName: "Raposa online coffee product agent",
    firstUseCase: "Let buyer agents quote shipped Raposa products and hand off checkout through Raposa's existing ecommerce/payment rail.",
    buyerPrompt: "Ship me Raposa cold brew or coffee beans under $25 this week.",
    staffFlow: [
      "Keep product catalog and stock synced.",
      "Let SLL-R quote product, budget, and shipping estimate.",
      "Complete checkout through existing ecommerce/payment rail.",
      "Use payment webhook or manual fulfillment to issue receipt memory.",
    ],
    requiredSetup: [
      "Confirm products, variants, prices, inventory, and shipping windows.",
      "Choose checkout rail: Shopify, MoonPay Commerce, Stripe, or manual checkout link.",
      "Provide webhook access only when ready for payment-backed receipts.",
    ],
    optionalSetup: ["Shopify catalog adapter", "MoonPay Commerce webhook", "post-purchase review unlock"],
  },
  solyd: {
    pilotName: "SOLYD product quote and checkout agent",
    firstUseCase: "Let buyer agents find the right SOLYD case, verify price/stock/shipping, and hand off to checkout.",
    buyerPrompt: "Find me a MagSafe iPhone 16 case from SOLYD under $90 with shipping this week.",
    staffFlow: [
      "Keep catalog, variants, and stock current.",
      "Let SLL-R quote compatible products and shipping estimates.",
      "Send the buyer to the existing checkout rail.",
      "Use payment webhook to issue a verified receipt memory after purchase.",
    ],
    requiredSetup: [
      "Confirm products, supported devices, colors, prices, stock, and shipping windows.",
      "Choose checkout rail: Shopify, MoonPay Commerce, Stripe, or manual checkout link.",
      "Confirm receipt destination and review/reputation policy.",
    ],
    optionalSetup: ["Shopify catalog adapter", "MoonPay Commerce webhook", "agent-readable product compatibility rules"],
  },
};

export function pilotKitForMerchant(merchantId: string, origin: string) {
  const merchant = merchantForId(merchantId);
  if (!merchant) return null;
  const useCase = merchantUseCases[merchantId] || {
    pilotName: `${merchant.name} seller agent`,
    firstUseCase: "Let buyer agents quote, order, and create receipt-worthy merchant outcomes.",
    buyerPrompt: `Order from ${merchant.name}.`,
    staffFlow: [
      "Review the order queue.",
      "Accept or reject incoming orders.",
      "Mark fulfilled after payment or handoff.",
      "Let SLL-R issue receipt memory.",
    ],
    requiredSetup: ["Confirm catalog", "Choose checkout rail", "Choose staff terminal", "Choose receipt destination"],
    optionalSetup: ["Payment webhook", "review unlock", "AgentShack listing page"],
  };

  return {
    product: "SLL-R pilot kit",
    merchant,
    agentShackListing: {
      type: "merchant_agent",
      category: "local_commerce",
      modes: ["one_time_call", "subscription", "fork"],
      evaluatorPolicyId: "order-fulfillment-v0",
      reputationSubjects: ["merchant", "customer", "agent", "evaluator"],
    },
    pilot: useCase,
    urls: baseUrls(origin, merchantId),
    apiExamples: {
      quote: {
        method: "POST",
        path: "/quote",
        body: {
          merchantId,
          userIntent: useCase.buyerPrompt,
          maxSpendUsd: merchant.id === "solyd" ? "90.00" : "25.00",
          ...(merchant.fulfillment.includes("pickup") ? { deadlineMinutes: 15 } : { deliverByDays: 7 }),
        },
      },
      createOrder: {
        method: "POST",
        path: "/orders",
        body: {
          merchantId,
          agentId: "buyer-agent-demo",
          userIntent: useCase.buyerPrompt,
          paymentMode: merchant.fulfillment.includes("pickup") ? "counter" : "checkout",
        },
      },
      merchantAccept: {
        method: "POST",
        path: "/orders/{orderId}/accept",
        body: {
          merchantId,
          actor: `${merchant.id}-staff`,
          note: "Accepted for pilot fulfillment.",
        },
      },
      merchantFulfill: {
        method: "POST",
        path: "/orders/{orderId}/fulfill",
        body: {
          merchantId,
          actor: `${merchant.id}-staff`,
          note: "Paid or fulfilled through the existing merchant workflow.",
          demo: true,
        },
        note: "Production replaces demo=true with SLLR_MERCHANT_PAYMENT_VERIFY_SECRET in x-sllr-merchant-payment-secret.",
      },
    },
    nextMeetingAsk: [
      "Approve the first catalog/menu snapshot.",
      "Pick the staff terminal path for the pilot.",
      "Pick payment proof level: manual fulfillment first or checkout webhook.",
      "Pick receipt claim path: wallet, phone, or email later.",
    ],
  };
}
