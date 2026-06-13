import { allMerchantProfiles, merchantForId } from "../merchants/profiles.js";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char] || char);
}

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17251f;
      --muted: #66736b;
      --line: #dde5df;
      --paper: #fbfaf6;
      --panel: #ffffff;
      --green: #0f4a35;
      --red: #a33b32;
      --amber: #f7efdf;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--paper);
      color: var(--ink);
    }
    header {
      padding: 22px 28px;
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,0.92);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 26px; line-height: 1.1; }
    h2 { font-size: 18px; }
    p { color: var(--muted); line-height: 1.5; }
    a { color: var(--green); font-weight: 800; text-decoration: none; }
    textarea, input, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 11px;
      font: inherit;
      background: white;
      color: var(--ink);
    }
    textarea { min-height: 104px; resize: vertical; }
    button, .button {
      min-height: 40px;
      border: 1px solid var(--green);
      border-radius: 8px;
      background: var(--green);
      color: white;
      padding: 9px 13px;
      font: inherit;
      font-weight: 850;
      cursor: pointer;
    }
    button.secondary, .button.secondary { background: white; color: var(--green); }
    button.danger { background: var(--red); border-color: var(--red); }
    button:disabled { opacity: 0.52; cursor: wait; }
    .topline { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .mark {
      width: 40px;
      height: 40px;
      border: 2px solid var(--green);
      border-radius: 9px;
      display: grid;
      place-items: center;
      color: var(--green);
      font-weight: 950;
    }
    .grid { display: grid; grid-template-columns: 1.08fr 0.92fr; gap: 20px; align-items: start; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 18px;
      box-shadow: 0 1px 0 rgba(20,40,28,0.04);
    }
    .stack { display: grid; gap: 12px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 27px;
      padding: 4px 9px;
      border-radius: 999px;
      background: #edf4f0;
      color: var(--green);
      font-size: 12px;
      font-weight: 850;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .muted { color: var(--muted); font-size: 13px; }
    .notice {
      background: var(--amber);
      border: 1px solid #ead8b2;
      color: #654912;
      border-radius: 10px;
      padding: 12px;
      font-size: 14px;
      line-height: 1.5;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 14px;
      background: white;
      display: grid;
      gap: 10px;
    }
    .card-title { display: flex; justify-content: space-between; align-items: start; gap: 12px; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #f4f6f3;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      margin: 0;
      color: #21342a;
      max-height: 260px;
      overflow: auto;
    }
    @media (max-width: 840px) {
      header { padding: 18px; }
      main { padding: 18px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function merchantOptions(selectedId: string) {
  return allMerchantProfiles().map((merchant) => (
    `<option value="${escapeHtml(merchant.id)}"${merchant.id === selectedId ? " selected" : ""}>${escapeHtml(merchant.name)}</option>`
  )).join("");
}

function sampleIntent(merchantId: string) {
  if (merchantId === "noun-coffee") return "I want coffee beans under $40.";
  if (merchantId === "raposa-coffee") return "I need an iced latte within 10 minutes.";
  if (merchantId === "raposa-shop") return "Ship me coffee beans under $20 this week.";
  return "Help me buy something under $100.";
}

export function standaloneAgentPage(merchantId: string, origin: string) {
  const merchant = merchantForId(merchantId);
  if (!merchant) return null;
  return page(`${merchant.name} SLL-R Agent`, `
<header>
  <div class="topline">
    <div class="brand">
      <div class="mark">S</div>
      <div>
        <h1>${escapeHtml(merchant.name)} AI Ordering Agent</h1>
        <p>SLL-R turns merchant catalog, pickup promise, checkout, and receipt memory into one ordering workflow.</p>
      </div>
    </div>
    <div class="row">
      <a class="button secondary" href="/terminal/${escapeHtml(merchant.id)}">Merchant terminal</a>
      <a class="button secondary" href="/merchants/${escapeHtml(merchant.id)}/menu">Menu API</a>
    </div>
  </div>
</header>
<main class="grid">
  <section class="panel stack">
    <div class="row">
      <span class="pill">Customer channel</span>
      <span class="pill">${escapeHtml(merchant.fulfillment.join(" + "))}</span>
    </div>
    <h2>Tell the store agent what you want</h2>
    <p>Use natural language. SLL-R will quote a real catalog item, create an order only after confirmation, then hand off checkout or staff fulfillment.</p>
    <label>
      Merchant
      <select id="merchantSelect">${merchantOptions(merchant.id)}</select>
    </label>
    <label>
      Intent
      <textarea id="message">${escapeHtml(sampleIntent(merchant.id))}</textarea>
    </label>
    <div class="row">
      <button id="quoteButton">Quote</button>
      <button id="orderButton" class="secondary">Confirm order</button>
    </div>
    <div id="answer" class="notice">Quote first. No order is created until confirmation.</div>
    <pre id="payload">{}</pre>
  </section>
  <aside class="panel stack">
    <h2>Why this is agentic POS</h2>
    <div class="card">
      <div class="card-title"><strong>Order channel</strong><span class="pill">AI</span></div>
      <p>Customers or buyer agents state budget, taste, and timing instead of browsing every menu.</p>
    </div>
    <div class="card">
      <div class="card-title"><strong>Pickup promise</strong><span class="pill">Queue</span></div>
      <p>SLL-R estimates ready time from item prep and active queue state, then exposes the promise to staff.</p>
    </div>
    <div class="card">
      <div class="card-title"><strong>Receipt memory</strong><span class="pill">Proof</span></div>
      <p>Payment or fulfillment proof upgrades a completed order into receipt memory for loyalty and recommendations.</p>
    </div>
    <pre>${escapeHtml(`${origin}/agent/${merchant.id}
${origin}/terminal/${merchant.id}
${origin}/agent/${merchant.id}/message`)}</pre>
  </aside>
</main>
<script>
const select = document.getElementById("merchantSelect");
const message = document.getElementById("message");
const answer = document.getElementById("answer");
const payload = document.getElementById("payload");
const quoteButton = document.getElementById("quoteButton");
const orderButton = document.getElementById("orderButton");

select.addEventListener("change", () => {
  window.location.href = "/agent/" + encodeURIComponent(select.value);
});

async function run(confirm) {
  quoteButton.disabled = true;
  orderButton.disabled = true;
  answer.textContent = confirm ? "Creating order..." : "Quoting...";
  try {
    const response = await fetch("/agent/${merchant.id}/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: message.value,
        confirm,
        customerLabel: "walk-in customer"
      })
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "SLL-R request failed");
    answer.textContent = json.reply || "Done.";
    payload.textContent = JSON.stringify(json, null, 2);
  } catch (error) {
    answer.textContent = error instanceof Error ? error.message : "SLL-R request failed";
  } finally {
    quoteButton.disabled = false;
    orderButton.disabled = false;
  }
}

quoteButton.addEventListener("click", () => run(false));
orderButton.addEventListener("click", () => run(true));
</script>`);
}

export function merchantTerminalPage(merchantId: string, origin: string) {
  const merchant = merchantForId(merchantId);
  if (!merchant) return null;
  return page(`${merchant.name} SLL-R Terminal`, `
<header>
  <div class="topline">
    <div class="brand">
      <div class="mark">S</div>
      <div>
        <h1>${escapeHtml(merchant.name)} Merchant Terminal</h1>
        <p>Accept orders, update ready/claimed state, and issue receipt memory after fulfillment.</p>
      </div>
    </div>
    <div class="row">
      <a class="button secondary" href="/agent/${escapeHtml(merchant.id)}">Customer agent</a>
      <button id="refresh">Refresh</button>
    </div>
  </div>
</header>
<main class="grid">
  <section class="panel stack">
    <div class="row" style="justify-content: space-between;">
      <div>
        <h2>Live order queue</h2>
        <p>First SLL-R terminal for agent-created orders. Payment can stay in existing checkout or at the counter.</p>
      </div>
      <span class="pill" id="count">0 orders</span>
    </div>
    <div id="orders" class="stack"><div class="notice">No orders yet. Open the customer agent page to create one.</div></div>
  </section>
  <aside class="panel stack">
    <h2>Merchant setup</h2>
    <div class="card">
      <strong>Payment rails</strong>
      <p>${escapeHtml(merchant.paymentRails.join(", "))}</p>
    </div>
    <div class="card">
      <strong>Customer QR</strong>
      <pre>${escapeHtml(`${origin}/agent/${merchant.id}`)}</pre>
    </div>
    <div class="card">
      <strong>Terminal API</strong>
      <pre>${escapeHtml(`${origin}/orders?merchantId=${merchant.id}`)}</pre>
    </div>
  </aside>
</main>
<script>
const merchantId = ${JSON.stringify(merchant.id)};
const ordersEl = document.getElementById("orders");
const countEl = document.getElementById("count");
const refreshButton = document.getElementById("refresh");

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function timeText(value) {
  if (!value) return "not set";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function action(orderId, actionName, note) {
  const staffSecret = window.localStorage.getItem("sllrStaffSecret");
  const response = await fetch("/orders/" + encodeURIComponent(orderId) + "/" + actionName, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(staffSecret ? { "x-sllr-merchant-payment-secret": staffSecret } : {})
    },
    body: JSON.stringify({ merchantId, actor: "sllr-terminal", note, demo: !staffSecret })
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    alert(json.error || "Action failed");
  }
  await loadOrders();
}

function renderOrder(order) {
  const canAccept = order.status === "pending_payment";
  const canReject = order.status === "pending_payment" || order.status === "accepted";
  const canReady = order.status === "accepted" || order.status === "payment_backed";
  const canClaim = order.status === "ready";
  const canFulfill = order.status === "accepted" || order.status === "payment_backed" || order.status === "pending_payment";
  const promise = order.promise || {};
  return \`
    <article class="card">
      <div class="card-title">
        <div>
          <h3>\${escapeText(order.item.quantity)}x \${escapeText(order.item.name)}</h3>
          <p>\${escapeText(order.customerLabel)} · \${escapeText(order.id)}</p>
        </div>
        <span class="pill">\${escapeText(order.status)}</span>
      </div>
      <div class="row">
        <strong>$\${escapeText(order.item.subtotalUsd)}</strong>
        <span class="muted">Payment: \${escapeText(order.payment.mode)} / \${escapeText(order.payment.status)}</span>
        <span class="muted">Proof: \${escapeText(order.proofLevel)}</span>
      </div>
      <div class="row">
        <span class="pill">\${escapeText(promise.status || "not_applicable")}</span>
        <span class="muted">Wait: \${escapeText(promise.estimatedWaitMinutes ?? "n/a")} min</span>
        <span class="muted">Promised: \${escapeText(timeText(promise.promisedReadyAt))}</span>
        <span class="muted">Ready: \${escapeText(timeText(promise.readyAt))}</span>
      </div>
      \${order.receipt ? \`<pre>Receipt: \${escapeText(order.receipt.receiptHash)}\\nClaim: \${escapeText(order.receipt.claimUrl)}</pre>\` : ""}
      <div class="row">
        <button \${canAccept ? "" : "disabled"} onclick="action('\${order.id}', 'accept', 'Accepted in SLL-R terminal.')">Accept</button>
        <button class="danger" \${canReject ? "" : "disabled"} onclick="action('\${order.id}', 'reject', 'Rejected in SLL-R terminal.')">Reject</button>
        <button class="secondary" \${canReady ? "" : "disabled"} onclick="action('\${order.id}', 'ready', 'Ready for pickup.')">Ready</button>
        <button class="secondary" \${canClaim ? "" : "disabled"} onclick="action('\${order.id}', 'claim', 'Customer claimed the order.')">Claimed</button>
        <button class="secondary" \${canFulfill ? "" : "disabled"} onclick="action('\${order.id}', 'fulfill', 'Fulfilled through existing checkout or staff flow.')">Fulfill</button>
      </div>
    </article>
  \`;
}

async function loadOrders() {
  const response = await fetch("/orders?merchantId=" + encodeURIComponent(merchantId));
  const json = await response.json();
  const orders = json.orders || [];
  countEl.textContent = orders.length + (orders.length === 1 ? " order" : " orders");
  ordersEl.innerHTML = orders.length ? orders.map(renderOrder).join("") : '<div class="notice">No orders yet. Open the customer agent page to create one.</div>';
}

refreshButton.addEventListener("click", loadOrders);
loadOrders();
setInterval(loadOrders, 5000);
</script>`);
}
