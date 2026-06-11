import { merchantForId } from "../merchants/profiles.js";

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17251f;
      --muted: #65726b;
      --line: #dfe6e1;
      --paper: #fbfaf6;
      --panel: #ffffff;
      --green: #0f4a35;
      --red: #a3372d;
      --gold: #c78c2f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--paper);
      color: var(--ink);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 20px 28px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.86);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    main { max-width: 1120px; margin: 0 auto; padding: 28px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 24px; line-height: 1.1; }
    h2 { font-size: 18px; margin-bottom: 12px; }
    p { color: var(--muted); line-height: 1.5; }
    a { color: var(--green); font-weight: 700; text-decoration: none; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .mark {
      width: 38px;
      height: 38px;
      border: 2px solid var(--green);
      border-radius: 8px;
      display: grid;
      place-items: center;
      font-weight: 900;
      color: var(--green);
    }
    .grid { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 20px; align-items: start; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 18px;
      box-shadow: 0 1px 0 rgba(20, 40, 28, 0.04);
    }
    .stack { display: grid; gap: 12px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .muted { color: var(--muted); font-size: 13px; }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 4px 9px;
      border-radius: 999px;
      background: #edf4f0;
      color: var(--green);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .button, button {
      min-height: 38px;
      border: 1px solid var(--green);
      border-radius: 8px;
      background: var(--green);
      color: white;
      padding: 8px 12px;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }
    button.secondary, .button.secondary { background: white; color: var(--green); }
    button.danger { background: var(--red); border-color: var(--red); }
    button:disabled { opacity: 0.5; cursor: wait; }
    input, select {
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: white;
      color: var(--ink);
      padding: 9px 10px;
      font: inherit;
      width: 100%;
    }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 800; color: var(--ink); }
    .order {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 14px;
      background: #fff;
      display: grid;
      gap: 10px;
    }
    .order-title { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
    .money { font-weight: 900; }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 10px;
      padding: 22px;
      text-align: center;
    }
    .notice {
      background: #f7efdf;
      border: 1px solid #ead8b2;
      color: #6a4c14;
      border-radius: 10px;
      padding: 12px;
      font-size: 14px;
      line-height: 1.5;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #f4f6f3;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      margin: 0;
      color: #21342a;
    }
    @media (max-width: 820px) {
      header { align-items: flex-start; flex-direction: column; padding: 18px; }
      main { padding: 18px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export function raposaTerminalPage(origin: string) {
  return page("Raposa SLL-R Terminal", `
<header>
  <div class="brand">
    <div class="mark">R</div>
    <div>
      <h1>Raposa Promise Terminal</h1>
      <p>Accept pickup requests, promise a ready time, and reduce counter interruptions.</p>
    </div>
  </div>
  <div class="row">
    <a class="button secondary" href="/raposa/order">Customer order page</a>
    <button id="refresh">Refresh</button>
  </div>
</header>
<main class="grid">
  <section class="panel stack">
    <div class="row" style="justify-content: space-between;">
      <div>
        <h2>Pickup Promise Board</h2>
        <p>Staff accepts, marks ready, then confirms customer claim after normal counter payment.</p>
      </div>
      <span class="pill" id="count">0 orders</span>
    </div>
    <div id="orders" class="stack">
      <div class="empty"><p>No orders yet. Open the customer order page to create one.</p></div>
    </div>
  </section>
  <aside class="panel stack">
    <h2>Pilot Setup</h2>
    <div class="notice">Raposa keeps counter payment by default. SLL-R manages the pickup promise, payment/claim proof, and receipt memory after staff confirmation.</div>
    <div class="stack">
      <p><strong>Customer QR URL</strong></p>
      <pre>${origin}/raposa/order</pre>
      <p><strong>API queue</strong></p>
      <pre>${origin}/orders?merchantId=raposa-coffee</pre>
      <p><strong>Proof level</strong></p>
      <pre>pickup_promise + ready_signal + customer_claim</pre>
    </div>
  </aside>
</main>
<script>
const merchantId = "raposa-coffee";
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

async function action(orderId, actionName, note) {
  const response = await fetch("/orders/" + encodeURIComponent(orderId) + "/" + actionName, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ merchantId, actor: "raposa-staff", note })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    alert(payload.error || "Action failed");
  }
  await loadOrders();
}

function timeText(value) {
  if (!value) return "not set";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderOrder(order) {
  const canAccept = order.status === "pending_payment";
  const canReject = order.status === "pending_payment" || order.status === "accepted";
  const canReady = order.status === "accepted" || order.status === "payment_backed";
  const canClaim = order.status === "ready";
  const promise = order.promise || {};
  return \`
    <article class="order">
      <div class="order-title">
        <div>
          <h3>\${escapeText(order.item.quantity)}x \${escapeText(order.item.name)}</h3>
          <p>\${escapeText(order.customerLabel)} · \${escapeText(order.id)}</p>
        </div>
        <span class="pill">\${escapeText(order.status)}</span>
      </div>
      <div class="row">
        <span class="money">$\${escapeText(order.item.subtotalUsd)}</span>
        <span class="muted">Payment: \${escapeText(order.payment.mode)} / \${escapeText(order.payment.status)}</span>
        <span class="muted">Proof: \${escapeText(order.proofLevel)}</span>
      </div>
      <div class="row">
        <span class="pill">\${escapeText(promise.status || "not_applicable")}</span>
        <span class="muted">Est. wait: \${escapeText(promise.estimatedWaitMinutes ?? "n/a")} min</span>
        <span class="muted">Promised: \${escapeText(timeText(promise.promisedReadyAt))}</span>
        <span class="muted">Ready: \${escapeText(timeText(promise.readyAt))}</span>
        \${promise.delayMinutes ? \`<span class="muted">Delay: \${escapeText(promise.delayMinutes)} min</span>\` : ""}
      </div>
      \${order.receipt ? \`<pre>Receipt: \${escapeText(order.receipt.receiptHash)}\\nClaim: \${escapeText(order.receipt.claimUrl)}</pre>\` : ""}
      <div class="row">
        <button \${canAccept ? "" : "disabled"} onclick="action('\${order.id}', 'accept', 'Accepted from Raposa terminal.')">Accept</button>
        <button class="danger" \${canReject ? "" : "disabled"} onclick="action('\${order.id}', 'reject', 'Rejected from Raposa terminal.')">Reject</button>
        <button class="secondary" \${canReady ? "" : "disabled"} onclick="action('\${order.id}', 'ready', 'Drink is ready for pickup.')">Ready</button>
        <button class="secondary" \${canClaim ? "" : "disabled"} onclick="action('\${order.id}', 'claim', 'Paid at counter and claimed by customer.')">Paid + Claimed</button>
      </div>
    </article>
  \`;
}

async function loadOrders() {
  refreshButton.disabled = true;
  try {
    const response = await fetch("/orders?merchantId=" + merchantId);
    const payload = await response.json();
    const orders = payload.orders || [];
    countEl.textContent = orders.length + (orders.length === 1 ? " order" : " orders");
    ordersEl.innerHTML = orders.length
      ? orders.map(renderOrder).join("")
      : '<div class="empty"><p>No orders yet. Open the customer order page to create one.</p></div>';
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", loadOrders);
loadOrders();
setInterval(loadOrders, 5000);
</script>`);
}

export function raposaOrderPage() {
  const merchant = merchantForId("raposa-coffee");
  const options = merchant?.catalog.map((item) => `<option value="${item.id}">${item.name} · $${item.amountUsd}</option>`).join("") || "";
  return page("Order from Raposa", `
<header>
  <div class="brand">
    <div class="mark">R</div>
    <div>
      <h1>Order from Raposa</h1>
      <p>Get a pickup promise before you stand in line. Pay at the counter as usual.</p>
    </div>
  </div>
  <a class="button secondary" href="/raposa">Staff terminal</a>
</header>
<main class="grid">
  <section class="panel stack">
    <h2>Create Pickup Promise</h2>
    <form id="orderForm" class="stack">
      <label>
        Item
        <select id="itemId">${options}</select>
      </label>
      <label>
        Your name or pickup label
        <input id="customerLabel" placeholder="Alex / table 4 / buyer agent" value="Raposa guest">
      </label>
      <label>
        I can pick up in this many minutes
        <input id="deadlineMinutes" type="number" min="5" max="60" value="15">
      </label>
      <button type="submit">Ask Raposa for pickup promise</button>
    </form>
    <div id="result" class="stack"></div>
  </section>
  <aside class="panel stack">
    <h2>How this works</h2>
    <p>SLL-R quotes the order, estimates wait from the live queue, and sends a pickup promise to the Raposa terminal.</p>
    <p>Raposa marks the drink ready, you pay at the counter, and the customer claim issues receipt memory.</p>
  </aside>
</main>
<script>
const catalog = ${JSON.stringify(merchant?.catalog || [])};
const form = document.getElementById("orderForm");
const result = document.getElementById("result");

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const item = catalog.find((entry) => entry.id === document.getElementById("itemId").value);
  const deadlineMinutes = Number(document.getElementById("deadlineMinutes").value || 15);
  const customerLabel = document.getElementById("customerLabel").value || "Raposa guest";
  if (!item) return;
  result.innerHTML = '<p>Sending order...</p>';
  const response = await fetch("/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      merchantId: "raposa-coffee",
      agentId: "raposa-qr",
      customerLabel,
      userIntent: "Order " + item.name + " from Raposa Coffee within " + deadlineMinutes + " minutes",
      maxSpendUsd: "25.00",
      deadlineMinutes,
      paymentMode: "counter"
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    result.innerHTML = '<div class="notice">' + escapeText(payload.error || "Order failed") + '</div>';
    return;
  }
  const promise = payload.order.promise || {};
  result.innerHTML = \`
    <div class="order">
      <div class="order-title">
        <div>
          <h3>\${escapeText(payload.order.item.quantity)}x \${escapeText(payload.order.item.name)}</h3>
          <p>Pass: \${escapeText(payload.order.id)}</p>
        </div>
        <span class="pill">\${escapeText(payload.order.status)}</span>
      </div>
      <p>Estimated wait: \${escapeText(promise.estimatedWaitMinutes ?? "n/a")} min. Promised pickup: \${escapeText(promise.promisedReadyAt ? new Date(promise.promisedReadyAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "not set")}.</p>
      <p>Show this at Raposa. Pay at the counter as usual. Staff will mark ready, then claimed after handoff.</p>
      <pre>\${escapeText(JSON.stringify(payload.order, null, 2))}</pre>
    </div>
  \`;
});
</script>`);
}
