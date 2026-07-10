import { readFileSync } from "node:fs";

export const merchantJourneyAssetNames = new Set([
  "intent.webp",
  "intent-m.webp",
  "intent.mp4",
  "intent-m.mp4",
  "fulfillment.webp",
  "fulfillment-m.webp",
  "fulfillment.mp4",
  "fulfillment-m.mp4",
  "receipt.webp",
  "receipt-m.webp",
  "receipt.mp4",
  "receipt-m.mp4",
  "connector-intent-fulfillment.mp4",
  "connector-intent-fulfillment-m.mp4",
  "connector-fulfillment-receipt.mp4",
  "connector-fulfillment-receipt-m.mp4",
]);

export function merchantJourneyEngine() {
  return readFileSync(new URL("./scroll-world-engine.js", import.meta.url), "utf8");
}

export function merchantJourneyPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#fbfaf6">
  <meta name="description" content="See how SLL-R turns one customer message into a fulfilled merchant order and verified receipt memory.">
  <title>From message to merchant proof | SLL-R</title>
  <style>
    :root, #world {
      --sw-bg: #fbfaf6;
      --sw-ink: #17251f;
      --sw-ink-soft: #56665f;
      --sw-accent: #0f4a35;
      --sw-font-display: ui-rounded, "SF Pro Rounded", "Avenir Next", system-ui, sans-serif;
      --sw-font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { background: #fbfaf6; }
    .skip-link {
      position: fixed; left: 16px; top: 12px; z-index: 100; transform: translateY(-180%);
      padding: 10px 14px; color: #fff; background: #17251f; text-decoration: none;
    }
    .skip-link:focus { transform: translateY(0); }
    .world-fallback {
      min-height: 100vh; display: grid; place-items: center; padding: 32px;
      color: #17251f; background: #fbfaf6; font: 16px/1.5 var(--sw-font-body);
    }
    .world-fallback a { color: #0f4a35; font-weight: 700; }
  </style>
</head>
<body>
  <a class="skip-link" href="#merchant-demo">Skip journey</a>
  <main id="world" aria-label="SLL-R merchant order journey"></main>
  <noscript>
    <div class="world-fallback">
      <p>SLL-R turns a customer message into a ready order and verified receipt. <a href="/agent/raposa-shop">Open the merchant demo</a>.</p>
    </div>
  </noscript>
  <script type="module">
    import "/world/engine.js";
    window.mountScrollWorld(document.getElementById("world"), {
      brand: { name: "SLL-R", href: "/world" },
      hint: "Scroll to follow the order",
      nav: true,
      atmosphere: true,
      diveScroll: 1.45,
      connScroll: 0.82,
      crossfade: 0.16,
      sections: [
        {
          id: "intent",
          label: "Intent",
          still: "/world/assets/intent.webp",
          stillMobile: "/world/assets/intent-m.webp",
          clip: "/world/assets/intent.mp4",
          clipMobile: "/world/assets/intent-m.mp4",
          accent: "#0f4a35",
          objectPositionMobile: "center top",
          scroll: 1.55,
          linger: 0.22,
          eyebrow: "One message starts the order",
          title: "Tell the store what you need.",
          body: "Scan once. Say your budget, taste, and timing in iMessage. No menu hunting and no new app to learn.",
          tags: ["QR entry", "Live menu", "No app install"]
        },
        {
          id: "fulfillment",
          label: "Fulfillment",
          still: "/world/assets/fulfillment.webp",
          stillMobile: "/world/assets/fulfillment-m.webp",
          clip: "/world/assets/fulfillment.mp4",
          clipMobile: "/world/assets/fulfillment-m.mp4",
          accent: "#c78c2f",
          objectPositionMobile: "center top",
          scroll: 1.6,
          linger: 0.3,
          eyebrow: "Agent and staff stay in sync",
          title: "The right order, ready on time.",
          body: "SLL-R recommends from the live menu, confirms the choice, and carries one clean accept-to-ready promise into the merchant terminal.",
          tags: ["Constraint-aware", "Merchant terminal", "Pickup promise"]
        },
        {
          id: "proof",
          label: "Proof",
          still: "/world/assets/receipt.webp",
          stillMobile: "/world/assets/receipt-m.webp",
          clip: "/world/assets/receipt.mp4",
          clipMobile: "/world/assets/receipt-m.mp4",
          accent: "#a3372d",
          objectPositionMobile: "center top",
          scroll: 1.7,
          linger: 0.34,
          eyebrow: "Fulfillment becomes proof",
          title: "Every completed order can build trust.",
          body: "Payment and pickup evidence become verified receipt memory for better recommendations, loyalty, and merchant reputation.",
          tags: ["Payment proof", "Verified receipt", "Reusable trust"],
          cta: {
            primary: { label: "Try the customer agent", href: "/agent/raposa-shop" },
            secondary: { label: "See the merchant terminal", href: "/terminal/raposa-shop" }
          }
        }
      ],
      connectors: [
        "/world/assets/connector-intent-fulfillment.mp4",
        "/world/assets/connector-fulfillment-receipt.mp4"
      ],
      connectorsMobile: [
        "/world/assets/connector-intent-fulfillment-m.mp4",
        "/world/assets/connector-fulfillment-receipt-m.mp4"
      ]
    });
  </script>
</body>
</html>`;
}
