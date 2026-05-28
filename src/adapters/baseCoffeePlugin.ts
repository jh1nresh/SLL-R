import { attachPaymentProof, createOrder, getOrder } from "../core/orders.js";
import { centsFromUsd } from "../core/money.js";
import { quoteOrder } from "../core/quote.js";
import { merchantForId, merchantProfiles } from "../merchants/profiles.js";
import type { CatalogItem, OrderRequest, QuoteRequest, SellerOrder } from "../types.js";

const BASE_CHAIN_ID = 8453;
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_SELECTOR = "a9059cbb";

function requestFromSearch(searchParams: URLSearchParams): QuoteRequest {
  const merchantId = searchParams.get("merchantId") || "noun-coffee";
  requireBaseCoffeeMerchant(merchantId);
  const input: QuoteRequest = {
    merchantId,
    userIntent: searchParams.get("intent") || searchParams.get("userIntent") || "",
  };
  const maxSpendUsd = searchParams.get("maxSpendUsd");
  const deliverByDays = searchParams.get("deliverByDays");
  const deadlineMinutes = searchParams.get("deadlineMinutes");
  const quantity = searchParams.get("quantity");
  if (maxSpendUsd) input.maxSpendUsd = maxSpendUsd;
  if (deliverByDays) input.deliverByDays = Number(deliverByDays);
  if (deadlineMinutes) input.deadlineMinutes = Number(deadlineMinutes);
  if (quantity) input.quantity = Number(quantity);
  return input;
}

function requireBaseCoffeeMerchant(merchantId: string) {
  const merchant = merchantForId(merchantId);
  if (!merchant || !merchant.paymentRails.includes("base_usdc")) {
    throw Object.assign(new Error(`Unknown Base coffee merchant: ${merchantId}`), { status: 404 });
  }
  return merchant;
}

function requireBaseCoffeeOrder(orderId: string) {
  const order = getOrder(orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
  requireBaseCoffeeMerchant(order.merchantId);
  return order;
}

function checkoutFor(order: Pick<SellerOrder, "merchantId" | "item">) {
  const merchant = merchantForId(order.merchantId);
  const item = merchant?.catalog.find((candidate) => candidate.id === order.item.id);
  return item ? checkoutHandoff(item) : null;
}

function checkoutHandoff(item: CatalogItem) {
  if (!item.productUrl) return null;
  return {
    type: "storefront_checkout",
    url: item.productUrl,
    instruction: "Open the merchant checkout and choose Crypto: USDC when available.",
  };
}

function basePaymentRecipient() {
  const value = process.env.SLLR_BASE_COFFEE_RECIPIENT?.trim();
  if (!value) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw Object.assign(new Error("SLLR_BASE_COFFEE_RECIPIENT must be an EVM address."), { status: 500 });
  }
  return value;
}

function pad32(hex: string) {
  return hex.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function usdcAtoms(amountUsd: string) {
  return BigInt(centsFromUsd(amountUsd)) * 10_000n;
}

function erc20TransferCalldata(recipient: string, amountUsd: string) {
  return `0x${TRANSFER_SELECTOR}${pad32(recipient)}${pad32(usdcAtoms(amountUsd).toString(16))}`;
}

export function baseCoffeeMerchants(origin: string) {
  return {
    product: "SLL-R Base coffee plugin",
    plugin: {
      manifestUrl: `${origin}/.well-known/sllr-agent.json`,
      docsUrl: "https://github.com/JhiNResH/SLL-R/blob/main/docs/plugins/sllr-base-coffee.md",
    },
    merchants: Object.values(merchantProfiles)
      .filter((merchant) => merchant.paymentRails.includes("base_usdc"))
      .map((merchant) => ({
        id: merchant.id,
        name: merchant.name,
        category: merchant.category,
        location: merchant.location,
        fulfillment: merchant.fulfillment,
        paymentRails: merchant.paymentRails,
        catalog: merchant.catalog.map((item) => ({
          id: item.id,
          name: item.name,
          amountUsd: item.amountUsd,
          tags: item.tags || [],
          productUrl: item.productUrl || null,
        })),
      })),
  };
}

export function baseCoffeeQuote(searchParams: URLSearchParams) {
  const quote = quoteOrder(requestFromSearch(searchParams));
  return {
    product: "SLL-R Base coffee quote",
    quote,
    checkoutHandoff: quote.item ? checkoutFor({ merchantId: quote.merchant.id, item: quote.item }) : null,
  };
}

export function baseCoffeeOrder(searchParams: URLSearchParams) {
  const request = requestFromSearch(searchParams) as OrderRequest;
  request.agentId = searchParams.get("agentId") || "base-mcp-buyer-agent";
  request.customerLabel = searchParams.get("customerLabel") || "Base MCP buyer";
  request.paymentMode = "checkout";
  const result = createOrder(request);
  return {
    product: "SLL-R Base coffee order",
    status: result.order.status,
    quote: result.quote,
    order: result.order,
    checkoutHandoff: checkoutFor(result.order),
    next: "Call prepare-payment. If no demo recipient is configured, use checkoutHandoff and attach payment proof after checkout.",
  };
}

export function baseCoffeePayment(orderId: string, payer?: string | null) {
  const order = requireBaseCoffeeOrder(orderId);
  if (!order.payment.mode || order.payment.mode === "counter") {
    throw Object.assign(new Error("Base coffee payment can only prepare checkout or crypto orders."), { status: 409 });
  }

  const recipient = basePaymentRecipient();
  if (!recipient) {
    return {
      product: "SLL-R Base coffee payment",
      mode: "checkout_handoff",
      orderId: order.id,
      amountUsd: order.item.subtotalUsd,
      checkoutHandoff: checkoutFor(order),
      paymentProofStatus: "external_checkout_required",
      reason: "SLLR_BASE_COFFEE_RECIPIENT is not configured, so SLL-R will not return a demo Base USDC transaction.",
    };
  }

  return {
    product: "SLL-R Base coffee payment",
    mode: "base_mcp_demo",
    orderId: order.id,
    amountUsd: order.item.subtotalUsd,
    paymentProofStatus: "pending_webhook_or_manual_proof",
    payer: payer || null,
    chain: "base",
    chainId: BASE_CHAIN_ID,
    token: {
      symbol: "USDC",
      address: BASE_USDC_ADDRESS,
      decimals: 6,
    },
    transactions: [
      {
        chainId: BASE_CHAIN_ID,
        to: BASE_USDC_ADDRESS,
        value: "0x0",
        data: erc20TransferCalldata(recipient, order.item.subtotalUsd),
        description: `Pay ${order.item.subtotalUsd} USDC to configured SLL-R coffee demo recipient.`,
      },
    ],
    disclaimer: "Demo transfer recipient is configured by SLLR_BASE_COFFEE_RECIPIENT and is not claimed to be Noun Coffee's wallet.",
  };
}

export function baseCoffeeStatus(orderId: string) {
  return requireBaseCoffeeOrder(orderId);
}

export async function baseCoffeeRecordDemoPayment(orderId: string, paymentId?: string | null, amountUsd?: string | null) {
  const order = requireBaseCoffeeOrder(orderId);
  return attachPaymentProof({
    orderId: order.id,
    merchantId: order.merchantId,
    provider: "base_usdc",
    amountUsd: amountUsd || order.item.subtotalUsd,
    paymentId: paymentId || `base_demo_${order.id}`,
  });
}
