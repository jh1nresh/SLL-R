export type FulfillmentMode = "pickup" | "shipping";
export type ProductionClass = "espresso" | "cold" | "pastry" | "general";
export type PaymentRail =
  | "counter"
  | "telegram_staff"
  | "shopify"
  | "moonpay"
  | "helio"
  | "stripe"
  | "line_pay"
  | "solana_pay"
  | "base_usdc"
  | "binance_pay";
export type ProofLevel = "order_intent_only" | "payment_backed" | "fulfilled" | "receipt_memory_issued";
export type AgentShackListingType = "merchant_agent";
export type AgentShackMode = "one_time_call" | "subscription" | "fork";

export type Money = {
  amountMinor: number;
  currency: "USD" | "TWD";
};

export type CatalogItem = {
  id: string;
  name: string;
  amountUsd: string;
  fulfillment: FulfillmentMode[];
  productionClass?: ProductionClass;
  prepMinutes?: number;
  shippingDays?: number;
  inventory?: number;
  tags?: string[];
  productUrl?: string;
};

export type MenuItem = {
  id: string;
  name: string;
  section: string;
  description?: string;
  service?: "in_store" | "shipping";
  priceStatus: "listed" | "unlisted";
  amountUsd?: string;
  available?: boolean;
  tags?: string[];
};

export type MenuSection = {
  id: string;
  name: string;
  service: "in_store" | "shipping";
  source: string;
  items: MenuItem[];
};

export type MerchantProfile = {
  id: string;
  name: string;
  category: string;
  location: string;
  geo?: { lat: number; lng: number };
  fulfillment: FulfillmentMode[];
  paymentRails: PaymentRail[];
  currency?: Money["currency"];
  humanApproval: {
    requiredAboveUsd: string;
  };
  catalog: CatalogItem[];
  menuSections?: MenuSection[];
};

export type QuoteRequest = {
  merchantId: string;
  userIntent: string;
  itemId?: string;
  maxSpendUsd?: string;
  deadlineMinutes?: number;
  deliverByDays?: number;
  quantity?: number;
  offerId?: string;
  pickupAt?: string;
};

export type QuoteResult = {
  merchant: Pick<MerchantProfile, "id" | "name" | "fulfillment" | "paymentRails">;
  feasible: boolean;
  decision: "create_order_allowed" | "negotiate_or_ask_user";
  item: {
    id: string;
    name: string;
    quantity: number;
    amountUsd: string;
    subtotalUsd: string;
  } | null;
  estimate: {
    readyInMinutes: number | null;
    shippingDays: number | null;
  };
  reasons: string[];
  alternatives: Array<{
    itemId: string;
    name: string;
    amountUsd: string;
    reason: string;
  }>;
};

export type OrderRequest = QuoteRequest & {
  agentId?: string;
  customerLabel?: string;
  paymentMode?: "counter" | "checkout" | "crypto";
  buyerId?: string;
};

export type OrderLifecycle = {
  order: "open" | "rejected" | "completed";
  payment: "required" | "verified";
  fulfillment: "requested" | "accepted" | "rejected" | "ready" | "claimed" | "fulfilled";
  receipt: "none" | "issued";
};

export type CapacityWindowSnapshot = {
  id: string;
  merchantId: string;
  productionClass: ProductionClass;
  startsAt: string;
  endsAt: string;
  capacity: number;
  reserved: number;
  available: number;
};

export type CapacityReservation = {
  id: string;
  windowId: string;
  merchantId: string;
  productionClass: ProductionClass;
  quantity: number;
  startsAt: string;
  endsAt: string;
  status: "held" | "consumed" | "released";
  createdAt: string;
  updatedAt: string;
};

export type MerchantOffer = {
  id: string;
  merchantId: string;
  level: 1;
  kind: "instant_offer";
  title: string;
  lineItems: Array<{
    itemId: string;
    name: string;
    quantity: number;
    unitAmount: Money;
    subtotal: Money;
  }>;
  amount: Money;
  fulfillment: FulfillmentMode[];
  productionClass: ProductionClass;
  status: "active";
  startsAt: string | null;
  expiresAt: string | null;
  redemptionWindow: {
    mode: "quote_bound";
    startsAt: string | null;
    endsAt: string | null;
  };
  perBuyerLimit: number | null;
  inventoryLimit: number | null;
  terms: string[];
  source: {
    type: "merchant_catalog";
    reference: string;
    lastVerifiedAt: string | null;
    verificationStatus: "configured";
  };
};

export type FulfillmentBatch = {
  id: string;
  merchantId: string;
  label: string;
  level: 2;
  orderIds: string[];
  status: "open" | "in_progress" | "ready" | "completed";
  pickupWindow: {
    id: string;
    startsAt: string;
    endsAt: string;
  } | null;
  totals: {
    orders: number;
    quantity: number;
    amountUsd: string;
  };
  items: Array<{
    itemId: string;
    name: string;
    quantity: number;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type SellerOrder = {
  id: string;
  merchantId: string;
  merchantName: string;
  agentId: string;
  customerLabel: string;
  buyerId: string | null;
  offerId: string | null;
  batchId: string | null;
  lifecycle: OrderLifecycle;
  status: "pending_payment" | "accepted" | "rejected" | "payment_backed" | "ready" | "claimed" | "fulfilled" | "receipt_issued";
  proofLevel: ProofLevel;
  item: NonNullable<QuoteResult["item"]>;
  lineItems: Array<NonNullable<QuoteResult["item"]>>;
  promise: {
    status: "on_time" | "delayed_offer" | "not_applicable";
    productionClass: ProductionClass | "shipping";
    requestedReadyAt: string | null;
    promisedReadyAt: string | null;
    estimatedWaitMinutes: number | null;
    capacityWindowMinutes: number | null;
    readyAt: string | null;
    claimedAt: string | null;
    delayMinutes: number | null;
    capacityWindowId: string | null;
    capacityWindowStartsAt: string | null;
    capacityWindowEndsAt: string | null;
    scheduledPickup?: boolean;
  };
  capacityReservation: CapacityReservation | null;
  payment: {
    mode: "counter" | "checkout" | "crypto";
    status: "required" | "verified";
    provider: PaymentRail | null;
    paymentId: string | null;
  };
  terminal: {
    status: "requested" | "accepted" | "rejected" | "ready" | "claimed" | "fulfilled";
    actor: string | null;
    note: string | null;
    updatedAt: string | null;
  };
  receipt: ReceiptHandoff | null;
  createdAt: string;
  updatedAt: string;
};

export type MerchantOrderFilter = {
  merchantId?: string;
  status?: SellerOrder["status"];
};

export type MerchantActionRequest = {
  merchantId: string;
  actor?: string;
  note?: string;
};

export type PaymentWebhook = {
  orderId: string;
  merchantId: string;
  provider: PaymentRail;
  amountUsd: string;
  paymentId: string;
};

export type ReceiptHandoff = {
  status: "stubbed" | "submitted";
  receiptMemoryId: string;
  receiptHash: string;
  claimUrl: string;
  cnftStatus: "pending" | "ready_for_mint";
};

export type AgentShackListing = {
  id: string;
  name: string;
  type: AgentShackListingType;
  category: string;
  version: string;
  modes: AgentShackMode[];
  runtime: {
    type: "hosted_endpoint" | "self_hosted_template";
    manifestUrl: string;
  };
  evaluator: {
    policy: string;
    checks: string[];
  };
  receipt: {
    requiredFields: string[];
    proofLevels: ProofLevel[];
  };
  settlement: {
    pass: string;
    fail: string;
  };
  reputation: {
    subjects: string[];
  };
  forking: {
    allowed: boolean;
    forkable: string[];
    lineageFeeBps: number;
  };
};
