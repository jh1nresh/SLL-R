import {
  attachMerchantPayment,
  createMerchantOrder,
  getMerchant,
  getMerchantCapacity,
  getMerchantMenu,
  issueMerchantReceipt,
  listMerchantOrders,
  listMerchants,
  quoteMerchantOrder,
  grantMerchantConsent,
} from "./core/merchantApi.js";
import { recommendFromMenu } from "./core/menuRecommend.js";
import { createVerifiedReview } from "./core/verifiedReview.js";
import { acceptOrder, fulfillOrderMutation, getOrder, listOrdersForBuyer, markOrderReady, rejectOrder } from "./core/orders.js";
import { actionKeyFrom } from "./core/mutations.js";
import { setItemAvailability } from "./core/availability.js";
import { requireMerchantAuth } from "./core/merchantAuth.js";
import { recommendForBuyer } from "./core/recommend.js";
import { payWithSavedCard } from "./adapters/cardOnFile.js";
import { cancelSubscription, confirmRun, createSubscription, listPendingRuns, listSubscriptions } from "./core/recurring.js";
import { nearbyMerchants } from "./core/nearby.js";
import { merchantPaymentOptions } from "./core/paymentOptions.js";
import { createDemoMerchant } from "./adapters/shopifyCatalog.js";
import { shopForBuyer } from "./core/personalShop.js";
import { listMerchantOffers, quoteMerchantOffer } from "./core/offers.js";
import { createFulfillmentBatch, getFulfillmentBatch, listFulfillmentBatches } from "./core/batches.js";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const SERVER_INSTRUCTIONS = [
  "SLL-R is a merchant-backed commerce rail for personal agents. Use shop_for_me to compare grounded quotes across merchants, then keep consent, order, payment, fulfillment, and receipt as separate steps.",
  "Never submit or record a payment without explicit user approval.",
  "Before asking the user to approve payment, show merchant, item, amount, payment rail, and recipient or checkout URL.",
  "Most merchants accept non-crypto rails first: counter pay at pickup or Shopify checkout handoff. Crypto rails (base_usdc, solana_pay, helio) are optional adapters.",
  "Payment proof is not fulfillment proof. Final receipt memory must only be issued after merchant fulfillment or customer claim.",
  "attach_payment_proof with demo=true is local-demo proof only. Production requires the merchant verifier secret.",
].join("\n");

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
};

type McpToolResultPayload = {
  status: number;
  payload: unknown | null;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, origin: string, buyerId: string | null) => Promise<unknown> | unknown;
};

const quoteProperties = {
  merchantId: { type: "string", description: "Merchant id from list_merchants, for example raposa-coffee or solyd." },
  userIntent: { type: "string", description: "Natural-language buyer intent, for example 'I need an iced latte in 10 minutes.'" },
  itemId: { type: "string", description: "Optional exact catalog item id. Use the itemId returned by shop_for_me when continuing its quote." },
  maxSpendUsd: { type: "string", description: "Maximum budget in USD as a decimal string, for example '10.00'." },
  deadlineMinutes: { type: "number", description: "Pickup deadline in minutes for pickup merchants." },
  deliverByDays: { type: "number", description: "Shipping deadline in days for shipping merchants." },
  quantity: { type: "number", description: "Item quantity. Defaults to 1." },
  offerId: { type: "string", description: "Optional fixed offer id from list_offers. It must match the selected catalog item." },
  pickupAt: { type: "string", format: "date-time", description: "Optional exact scheduled pickup time. SLL-R binds it into quote consent and reserves the matching capacity window at order creation." },
} as const;

const idempotencyProperties = {
  idempotencyKey: { type: "string", description: "Stable caller-generated key for safe retry/resume. Reusing the same key with a different request is rejected." },
  actionKey: { type: "string", description: "Alias for idempotencyKey." },
} as const;

function requireString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`Missing required string argument: ${key}`), { status: 400 });
  }
  return value.trim();
}

const tools: ToolDefinition[] = [
  {
    name: "list_merchants",
    description: "List merchants that SLL-R can quote and order from, with fulfillment modes and supported payment rails.",
    inputSchema: { type: "object", properties: {} },
    handler: () => listMerchants(),
  },
  {
    name: "get_merchant",
    description: "Read one merchant profile: fulfillment modes, payment rails, and API links.",
    inputSchema: {
      type: "object",
      required: ["merchantId"],
      properties: { merchantId: quoteProperties.merchantId },
    },
    handler: (args) => getMerchant(requireString(args, "merchantId")),
  },
  {
    name: "get_menu",
    description: "Read the normalized catalog and menu sections for a merchant.",
    inputSchema: {
      type: "object",
      required: ["merchantId"],
      properties: { merchantId: quoteProperties.merchantId },
    },
    handler: (args) => getMerchantMenu(requireString(args, "merchantId")),
  },
  {
    name: "list_offers",
    description: "List Level 1 fixed merchant offers. Each offer pins one real catalog item and can be quoted without the agent inventing a SKU or price.",
    inputSchema: {
      type: "object",
      required: ["merchantId"],
      properties: { merchantId: quoteProperties.merchantId },
    },
    handler: (args) => listMerchantOffers(requireString(args, "merchantId")),
  },
  {
    name: "shop_for_me",
    description: "Personal-agent entry point: compare several merchants against the buyer's intent, budget, location, and pickup or shipping deadline. Returns persisted merchant-backed quotes only; it never creates consent, orders, payments, fulfillment, or receipts. Requires a buyer session.",
    inputSchema: {
      type: "object",
      required: ["userIntent"],
      properties: {
        userIntent: quoteProperties.userIntent,
        maxSpendUsd: quoteProperties.maxSpendUsd,
        deadlineMinutes: quoteProperties.deadlineMinutes,
        deliverByDays: quoteProperties.deliverByDays,
        quantity: quoteProperties.quantity,
        offerId: quoteProperties.offerId,
        pickupAt: quoteProperties.pickupAt,
        merchantIds: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string" }, description: "Optional merchant ids to compare. Otherwise SLL-R uses nearby or configured merchants." },
        category: { type: "string", description: "Optional merchant category filter, for example cafe." },
        lat: { type: "number", minimum: -90, maximum: 90, description: "Optional buyer latitude. Supply with lng." },
        lng: { type: "number", minimum: -180, maximum: 180, description: "Optional buyer longitude. Supply with lat." },
        radiusKm: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "Nearby search radius. Defaults to 25 km." },
        limit: { type: "integer", minimum: 1, maximum: 5, description: "Maximum ranked quote options. Defaults to 3." },
      },
    },
    handler: (args, _origin, buyerId) => {
      if (!buyerId) {
        throw Object.assign(new Error("No buyer session. Connect with an Authorization: Bearer <buyer token> header."), { status: 401 });
      }
      const { buyerId: _ignored, ...safeArgs } = args;
      return shopForBuyer(buyerId, safeArgs);
    },
  },
  {
    name: "quote_order",
    description: "Quote buyer intent against the merchant catalog, budget, quantity, and pickup or shipping deadline. Always quote before creating an order. Returns a quoteId + confirmationText to drive request_consent.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "userIntent"],
      properties: quoteProperties,
    },
    handler: (args, _origin, buyerId) =>
      quoteMerchantOrder(requireString(args, "merchantId"), buyerId ? { ...args, buyerId } : args),
  },
  {
    name: "quote_offer",
    description: "Quote a Level 1 fixed offer, optionally for an exact pickupAt window. Returns quote-bound confirmation text; it never creates an order.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "offerId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        offerId: { type: "string", description: "Offer id from list_offers." },
        quantity: quoteProperties.quantity,
        maxSpendUsd: quoteProperties.maxSpendUsd,
        deadlineMinutes: quoteProperties.deadlineMinutes,
        pickupAt: quoteProperties.pickupAt,
      },
    },
    handler: (args, _origin, buyerId) => quoteMerchantOffer(
      requireString(args, "merchantId"),
      requireString(args, "offerId"),
      buyerId ? { ...args, buyerId } : args,
    ),
  },
  {
    name: "recommend_order",
    description: "Recommend what to order under live constraints — time, budget, and taste tags — over the merchant's live menu/availability. Returns picks (fastest first, with ETA + price) AND the rejected alternatives with reasons (sold out / too slow / over budget / wrong tag). Use for 'what can I get in N minutes' asks. No hallucinated items or ETAs.",
    inputSchema: {
      type: "object",
      required: ["merchantId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        deadlineMinutes: { type: "number", description: "Max wait the customer has, e.g. 10." },
        maxSpendUsd: { type: "string", description: "Budget cap as a decimal string, e.g. '10.00'." },
        includeTags: { type: "array", items: { type: "string" }, description: "Required attributes, e.g. ['cold']." },
        excludeTags: { type: "array", items: { type: "string" }, description: "Attributes to avoid, e.g. ['sweet']." },
        limit: { type: "number", description: "Max picks to return (default 3)." },
      },
    },
    handler: (args) => recommendFromMenu(requireString(args, "merchantId"), {
      ...(args.deadlineMinutes !== undefined ? { deadlineMinutes: Number(args.deadlineMinutes) } : {}),
      ...(args.maxSpendUsd !== undefined ? { maxSpendUsd: String(args.maxSpendUsd) } : {}),
      ...(Array.isArray(args.includeTags) ? { includeTags: (args.includeTags as unknown[]).map(String) } : {}),
      ...(Array.isArray(args.excludeTags) ? { excludeTags: (args.excludeTags as unknown[]).map(String) } : {}),
      ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
    }),
  },
  {
    name: "create_verified_review",
    description: "Create a verified review for a completed order — only allowed after merchant fulfillment or customer claim produced final receipt memory. Records the agent's decision + promised-vs-actual ETA + the buyer's feedback. Requires a buyer session.",
    inputSchema: {
      type: "object",
      required: ["orderId"],
      properties: {
        orderId: { type: "string", description: "The completed order to review." },
        feedback: {
          type: "object",
          description: "Buyer feedback.",
          properties: {
            tooSpicy: { type: "boolean" }, tooSweet: { type: "boolean" }, tooSalty: { type: "boolean" },
            wouldRepeat: { type: "boolean" }, rating: { type: "number" }, note: { type: "string" },
          },
        },
        agentDecision: {
          type: "object",
          description: "Why the agent recommended this (for the next agent).",
          properties: {
            userIntent: { type: "string" }, whyRecommended: { type: "string" },
            alternativesRejected: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    handler: async (args, _origin, buyerId) => {
      if (!buyerId) throw Object.assign(new Error("No buyer session. Connect with an Authorization: Bearer <buyer token> header."), { status: 401 });
      const review = await createVerifiedReview(requireString(args, "orderId"), { feedback: args.feedback as never, agentDecision: args.agentDecision as never }, buyerId);
      return { product: "SLL-R verified review", review };
    },
  },
  {
    name: "request_consent",
    description: "Record the buyer's quote-bound consent before creating an authenticated order. Pass the quoteId from quote_order and the exact confirmationText shown to the buyer. Returns a consentId for create_order.",
    inputSchema: {
      type: "object",
      required: ["quoteId", "confirmationText"],
      properties: {
        quoteId: { type: "string", description: "The quoteId returned by quote_order." },
        confirmationText: { type: "string", description: "The exact quantity, unit-price, and total confirmationText returned with the quote." },
      },
    },
    handler: (args, _origin, buyerId) =>
      grantMerchantConsent(buyerId ? { ...args, buyerId } : args),
  },
  {
    name: "create_order",
    description: "Create an SLL-R order after the user accepts the quote. Buyer-authenticated calls must pass the bound quoteId + consentId; anonymous legacy channels can also be forced through consent with SLLR_REQUIRE_CONSENT.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "userIntent"],
      properties: {
        ...quoteProperties,
        agentId: { type: "string", description: "Identifier for the calling buyer agent." },
        customerLabel: { type: "string", description: "Display label for the customer, shown in the merchant terminal." },
        paymentMode: {
          type: "string",
          enum: ["counter", "checkout", "crypto"],
          description: "counter = pay at pickup, checkout = hosted checkout handoff, crypto = on-chain rail.",
        },
        quoteId: { type: "string", description: "Quote to bind the order to (from quote_order). Required when SLLR_REQUIRE_CONSENT is on." },
        consentId: { type: "string", description: "Consent receipt (from request_consent). Required when SLLR_REQUIRE_CONSENT is on." },
        acceptDelay: { type: "boolean", description: "Set true ONLY after the buyer re-confirms a longer wait (the rail returns 409 reconfirm_with_acceptDelay when the queue-aware ETA now exceeds their deadline or the quoted ETA)." },
        ...idempotencyProperties,
      },
    },
    handler: (args, _origin, buyerId) => {
      if (process.env.SLLR_REQUIRE_BUYER_AUTH === "true" && !buyerId) {
        throw Object.assign(new Error("Buyer authentication required. Connect the MCP server with an 'Authorization: Bearer <token>' from POST /buyer/session."), { status: 401 });
      }
      // Never trust a client-supplied buyerId; bind only from the resolved session.
      const { buyerId: _ignore, ...rest } = args;
      return createMerchantOrder(requireString(rest, "merchantId"), buyerId ? { ...rest, buyerId } : rest);
    },
  },
  {
    name: "list_my_orders",
    description: "List the calling buyer's own orders across all merchants. Requires a buyer session — connect with an 'Authorization: Bearer <token>' from POST /buyer/session.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, _origin, buyerId) => {
      if (!buyerId) {
        throw Object.assign(new Error("No buyer session. Connect the MCP server with an Authorization: Bearer <buyer token> header (get one from POST /buyer/session)."), { status: 401 });
      }
      return { product: "SLL-R buyer orders", buyerId, orders: await listOrdersForBuyer(buyerId) };
    },
  },
  {
    name: "pay_with_saved_card",
    description: "Charge the buyer's saved card for an order off-session (no link), after they confirm. Returns status: paid / already_paid / no_card / requires_action / declined. On no_card / requires_action / declined, fall back to get_payment_options (hosted Checkout link). Requires a buyer session.",
    inputSchema: {
      type: "object",
      required: ["orderId"],
      properties: { orderId: { type: "string", description: "SLL-R order id to charge." } },
    },
    handler: async (args, _origin, buyerId) => {
      if (!buyerId) {
        throw Object.assign(new Error("No buyer session. Connect with an Authorization: Bearer <buyer token> header (get one from POST /buyer/session)."), { status: 401 });
      }
      return { product: "SLL-R pay with saved card", ...(await payWithSavedCard(requireString(args, "orderId"), buyerId)) };
    },
  },
  {
    name: "create_recurring",
    description: "Set up a recurring order: a saved 'usual' plus a weekly schedule. SLL-R asks the buyer before each one (confirm-each) and charges the saved card off-session on yes, capped by maxPerRunUsd. Requires a buyer session.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "userIntent", "daysOfWeek", "hour", "minute", "tz", "maxPerRunUsd"],
      properties: {
        merchantId: { type: "string", description: "Merchant to order from." },
        userIntent: { type: "string", description: "The 'usual', e.g. 'iced oat latte'." },
        daysOfWeek: { type: "array", items: { type: "number" }, description: "Days to run: 0=Sun .. 6=Sat." },
        hour: { type: "number", description: "Local hour 0-23 to prompt." },
        minute: { type: "number", description: "Local minute 0-59." },
        tz: { type: "string", description: "IANA time zone, e.g. America/Los_Angeles." },
        maxPerRunUsd: { type: "string", description: "Hard per-run spend cap, e.g. '8.00'." },
        maxSpendUsd: { type: "string", description: "Optional per-order budget passed to the quote." },
        deadlineMinutes: { type: "number", description: "Optional pickup deadline minutes." },
        quantity: { type: "number", description: "Optional quantity." },
      },
    },
    handler: async (args, _origin, buyerId) => {
      if (!buyerId) throw Object.assign(new Error("No buyer session. Connect with an Authorization: Bearer <buyer token> header."), { status: 401 });
      const result = await createSubscription(buyerId, {
        merchantId: requireString(args, "merchantId"),
        template: {
          userIntent: requireString(args, "userIntent"),
          ...(args.maxSpendUsd !== undefined ? { maxSpendUsd: String(args.maxSpendUsd) } : {}),
          ...(args.deadlineMinutes !== undefined ? { deadlineMinutes: Number(args.deadlineMinutes) } : {}),
          ...(args.quantity !== undefined ? { quantity: Number(args.quantity) } : {}),
        },
        schedule: { daysOfWeek: (args.daysOfWeek as number[]) ?? [], hour: Number(args.hour), minute: Number(args.minute), tz: requireString(args, "tz") },
        maxPerRunUsd: requireString(args, "maxPerRunUsd"),
      });
      return { product: "SLL-R recurring subscription", ...result };
    },
  },
  {
    name: "list_recurring",
    description: "List the calling buyer's active recurring subscriptions. Requires a buyer session.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, _origin, buyerId) => {
      if (!buyerId) throw Object.assign(new Error("No buyer session."), { status: 401 });
      return { product: "SLL-R recurring subscriptions", subscriptions: await listSubscriptions(buyerId) };
    },
  },
  {
    name: "cancel_recurring",
    description: "Cancel one of the calling buyer's recurring subscriptions by id. Requires a buyer session.",
    inputSchema: { type: "object", required: ["subscriptionId"], properties: { subscriptionId: { type: "string" } } },
    handler: async (args, _origin, buyerId) => {
      if (!buyerId) throw Object.assign(new Error("No buyer session."), { status: 401 });
      return { product: "SLL-R recurring subscription", subscription: await cancelSubscription(requireString(args, "subscriptionId"), buyerId) };
    },
  },
  {
    name: "list_pending_recurring",
    description: "List recurring runs awaiting the buyer's confirmation (the prompts to ask 'order your usual now?'). Requires a buyer session.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, _origin, buyerId) => {
      if (!buyerId) throw Object.assign(new Error("No buyer session."), { status: 401 });
      return { product: "SLL-R recurring runs", runs: await listPendingRuns(buyerId) };
    },
  },
  {
    name: "confirm_recurring",
    description: "Confirm a pending recurring run (the buyer said yes): creates the order and charges the saved card off-session. Returns status charged / no_card / requires_action / declined / over_cap / expired. Requires a buyer session.",
    inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } },
    handler: async (args, _origin, buyerId) => {
      if (!buyerId) throw Object.assign(new Error("No buyer session."), { status: 401 });
      return { product: "SLL-R recurring confirm", ...(await confirmRun(requireString(args, "runId"), buyerId)) };
    },
  },
  {
    name: "recommend_for_buyer",
    description: "Recommend items for the current buyer using their past orders across all merchants (the SLL-R taste graph). Use when the customer asks for a recommendation, what's good, or a surprise. Returns cross-merchant picks with a reason. Requires a buyer session.",
    inputSchema: {
      type: "object",
      properties: {
        merchantId: { type: "string", description: "Optional: scope recommendations to a single merchant." },
        limit: { type: "number", description: "Max recommendations to return (default 3)." },
        lat: { type: "number", description: "Optional buyer latitude — scopes recommendations to nearby merchants." },
        lng: { type: "number", description: "Optional buyer longitude (with lat)." },
        radiusKm: { type: "number", description: "Nearby radius when lat/lng given (default 25)." },
      },
    },
    handler: async (args, _origin, buyerId) => {
      if (!buyerId) {
        throw Object.assign(new Error("No buyer session. Connect the MCP server with an Authorization: Bearer <buyer token> header (get one from POST /buyer/session)."), { status: 401 });
      }
      const lat = Number(args.lat);
      const lng = Number(args.lng);
      const location = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
      return {
        product: "SLL-R recommendations",
        buyerId,
        recommendations: await recommendForBuyer(buyerId, {
          merchantId: typeof args.merchantId === "string" ? args.merchantId : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          location,
          radiusKm: typeof args.radiusKm === "number" ? args.radiusKm : undefined,
        }),
      };
    },
  },
  {
    name: "nearby_merchants",
    description: "Find merchants near a location (lat/lng), sorted by distance. Use the buyer's current location to recommend or order from nearby spots. Online-only merchants (no geo) are excluded.",
    inputSchema: {
      type: "object",
      required: ["lat", "lng"],
      properties: {
        lat: { type: "number" },
        lng: { type: "number" },
        radiusKm: { type: "number", description: "Default 15." },
        category: { type: "string", description: "Optional filter, e.g. cafe." },
        limit: { type: "number", description: "Default 5." },
      },
    },
    handler: (args) => {
      const lat = Number(args.lat);
      const lng = Number(args.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw Object.assign(new Error("nearby_merchants requires numeric lat and lng."), { status: 400 });
      }
      return {
        product: "SLL-R nearby merchants",
        merchants: nearbyMerchants(lat, lng, {
          radiusKm: typeof args.radiusKm === "number" ? args.radiusKm : undefined,
          category: typeof args.category === "string" ? args.category : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      };
    },
  },
  {
    name: "merchant_accept_order",
    description: "Agent POS: accept an incoming order (-> accepted / payment_backed). Note can carry an ETA. Requires the merchant verifier secret (verificationToken) or demo:true.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "orderId"],
      properties: {
        merchantId: { type: "string" },
        orderId: { type: "string" },
        note: { type: "string", description: "Optional note shown on the order, e.g. \"ready in 12 min\"." },
        verificationToken: { type: "string", description: "Merchant verifier secret." },
      },
    },
    handler: async (args) => {
      await requireMerchantAuth({}, args, requireString(args, "merchantId"));
      const order = await acceptOrder(requireString(args, "orderId"), {
        merchantId: requireString(args, "merchantId"),
        actor: "agent-pos",
        note: typeof args.note === "string" ? args.note : undefined,
      });
      return { product: "SLL-R agent POS", status: order.status, order };
    },
  },
  {
    name: "list_capacity_windows",
    description: "List Level 3 atomic pickup-capacity windows for one merchant and production class before quoting a scheduled order.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "productionClass"],
      properties: {
        merchantId: quoteProperties.merchantId,
        productionClass: { type: "string", enum: ["espresso", "cold", "pastry", "general"] },
        from: { type: "string", format: "date-time" },
        count: { type: "integer", minimum: 1, maximum: 32 },
      },
    },
    handler: (args) => getMerchantCapacity(requireString(args, "merchantId"), args),
  },
  {
    name: "create_fulfillment_batch",
    description: "Create a Level 2 merchant fulfillment batch from 2-50 independent orders. Every buyer keeps separate quote, consent, and payment identity. Orders must share one pickup window. Merchant authorization required.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "orderIds"],
      properties: {
        merchantId: quoteProperties.merchantId,
        orderIds: { type: "array", minItems: 2, maxItems: 50, uniqueItems: true, items: { type: "string" } },
        label: { type: "string", maxLength: 100 },
        verificationToken: { type: "string", description: "Merchant verifier secret or per-merchant token." },
        demo: { type: "boolean", description: "Local demo authorization only when no verifier secret is configured." },
        ...idempotencyProperties,
      },
    },
    handler: async (args) => {
      const merchantId = requireString(args, "merchantId");
      await requireMerchantAuth({}, args, merchantId);
      return createFulfillmentBatch(merchantId, args);
    },
  },
  {
    name: "list_fulfillment_batches",
    description: "List Level 2 fulfillment batches for a merchant while preserving each child order's independent consent, payment, and receipt state. Merchant authorization required.",
    inputSchema: {
      type: "object",
      required: ["merchantId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        verificationToken: { type: "string" },
        demo: { type: "boolean" },
      },
    },
    handler: async (args) => {
      const merchantId = requireString(args, "merchantId");
      await requireMerchantAuth({}, args, merchantId);
      return listFulfillmentBatches(merchantId);
    },
  },
  {
    name: "get_fulfillment_batch",
    description: "Read the current aggregate state of a Level 2 fulfillment batch while preserving each child order's payment and fulfillment state. Merchant authorization required.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "batchId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        batchId: { type: "string" },
        verificationToken: { type: "string" },
        demo: { type: "boolean" },
      },
    },
    handler: async (args) => {
      const merchantId = requireString(args, "merchantId");
      await requireMerchantAuth({}, args, merchantId);
      return getFulfillmentBatch(requireString(args, "batchId"), merchantId);
    },
  },
  {
    name: "merchant_mark_ready",
    description: "Agent POS: mark an accepted order ready for pickup (-> ready). Requires the merchant verifier secret (verificationToken) or demo:true.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "orderId"],
      properties: {
        merchantId: { type: "string" },
        orderId: { type: "string" },
        verificationToken: { type: "string", description: "Merchant verifier secret." },
      },
    },
    handler: async (args) => {
      await requireMerchantAuth({}, args, requireString(args, "merchantId"));
      const order = await markOrderReady(requireString(args, "orderId"), {
        merchantId: requireString(args, "merchantId"),
        actor: "agent-pos",
      });
      return { product: "SLL-R agent POS", status: order.status, order };
    },
  },
  {
    name: "merchant_reject_order",
    description: "Agent POS: reject an order the merchant can't fulfill (-> rejected). Requires the merchant verifier secret (verificationToken) or demo:true.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "orderId"],
      properties: {
        merchantId: { type: "string" },
        orderId: { type: "string" },
        note: { type: "string", description: "Optional reason." },
        verificationToken: { type: "string", description: "Merchant verifier secret." },
      },
    },
    handler: async (args) => {
      await requireMerchantAuth({}, args, requireString(args, "merchantId"));
      const order = await rejectOrder(requireString(args, "orderId"), {
        merchantId: requireString(args, "merchantId"),
        actor: "agent-pos",
        note: typeof args.note === "string" ? args.note : undefined,
      });
      return { product: "SLL-R agent POS", status: order.status, order };
    },
  },
  {
    name: "merchant_fulfill_order",
    description: "Agent POS: mark an order fulfilled/handed over — this issues the SLL-R receipt. Requires the merchant verifier secret (verificationToken) or demo:true.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "orderId"],
      properties: {
        merchantId: { type: "string" },
        orderId: { type: "string" },
        verificationToken: { type: "string", description: "Merchant verifier secret." },
        ...idempotencyProperties,
      },
    },
    handler: async (args) => {
      await requireMerchantAuth({}, args, requireString(args, "merchantId"));
      const { result: order, mutation } = await fulfillOrderMutation(requireString(args, "orderId"), {
        merchantId: requireString(args, "merchantId"),
        actor: "agent-pos",
      }, {
        requesterId: "agent-pos",
        actionKey: actionKeyFrom(args, "merchant_fulfill_order"),
      });
      return {
        product: "SLL-R agent POS",
        status: order.status,
        proofLevel: order.proofLevel,
        order,
        ...(mutation ? { mutation } : {}),
      };
    },
  },
  {
    name: "merchant_set_item_availability",
    description: "Agent POS: 86 an item (mark unavailable) or bring it back. Unavailable items can't be ordered. Requires the merchant verifier secret (verificationToken) or demo:true.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "itemId", "available"],
      properties: {
        merchantId: { type: "string" },
        itemId: { type: "string", description: "Catalog item id, e.g. iced-latte." },
        available: { type: "boolean", description: "false = 86 it, true = back in stock." },
        verificationToken: { type: "string", description: "Merchant verifier secret." },
      },
    },
    handler: async (args) => {
      await requireMerchantAuth({}, args, requireString(args, "merchantId"));
      const merchantId = requireString(args, "merchantId");
      const unavailable = await setItemAvailability(merchantId, requireString(args, "itemId"), args.available === true);
      return { product: "SLL-R agent POS", merchantId, unavailableItems: unavailable };
    },
  },
  {
    name: "list_orders",
    description: "Authorized Agent POS feed: list SLL-R orders for a merchant, optionally filtered by status (e.g. pending_payment, accepted, ready). Requires the merchant verifier secret or merchant-scoped token.",
    inputSchema: {
      type: "object",
      required: ["merchantId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        status: { type: "string", description: "Optional order status filter, for example pending_payment or ready." },
        verificationToken: { type: "string", description: "Merchant verifier secret or merchant-scoped token." },
        demo: { type: "boolean", description: "Local demo only, accepted only when no verifier secret is configured." },
      },
    },
    handler: async (args) => {
      const merchantId = requireString(args, "merchantId");
      await requireMerchantAuth({}, args, merchantId);
      return listMerchantOrders(merchantId, typeof args.status === "string" ? args.status : null);
    },
  },
  {
    name: "check_order_status",
    description: "Read current order state, payment status, fulfillment state, pickup promise, and receipt handoff. Buyer-bound orders require the matching buyer session; merchant access requires the verifier secret or merchant-scoped token.",
    inputSchema: {
      type: "object",
      required: ["orderId"],
      properties: {
        orderId: { type: "string", description: "SLL-R order id, for example ord_..." },
        verificationToken: { type: "string", description: "Merchant verifier secret or merchant-scoped token when the caller is not the owning buyer." },
        demo: { type: "boolean", description: "Local demo only, accepted only when no verifier secret is configured." },
      },
    },
    handler: async (args, _origin, buyerId) => {
      const orderId = requireString(args, "orderId");
      const order = await getOrder(orderId);
      if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
      if (!order.buyerId || order.buyerId !== buyerId) {
        await requireMerchantAuth({}, args, order.merchantId);
      }
      return { product: "SLL-R merchant terminal", order };
    },
  },
  {
    name: "get_payment_options",
    description: "List payment options for an existing order across the merchant's enabled rails: counter pay, Stripe checkout (card / Apple / Google Pay), LINE Pay, Shopify checkout, Base USDC, Solana Pay, or Helio. Show these to the user before any payment approval.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "orderId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        orderId: { type: "string", description: "SLL-R order id returned by create_order." },
        payer: { type: "string", description: "Optional payer wallet address for on-chain rails." },
      },
    },
    handler: (args, origin) => merchantPaymentOptions(requireString(args, "merchantId"), args, origin),
  },
  {
    name: "attach_payment_proof",
    description: "Attach payment proof to an order. This moves the payment state only; final receipt memory still requires merchant fulfillment or customer claim. Never call this without explicit user approval.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "orderId", "provider", "paymentId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        orderId: { type: "string", description: "SLL-R order id." },
        provider: {
          type: "string",
          enum: ["counter", "telegram_staff", "shopify", "moonpay", "helio", "stripe", "solana_pay", "base_usdc", "binance_pay"],
          description: "Payment rail that produced the proof. Must be enabled in the merchant profile.",
        },
        paymentId: { type: "string", description: "Provider transaction, payment, or reference id." },
        amountUsd: { type: "string", description: "Paid amount in USD as a decimal string. Defaults to the order subtotal." },
        verificationToken: { type: "string", description: "Merchant payment verifier secret for production proof." },
        demo: { type: "boolean", description: "Local demo proof only. Production must use verificationToken." },
        ...idempotencyProperties,
      },
    },
    handler: (args) => attachMerchantPayment(requireString(args, "merchantId"), {}, args),
  },
  {
    name: "create_demo_merchant",
    description: "Ingest a public Shopify storefront's products.json into a runtime demo merchant so it can be quoted and ordered immediately. Demo merchants get counter + Shopify checkout rails and persist when SLL-R uses a durable store. Use this to demo SLL-R against a real store's actual catalog.",
    inputSchema: {
      type: "object",
      required: ["storeDomain"],
      properties: {
        storeDomain: { type: "string", description: "Public storefront domain, for example panthercoffee.com. https is assumed." },
        name: { type: "string", description: "Merchant display name. Defaults to the domain." },
        merchantId: { type: "string", description: "Optional id; demo- prefix is enforced. Defaults to demo-<domain>." },
        category: { type: "string", description: "Merchant category, for example coffee_shop." },
        location: { type: "string", description: "Merchant location label." },
        fulfillment: { type: "string", enum: ["pickup", "shipping", "both"], description: "How orders are fulfilled. Defaults to shipping." },
        secret: { type: "string", description: "Required when SLLR_DEMO_MERCHANT_SECRET is configured on the server." },
      },
    },
    handler: (args, origin) => createDemoMerchant({}, args, origin),
  },
  {
    name: "issue_receipt",
    description: "Issue final receipt memory after merchant fulfillment proof. This is a merchant-side action gated by the verifier secret or per-merchant token. Payment proof alone never issues the final receipt.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "orderId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        orderId: { type: "string", description: "SLL-R order id." },
        actor: { type: "string", description: "Who fulfilled the order, for example raposa-staff." },
        note: { type: "string", description: "Fulfillment note stored on the receipt." },
        verificationToken: { type: "string", description: "Merchant verifier secret, required when the server configures SLLR_MERCHANT_PAYMENT_VERIFY_SECRET." },
        demo: { type: "boolean", description: "Local demo proof only, accepted only when no verifier secret is configured." },
        ...idempotencyProperties,
      },
    },
    handler: (args) => issueMerchantReceipt(requireString(args, "merchantId"), {}, args),
  },
];

function jsonRpcError(id: JsonRpcId, code: number, message: string, status = 200): McpToolResultPayload {
  return { status, payload: { jsonrpc: "2.0", id, error: { code, message } } };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): McpToolResultPayload {
  return { status: 200, payload: { jsonrpc: "2.0", id, result } };
}

function negotiateProtocolVersion(params: unknown) {
  const requested = typeof params === "object" && params && "protocolVersion" in params
    ? (params as { protocolVersion?: unknown }).protocolVersion
    : undefined;
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

async function callTool(params: unknown, origin: string, id: JsonRpcId, buyerId: string | null): Promise<McpToolResultPayload> {
  const name = typeof params === "object" && params && "name" in params
    ? (params as { name?: unknown }).name
    : undefined;
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return jsonRpcError(id, -32602, `Unknown tool: ${typeof name === "string" ? name : "(missing name)"}`);
  }
  const rawArguments = typeof params === "object" && params && "arguments" in params
    ? (params as { arguments?: unknown }).arguments
    : {};
  const args = typeof rawArguments === "object" && rawArguments
    ? { ...(rawArguments as Record<string, unknown>), __mcpRequestId: id }
    : { __mcpRequestId: id };
  try {
    const result = await tool.handler(args, origin, buyerId);
    return jsonRpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SLL-R tool call failed.";
    const mutation = typeof error === "object" && error && "mutation" in error
      ? (error as { mutation?: unknown }).mutation
      : undefined;
    return jsonRpcResult(id, {
      content: [{ type: "text", text: message }],
      ...(mutation ? { structuredContent: { mutation } } : {}),
      isError: true,
    });
  }
}

export function rejectMcpBrowserOrigin(originHeader: string | string[] | undefined, serverOrigin: string): boolean {
  // DNS-rebinding guard required by the MCP Streamable HTTP spec. Native MCP
  // clients do not send Origin; browsers always do.
  if (typeof originHeader !== "string" || !originHeader) return false;
  if (originHeader === serverOrigin) return false;
  try {
    const hostname = new URL(originHeader).hostname;
    return hostname !== "localhost" && hostname !== "127.0.0.1";
  } catch {
    return true;
  }
}

export async function handleMcpPost(body: unknown, origin: string, buyerId: string | null = null): Promise<McpToolResultPayload> {
  if (Array.isArray(body)) {
    return jsonRpcError(null, -32600, "JSON-RPC batching is not supported by this server.", 400);
  }
  if (typeof body !== "object" || !body) {
    return jsonRpcError(null, -32600, "Request body must be a JSON-RPC message object.", 400);
  }
  const message = body as JsonRpcMessage;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request.", 400);
  }

  if (message.id === undefined || message.id === null) {
    // Notifications (for example notifications/initialized) get 202 with no body.
    return { status: 202, payload: null };
  }
  if (typeof message.id !== "string" && typeof message.id !== "number") {
    return jsonRpcError(null, -32600, "JSON-RPC request id must be a string or number.", 400);
  }
  const id = message.id;

  switch (message.method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: negotiateProtocolVersion(message.params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "sllr-merchant-mcp", title: "SLL-R Merchant MCP", version: "0.1.0" },
        instructions: SERVER_INSTRUCTIONS,
      });
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call":
      return callTool(message.params, origin, id, buyerId);
    default:
      return jsonRpcError(id, -32601, `Method not found: ${message.method}`);
  }
}
