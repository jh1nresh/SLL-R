import { once } from "node:events";
import { createSllrServer } from "../server.js";

async function postJson(origin: string, path: string, payload: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  const json = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getJsonFailure(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  const json = await response.json() as Record<string, unknown>;
  if (response.ok) {
    throw new Error(`${path} unexpectedly succeeded: ${JSON.stringify(json)}`);
  }
  return { status: response.status, json };
}

async function main() {
  const server = createSllrServer();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start smoke server.");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const manifest = await fetch(`${origin}/.well-known/sllr-agent.json`).then((response) => response.json()) as {
      name?: string;
      agentShack?: { type?: string; evaluator?: { policy?: string } };
    };
    if (manifest.name !== "SLL-R by Jiagon") throw new Error("Manifest did not identify SLL-R.");
    if (manifest.agentShack?.type !== "merchant_agent" || manifest.agentShack.evaluator?.policy !== "order-fulfillment-v0") {
      throw new Error(`Manifest did not expose AgentShack merchant listing schema: ${JSON.stringify(manifest)}`);
    }

    const raposaKit = await fetch(`${origin}/pilot-kit?merchantId=raposa-coffee`).then((response) => response.json()) as {
      merchant?: { id?: string };
      apiExamples?: { quote?: { body?: { merchantId?: string } } };
    };
    if (raposaKit.merchant?.id !== "raposa-coffee" || raposaKit.apiExamples?.quote?.body?.merchantId !== "raposa-coffee") {
      throw new Error(`Raposa pilot kit was not generated: ${JSON.stringify(raposaKit)}`);
    }

    const solydKit = await fetch(`${origin}/pilot-kit?merchantId=solyd`).then((response) => response.json()) as {
      merchant?: { id?: string };
      pilot?: { buyerPrompt?: string };
    };
    if (solydKit.merchant?.id !== "solyd" || !solydKit.pilot?.buyerPrompt?.includes("SOLYD")) {
      throw new Error(`SOLYD pilot kit was not generated: ${JSON.stringify(solydKit)}`);
    }

    const baseMerchants = await getJson(origin, "/base-plugin/coffee/merchants") as {
      merchants?: Array<{ id?: string; paymentRails?: string[] }>;
    };
    const nounMerchant = baseMerchants.merchants?.find((merchant) => merchant.id === "noun-coffee");
    if (!nounMerchant?.paymentRails?.includes("base_usdc")) {
      throw new Error(`Noun Coffee was not exposed through the Base coffee plugin: ${JSON.stringify(baseMerchants)}`);
    }

    const nounIntent = encodeURIComponent("Ship me Dalat Highlands coffee beans under $40");
    const nounQuote = await getJson(origin, `/base-plugin/coffee/quote?merchantId=noun-coffee&intent=${nounIntent}&maxSpendUsd=40.00&deliverByDays=7`) as {
      quote?: { feasible?: boolean; item?: { id?: string; subtotalUsd?: string } };
      checkoutHandoff?: { url?: string };
    };
    if (!nounQuote.quote?.feasible || nounQuote.quote.item?.id !== "dalat-highlands" || !nounQuote.checkoutHandoff?.url?.includes("noun.coffee")) {
      throw new Error(`Unexpected Noun Coffee Base quote: ${JSON.stringify(nounQuote)}`);
    }

    const nounOrder = await getJson(origin, `/base-plugin/coffee/order?merchantId=noun-coffee&intent=${nounIntent}&maxSpendUsd=40.00&deliverByDays=7&agentId=base-smoke`) as {
      order?: { id?: string; item?: { subtotalUsd?: string } };
      checkoutHandoff?: { url?: string };
    };
    if (!nounOrder.order?.id || nounOrder.order.item?.subtotalUsd !== "32.00" || !nounOrder.checkoutHandoff?.url) {
      throw new Error(`Noun Coffee Base order was not created: ${JSON.stringify(nounOrder)}`);
    }

    const nounPaymentHandoff = await getJson(origin, `/base-plugin/coffee/prepare-payment?orderId=${nounOrder.order.id}`) as {
      mode?: string;
      checkoutHandoff?: { url?: string };
    };
    if (nounPaymentHandoff.mode !== "checkout_handoff" || !nounPaymentHandoff.checkoutHandoff?.url) {
      throw new Error(`Noun Coffee payment should default to checkout handoff: ${JSON.stringify(nounPaymentHandoff)}`);
    }

    const nonBaseQuoteFailure = await getJsonFailure(origin, "/base-plugin/coffee/quote?merchantId=raposa-shop&intent=coffee");
    if (nonBaseQuoteFailure.status !== 404) {
      throw new Error(`Non-Base merchant quote should be rejected: ${JSON.stringify(nonBaseQuoteFailure)}`);
    }

    const previousBaseRecipient = process.env.SLLR_BASE_COFFEE_RECIPIENT;
    process.env.SLLR_BASE_COFFEE_RECIPIENT = "0x000000000000000000000000000000000000dEaD";
    const nounDemoPayment = await getJson(origin, `/base-plugin/coffee/prepare-payment?orderId=${nounOrder.order.id}&from=0x000000000000000000000000000000000000bEEF`) as {
      mode?: string;
      chainId?: number;
      transactions?: Array<{ chainId?: number; to?: string; data?: string }>;
    };
    if (
      nounDemoPayment.mode !== "base_mcp_demo"
      || nounDemoPayment.chainId !== 8453
      || nounDemoPayment.transactions?.[0]?.chainId !== 8453
      || nounDemoPayment.transactions?.[0]?.to !== "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
      || !nounDemoPayment.transactions[0].data?.startsWith("0xa9059cbb")
    ) {
      throw new Error(`Noun Coffee Base demo payment was not prepared: ${JSON.stringify(nounDemoPayment)}`);
    }
    if (previousBaseRecipient === undefined) {
      delete process.env.SLLR_BASE_COFFEE_RECIPIENT;
    } else {
      process.env.SLLR_BASE_COFFEE_RECIPIENT = previousBaseRecipient;
    }

    const raposaTerminal = await fetch(`${origin}/raposa`).then((response) => response.text());
    if (!raposaTerminal.includes("Raposa Promise Terminal") || !raposaTerminal.includes("/raposa/order")) {
      throw new Error("Raposa terminal page did not render expected staff controls.");
    }

    const raposaOrderPage = await fetch(`${origin}/raposa/order`).then((response) => response.text());
    if (!raposaOrderPage.includes("Order from Raposa") || !raposaOrderPage.includes("Ask Raposa for pickup promise")) {
      throw new Error("Raposa customer order page did not render expected order form.");
    }

    const quote = await postJson(origin, "/quote", {
      merchantId: "raposa-shop",
      userIntent: "Ship me Raposa Nitro Cold Brew Caramel Latte under $20 this week",
      maxSpendUsd: "20.00",
      deliverByDays: 7,
    }) as { quote?: { feasible?: boolean; item?: { id?: string; subtotalUsd?: string } } };
    if (!quote.quote?.feasible || quote.quote.item?.id !== "nitro-caramel-latte") {
      throw new Error(`Unexpected Raposa Shop quote: ${JSON.stringify(quote)}`);
    }

    const pickupQuote = await postJson(origin, "/quote", {
      merchantId: "raposa-coffee",
      userIntent: "Get me an iced latte under $10 in 15 minutes",
      maxSpendUsd: "10.00",
      deadlineMinutes: 15,
    }) as { quote?: { feasible?: boolean; item?: { id?: string } } };
    if (!pickupQuote.quote?.feasible || pickupQuote.quote.item?.id !== "iced-latte") {
      throw new Error(`Unexpected Raposa Coffee quote: ${JSON.stringify(pickupQuote)}`);
    }

    const pickupOrder = await postJson(origin, "/orders", {
      merchantId: "raposa-coffee",
      agentId: "buy-r-smoke",
      userIntent: "Get me an iced latte under $10 in 15 minutes",
      maxSpendUsd: "10.00",
      deadlineMinutes: 15,
      paymentMode: "counter",
    }) as { order?: { id?: string; promise?: { status?: string; estimatedWaitMinutes?: number; promisedReadyAt?: string } } };
    if (!pickupOrder.order?.id) throw new Error(`Pickup order was not created: ${JSON.stringify(pickupOrder)}`);
    if (pickupOrder.order.promise?.status !== "on_time" || !pickupOrder.order.promise.promisedReadyAt) {
      throw new Error(`Pickup order did not include a pickup promise: ${JSON.stringify(pickupOrder)}`);
    }

    const terminalList = await fetch(`${origin}/orders?merchantId=raposa-coffee`).then((response) => response.json()) as { orders?: Array<{ id?: string }> };
    if (!terminalList.orders?.some((order) => order.id === pickupOrder.order?.id)) {
      throw new Error(`Merchant terminal did not list pickup order: ${JSON.stringify(terminalList)}`);
    }

    const accepted = await postJson(origin, `/orders/${pickupOrder.order.id}/accept`, {
      merchantId: "raposa-coffee",
      actor: "raposa-staff",
      note: "Can make it before pickup window.",
    }) as { status?: string; order?: { terminal?: { status?: string } } };
    if (accepted.status !== "accepted" || accepted.order?.terminal?.status !== "accepted") {
      throw new Error(`Merchant accept failed: ${JSON.stringify(accepted)}`);
    }

    const ready = await postJson(origin, `/orders/${pickupOrder.order.id}/ready`, {
      merchantId: "raposa-coffee",
      actor: "raposa-staff",
      note: "Drink is ready.",
    }) as { status?: string; order?: { promise?: { readyAt?: string } } };
    if (ready.status !== "ready" || !ready.order?.promise?.readyAt) {
      throw new Error(`Merchant ready signal failed: ${JSON.stringify(ready)}`);
    }

    const claimed = await postJson(origin, `/orders/${pickupOrder.order.id}/claim`, {
      merchantId: "raposa-coffee",
      actor: "raposa-staff",
      note: "Paid at counter and claimed.",
    }) as { proofLevel?: string; order?: { receipt?: { receiptHash?: string }; promise?: { claimedAt?: string } } };
    if (claimed.proofLevel !== "receipt_memory_issued" || !claimed.order?.receipt?.receiptHash || !claimed.order.promise?.claimedAt) {
      throw new Error(`Customer claim did not issue receipt handoff: ${JSON.stringify(claimed)}`);
    }

    const orderResult = await postJson(origin, "/orders", {
      merchantId: "raposa-shop",
      agentId: "buy-r-smoke",
      userIntent: "Ship me Raposa Nitro Cold Brew Caramel Latte under $20 this week",
      maxSpendUsd: "20.00",
      deliverByDays: 7,
      paymentMode: "checkout",
    }) as { order?: { id?: string; item?: { subtotalUsd?: string } } };
    if (!orderResult.order?.id) throw new Error(`Order was not created: ${JSON.stringify(orderResult)}`);

    const nonBaseStatusFailure = await getJsonFailure(origin, `/base-plugin/coffee/status?orderId=${orderResult.order.id}`);
    if (nonBaseStatusFailure.status !== 404) {
      throw new Error(`Non-Base order status should be rejected: ${JSON.stringify(nonBaseStatusFailure)}`);
    }

    const paid = await postJson(origin, "/webhooks/payment", {
      orderId: orderResult.order.id,
      merchantId: "raposa-shop",
      provider: "moonpay",
      amountUsd: orderResult.order.item?.subtotalUsd,
      paymentId: "pay_smoke",
    }) as { proofLevel?: string; order?: { receipt?: { receiptHash?: string; cnftStatus?: string } } };
    if (paid.proofLevel !== "receipt_memory_issued" || !paid.order?.receipt?.receiptHash) {
      throw new Error(`Payment proof did not issue receipt handoff: ${JSON.stringify(paid)}`);
    }

    console.log("SLL-R smoke passed");
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
