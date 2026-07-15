import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { LineClient, LineEventDeduper, parseLineMessages, verifyLineSignature } from "./line.js";
import { paymentBlock } from "./paymentBlock.js";

const secret = "line-test-secret";
const raw = JSON.stringify({
  destination: "Ubot",
  events: [{
    type: "message",
    mode: "active",
    webhookEventId: "01LINEEVENT",
    source: { type: "user", userId: "Ubuyer" },
    message: { type: "text", text: "  幫我點一杯拿鐵  " },
  }],
});
const signature = createHmac("sha256", secret).update(raw, "utf8").digest("base64");

assert.equal(verifyLineSignature(raw, signature, secret), true);
assert.equal(verifyLineSignature(`${raw} `, signature, secret), false);
assert.equal(verifyLineSignature(raw, undefined, secret), false);
assert.deepEqual(parseLineMessages(JSON.parse(raw)), [{
  userId: "Ubuyer",
  text: "幫我點一杯拿鐵",
  webhookEventId: "01LINEEVENT",
}]);
assert.deepEqual(parseLineMessages({ events: [] }), []);
assert.deepEqual(parseLineMessages({
  events: [{
    type: "message",
    mode: "standby",
    webhookEventId: "ignored",
    source: { type: "user", userId: "Ubuyer" },
    message: { type: "text", text: "ignore" },
  }],
}), []);
assert.deepEqual(parseLineMessages({
  events: [{
    type: "message",
    mode: "active",
    webhookEventId: "group",
    source: { type: "group", groupId: "G1", userId: "Ubuyer" },
    message: { type: "text", text: "ignore group in v0" },
  }],
}), []);

const deduper = new LineEventDeduper(2);
assert.equal(deduper.accept("event-1"), true);
assert.equal(deduper.accept("event-1"), false);
assert.equal(deduper.accept("event-2"), true);
assert.equal(deduper.accept("event-3"), true);
assert.equal(deduper.accept("event-2"), false);
assert.equal(deduper.accept("event-1"), true);

let receivedAuthorization = "";
let receivedBody = "";
let responseStatus = 200;
const api = createServer((request, response) => {
  receivedAuthorization = String(request.headers.authorization || "");
  request.on("data", (chunk) => { receivedBody += chunk; });
  request.on("end", () => {
    response.writeHead(responseStatus, { "content-type": "application/json" });
    response.end(responseStatus === 200 ? "{}" : '{"message":"rejected"}');
  });
});
api.listen(0, "127.0.0.1");
await once(api, "listening");
const address = api.address();
if (!address || typeof address === "string") throw new Error("LINE fake server failed to listen.");

try {
  const client = new LineClient({
    channelAccessToken: "test-access-token",
    channelSecret: secret,
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
    port: 8788,
  });
  await client.pushText("Ubuyer", "Order confirmed");
  assert.equal(receivedAuthorization, "Bearer test-access-token");
  assert.deepEqual(JSON.parse(receivedBody), {
    to: "Ubuyer",
    messages: [{ type: "text", text: "Order confirmed" }],
  });
  responseStatus = 401;
  await assert.rejects(client.pushText("Ubuyer", "retry"), /LINE push failed \(401\)/);
} finally {
  api.close();
  await once(api, "close");
}

const options = {
  paymentOptions: [
    { rail: "counter", type: "pay_at_counter", pickupCode: "ABC123" },
    { rail: "stripe", type: "checkout_url", url: "https://stripe.test/pay" },
    { rail: "line_pay", type: "payment_url", url: "https://line.test/pay" },
  ],
};
assert.match(paymentBlock(options), /stripe\.test/);
assert.doesNotMatch(paymentBlock(options), /line\.test/);
assert.match(paymentBlock(options, ["line_pay", "stripe"]), /LINE Pay/);
assert.match(paymentBlock(options, ["line_pay", "stripe"]), /line\.test/);
assert.match(paymentBlock(options, ["line_pay", "stripe"]), /ABC123/);

process.stdout.write("LINE smoke passed\n");
