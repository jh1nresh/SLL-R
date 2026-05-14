export type FulfillmentMode = "pickup" | "shipping";
export type PaymentRail = "counter" | "telegram_staff" | "shopify" | "moonpay" | "stripe" | "solana_pay";
export type ProofLevel = "order_intent_only" | "payment_backed" | "fulfilled" | "receipt_memory_issued";

export type Money = {
  amountUsd: string;
  currency: "USD";
};

export type CatalogItem = {
  id: string;
  name: string;
  amountUsd: string;
  fulfillment: FulfillmentMode[];
  prepMinutes?: number;
  shippingDays?: number;
  inventory?: number;
  tags?: string[];
};

export type MerchantProfile = {
  id: string;
  name: string;
  category: string;
  location: string;
  fulfillment: FulfillmentMode[];
  paymentRails: PaymentRail[];
  humanApproval: {
    requiredAboveUsd: string;
  };
  catalog: CatalogItem[];
};

export type QuoteRequest = {
  merchantId: string;
  userIntent: string;
  maxSpendUsd?: string;
  deadlineMinutes?: number;
  deliverByDays?: number;
  quantity?: number;
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
};

export type SellerOrder = {
  id: string;
  merchantId: string;
  merchantName: string;
  agentId: string;
  customerLabel: string;
  status: "pending_payment" | "payment_backed" | "fulfilled" | "receipt_issued";
  proofLevel: ProofLevel;
  item: NonNullable<QuoteResult["item"]>;
  payment: {
    mode: "counter" | "checkout" | "crypto";
    status: "required" | "verified";
    provider: PaymentRail | null;
    paymentId: string | null;
  };
  receipt: ReceiptHandoff | null;
  createdAt: string;
  updatedAt: string;
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
  jiagonReceiptId: string;
  receiptHash: string;
  claimUrl: string;
  cnftStatus: "pending" | "ready_for_mint";
};
