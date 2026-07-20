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
    <button id="staffKeyBtn" class="secondary" title="Set the staff key used to confirm orders">🔑 <span id="keyStatus">key not set</span></button>
    <button id="notifyStaff" class="secondary">Enable notifications</button>
    <span class="pill" id="liveConnection">connecting</span>
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
      <pre>${origin}/merchants/raposa-coffee/orders</pre>
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
const staffKeyButton = document.getElementById("staffKeyBtn");
const keyStatusEl = document.getElementById("keyStatus");
const notifyStaffButton = document.getElementById("notifyStaff");
const liveConnectionEl = document.getElementById("liveConnection");
let knownOrderIds = null;

// Staff key bootstrap: a one-time ?staffKey=... link saves the key to this
// browser and is then stripped from the URL so it is not left in history.
// Staff can also set/update it via the 🔑 button. The key is never embedded in
// the page source, so opening /raposa without it grants no merchant actions.
(function initStaffKey() {
  const fromUrl = new URLSearchParams(location.search).get("staffKey");
  if (fromUrl) {
    window.localStorage.setItem("sllrStaffSecret", fromUrl);
    history.replaceState(null, "", location.pathname);
  }
})();

function refreshKeyStatus() {
  const set = !!window.localStorage.getItem("sllrStaffSecret");
  if (keyStatusEl) keyStatusEl.textContent = set ? "key set" : "key not set";
}

function promptStaffKey() {
  const current = window.localStorage.getItem("sllrStaffSecret") || "";
  const next = window.prompt("Paste the Raposa staff key (leave blank to clear):", current);
  if (next === null) return;
  if (next.trim()) window.localStorage.setItem("sllrStaffSecret", next.trim());
  else window.localStorage.removeItem("sllrStaffSecret");
  refreshKeyStatus();
}

if (staffKeyButton) staffKeyButton.addEventListener("click", promptStaffKey);
refreshKeyStatus();

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
  const staffSecret = window.localStorage.getItem("sllrStaffSecret");
  const response = await fetch("/orders/" + encodeURIComponent(orderId) + "/" + actionName, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(staffSecret ? { "x-sllr-merchant-payment-secret": staffSecret } : {})
    },
    body: JSON.stringify({ merchantId, actor: "raposa-staff", note, demo: !staffSecret })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      alert("Staff key required or invalid. Set it with the 🔑 button, then retry.");
      promptStaffKey();
    } else {
      alert(payload.error || "Action failed");
    }
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
  const tracking = order.tracking || {};
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
        \${tracking.queuePosition ? \`<span class="muted">Queue #\${escapeText(tracking.queuePosition)} · \${escapeText(tracking.ordersAhead)} ahead</span>\` : ""}
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
    const staffSecret = window.localStorage.getItem("sllrStaffSecret");
    const response = await fetch("/merchants/" + merchantId + "/orders?demo=true", {
      headers: staffSecret ? { "x-sllr-merchant-payment-secret": staffSecret } : {}
    });
    if (!response.ok) {
      liveConnectionEl.textContent = "auth required";
      if (response.status === 401) promptStaffKey();
      return;
    }
    const payload = await response.json();
    const orders = payload.orders || [];
    if (knownOrderIds) {
      orders.filter((order) => !knownOrderIds.has(order.id)).forEach((order) => {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("New SLL-R order", {
            body: order.item.name + " · " + order.id.slice(-6),
            tag: "sllr-merchant-" + order.id
          });
        }
      });
    }
    knownOrderIds = new Set(orders.map((order) => order.id));
    liveConnectionEl.textContent = "live · 2s";
    countEl.textContent = orders.length + (orders.length === 1 ? " order" : " orders");
    ordersEl.innerHTML = orders.length
      ? orders.map(renderOrder).join("")
      : '<div class="empty"><p>No orders yet. Open the customer order page to create one.</p></div>';
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", loadOrders);
notifyStaffButton.addEventListener("click", async () => {
  if (!("Notification" in window)) return;
  const permission = await Notification.requestPermission();
  notifyStaffButton.textContent = permission === "granted" ? "Notifications enabled" : "Notifications unavailable";
});
loadOrders();
setInterval(loadOrders, 2000);
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
      <div class="row">
        <button type="submit">Ask Raposa for pickup promise</button>
        <button id="notifyButton" class="secondary" type="button">Enable status notifications</button>
      </div>
    </form>
    <div id="liveStatus" class="notice">Live tracking starts after an order is confirmed.</div>
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
const liveStatus = document.getElementById("liveStatus");
const notifyButton = document.getElementById("notifyButton");
const buyerTokenKey = "sllrRaposaBuyerToken";
const activeOrderKey = "sllrRaposaActiveOrder";
let activeOrderId = window.sessionStorage.getItem(activeOrderKey);
let lastStatus = null;
let pollTimer = null;

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function authHeaders(token, json = false) {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    "authorization": "Bearer " + token
  };
}

async function issueBuyerSession(label) {
  const response = await fetch("/buyer/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label })
  });
  const payload = await response.json();
  if (!response.ok || !payload.token) throw new Error(payload.error || "Could not create buyer session");
  window.sessionStorage.setItem(buyerTokenKey, payload.token);
  return payload.token;
}

async function buyerToken(label) {
  return window.sessionStorage.getItem(buyerTokenKey) || issueBuyerSession(label);
}

function statusLabel(status) {
  return ({
    pending_payment: "Order sent — waiting for merchant",
    accepted: "Merchant accepted your order",
    payment_backed: "Payment confirmed — merchant is preparing it",
    ready: "Ready for pickup",
    rejected: "Merchant could not accept this order",
    receipt_issued: "Picked up — verified receipt issued"
  })[status] || status;
}

function notifyStatus(order) {
  if (!lastStatus || lastStatus === order.status) return;
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("SLL-R order update", {
      body: statusLabel(order.status) + " · " + order.item.name,
      tag: "sllr-order-" + order.id
    });
  }
}

function renderTrackedOrder(order) {
  const promise = order.promise || {};
  const tracking = order.tracking || {};
  const queueText = tracking.queuePosition
    ? "Queue position " + tracking.queuePosition + " (" + tracking.ordersAhead + " ahead)"
    : order.status === "ready" || order.status === "receipt_issued"
      ? "No longer waiting in the production queue"
      : "Queue position unavailable";
  liveStatus.textContent = "Live · " + statusLabel(order.status) + " · " + queueText;
  document.title = statusLabel(order.status) + " · Raposa";
  result.innerHTML = \`
    <div class="order">
      <div class="order-title">
        <div>
          <h3>\${escapeText(order.item.quantity)}x \${escapeText(order.item.name)}</h3>
          <p>Pass: \${escapeText(order.id)}</p>
        </div>
        <span class="pill">\${escapeText(order.status)}</span>
      </div>
      <p>\${escapeText(queueText)} · live wait \${escapeText(tracking.estimatedWaitMinutes ?? 0)} min.</p>
      <p>Promised pickup: \${escapeText(promise.promisedReadyAt ? new Date(promise.promisedReadyAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "not set")}.</p>
      <p>\${escapeText(statusLabel(order.status))}. This page refreshes automatically.</p>
      \${order.receipt ? \`<pre>Verified receipt: \${escapeText(order.receipt.receiptHash)}</pre>\` : ""}
    </div>
  \`;
}

async function loadActiveOrder() {
  if (!activeOrderId) return;
  const token = window.sessionStorage.getItem(buyerTokenKey);
  if (!token) return;
  try {
    const response = await fetch("/buyer/orders", { headers: authHeaders(token) });
    if (response.status === 401) {
      window.sessionStorage.removeItem(buyerTokenKey);
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = null;
      liveStatus.textContent = "Buyer session expired. Create a new order to continue.";
      return;
    }
    if (!response.ok) throw new Error("Order status request failed with " + response.status + ".");
    const payload = await response.json();
    const order = (payload.orders || []).find((candidate) => candidate.id === activeOrderId);
    if (!order) return;
    notifyStatus(order);
    renderTrackedOrder(order);
    lastStatus = order.status;
    if (["rejected", "receipt_issued"].includes(order.status) && pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch (error) {
    liveStatus.textContent = "Live update temporarily unavailable; retrying safely.";
    console.warn("SLL-R buyer order polling failed", error);
  }
}

function startPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  loadActiveOrder();
  pollTimer = window.setInterval(loadActiveOrder, 2000);
}

notifyButton.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    liveStatus.textContent = "Browser notifications are unavailable; in-page live updates remain enabled.";
    return;
  }
  const permission = await Notification.requestPermission();
  notifyButton.textContent = permission === "granted" ? "Notifications enabled" : "Notifications unavailable";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const item = catalog.find((entry) => entry.id === document.getElementById("itemId").value);
  const deadlineMinutes = Number(document.getElementById("deadlineMinutes").value || 15);
  const customerLabel = document.getElementById("customerLabel").value || "Raposa guest";
  if (!item) return;
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  result.innerHTML = '<p>Getting a merchant-backed quote...</p>';
  try {
    const token = await buyerToken(customerLabel);
    const orderRequest = {
      userIntent: "Order " + item.name + " from Raposa Coffee within " + deadlineMinutes + " minutes",
      itemId: item.id,
      maxSpendUsd: "25.00",
      deadlineMinutes,
      paymentMode: "counter"
    };
    const quoteResponse = await fetch("/merchants/raposa-coffee/quote", {
      method: "POST",
      headers: authHeaders(token, true),
      body: JSON.stringify(orderRequest)
    });
    const quote = await quoteResponse.json();
    if (!quoteResponse.ok || !quote.quoteId) throw new Error(quote.error || "Quote failed");

    const consentResponse = await fetch("/consent", {
      method: "POST",
      headers: authHeaders(token, true),
      body: JSON.stringify({ quoteId: quote.quoteId, confirmationText: quote.confirmationText })
    });
    const consent = await consentResponse.json();
    if (!consentResponse.ok || !consent.consent?.id) throw new Error(consent.error || "Consent failed");

    const orderResponse = await fetch("/merchants/raposa-coffee/orders", {
      method: "POST",
      headers: authHeaders(token, true),
      body: JSON.stringify({
        ...orderRequest,
        quoteId: quote.quoteId,
        consentId: consent.consent.id,
        agentId: "raposa-live-demo",
        customerLabel,
        idempotencyKey: "raposa-demo-" + quote.quoteId
      })
    });
    const payload = await orderResponse.json();
    if (!orderResponse.ok || !payload.order) throw new Error(payload.error || "Order failed");
    activeOrderId = payload.order.id;
    lastStatus = payload.order.status;
    window.sessionStorage.setItem(activeOrderKey, activeOrderId);
    liveStatus.textContent = "Live tracking connected. Waiting for merchant updates...";
    startPolling();
  } catch (error) {
    result.innerHTML = '<div class="notice">' + escapeText(error instanceof Error ? error.message : "Order failed") + '</div>';
  } finally {
    submitButton.disabled = false;
  }
});

if (activeOrderId) startPolling();
</script>`);
}
