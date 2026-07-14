import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { allMerchantProfiles, merchantForId, registerDemoMerchantProfile } from "../merchants/profiles.js";
import type { CatalogItem, FulfillmentMode, MenuItem, MerchantProfile } from "../types.js";

const MAX_CATALOG_ITEMS = 50;
const MAX_RESPONSE_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8_000;

type ShopifyVariant = {
  id?: unknown;
  title?: unknown;
  price?: unknown;
  available?: unknown;
};

type ShopifyProduct = {
  title?: unknown;
  handle?: unknown;
  product_type?: unknown;
  tags?: unknown;
  variants?: unknown;
};

function inputError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

// SSRF guard for the public-store ingestion fetch. Hostname-level only: a
// domain that resolves to a private IP is not caught here, so deployments
// that need stricter egress control should also restrict it at the network
// layer.
export function assertSafeShopifyDomain(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw inputError("Missing storeDomain.");
  }
  const domain = input.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:.*$/, "");
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(domain) || !domain.includes(".")) {
    throw inputError(`storeDomain must be a public hostname, got: ${input}`);
  }
  if (isIP(domain)) {
    throw inputError("storeDomain must be a hostname, not an IP address.");
  }
  // Reject non-canonical IPv4 encodings (127.1, 0x7f.0.0.1, 127.000.000.001)
  // that pass isIP() === 0 but still resolve to a numeric/loopback address.
  // A real hostname has at least one label with a non-digit, non-hex character.
  const labels = domain.split(".");
  const allNumericLike = labels.every((label) => /^(0x[0-9a-f]+|[0-9]+)$/.test(label));
  if (allNumericLike) {
    throw inputError("storeDomain must be a hostname, not a numeric address.");
  }
  const blockedSuffixes = [".local", ".localhost", ".internal", ".lan", ".home", ".corp"];
  if (domain === "localhost" || blockedSuffixes.some((suffix) => domain.endsWith(suffix))) {
    throw inputError("storeDomain points to a private or local network name.");
  }
  return domain;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw inputError("products.json response is too large to ingest.", 502);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function fetchShopifyProductsJson(domain: string): Promise<ShopifyProduct[]> {
  let url = `https://${domain}/products.json?limit=${MAX_CATALOG_ITEMS}`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          "user-agent": "SLL-R demo merchant ingestion (+https://github.com/JhiNResH/SLL-R)",
        },
      });
    } catch (error) {
      throw inputError(`Could not reach https://${domain}/products.json: ${error instanceof Error ? error.message : "fetch failed"}`, 502);
    }
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw inputError(`Redirect from ${url} had no location header.`, 502);
      const next = new URL(location, url);
      if (next.protocol !== "https:") throw inputError("Redirected to a non-https URL; refusing to follow.", 502);
      assertSafeShopifyDomain(next.hostname);
      url = next.toString();
      continue;
    }
    if (!response.ok) {
      throw inputError(`https://${domain}/products.json returned ${response.status}. Is this a public Shopify storefront?`, 502);
    }
    const declaredLength = Number(response.headers.get("content-length") || "0");
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw inputError("products.json response is too large to ingest.", 502);
    }
    const text = await readBodyCapped(response, MAX_RESPONSE_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw inputError(`https://${domain}/products.json did not return JSON. Is this a Shopify storefront?`, 502);
    }
    const products = typeof parsed === "object" && parsed && "products" in parsed
      ? (parsed as { products?: unknown }).products
      : null;
    if (!Array.isArray(products)) {
      throw inputError("products.json did not contain a products array.", 502);
    }
    return products as ShopifyProduct[];
  }
  throw inputError(`Too many redirects fetching https://${domain}/products.json.`, 502);
}

function normalizeTags(product: ShopifyProduct): string[] {
  const raw: string[] = [];
  if (Array.isArray(product.tags)) {
    raw.push(...product.tags.filter((tag): tag is string => typeof tag === "string"));
  } else if (typeof product.tags === "string") {
    raw.push(...product.tags.split(","));
  }
  if (typeof product.product_type === "string") raw.push(product.product_type);
  if (typeof product.title === "string") {
    raw.push(...product.title.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2));
  }
  const tags = raw
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 1);
  return [...new Set(tags)].slice(0, 20);
}

function pickVariant(product: ShopifyProduct): ShopifyVariant | null {
  if (!Array.isArray(product.variants) || product.variants.length === 0) return null;
  const variants = product.variants as ShopifyVariant[];
  return variants.find((variant) => variant.available === true) || variants[0];
}

function priceFrom(variant: ShopifyVariant): string | null {
  const price = typeof variant.price === "string" ? variant.price : typeof variant.price === "number" ? String(variant.price) : "";
  if (!/^\d+(\.\d{1,2})?$/.test(price)) return null;
  if (Number(price) <= 0) return null;
  return Number(price).toFixed(2);
}

export function mapShopifyProducts(domain: string, products: ShopifyProduct[], fulfillment: FulfillmentMode[]): CatalogItem[] {
  const items: CatalogItem[] = [];
  for (const product of products) {
    if (items.length >= MAX_CATALOG_ITEMS) break;
    const handle = typeof product.handle === "string" ? product.handle.trim() : "";
    const title = typeof product.title === "string" ? product.title.trim() : "";
    if (!handle || !title || !/^[a-z0-9-]+$/.test(handle)) continue;
    const variant = pickVariant(product);
    if (!variant) continue;
    const amountUsd = priceFrom(variant);
    if (!amountUsd) continue;
    items.push({
      id: handle,
      name: title,
      amountUsd,
      fulfillment,
      productionClass: "general",
      ...(fulfillment.includes("pickup") ? { prepMinutes: 7 } : {}),
      ...(fulfillment.includes("shipping") ? { shippingDays: 5 } : {}),
      inventory: 20,
      tags: normalizeTags(product),
      productUrl: `https://${domain}/products/${handle}`,
    });
  }
  return items;
}

function menuSectionFor(merchantId: string, domain: string, catalog: CatalogItem[]) {
  const items: MenuItem[] = catalog.map((item) => ({
    id: item.id,
    name: item.name,
    section: "Online store",
    priceStatus: "listed" as const,
    amountUsd: item.amountUsd,
    tags: item.tags,
  }));
  return {
    id: `${merchantId}-online-store`,
    name: "Online store",
    service: "shipping" as const,
    source: `https://${domain}/products.json`,
    items,
  };
}

function fulfillmentFrom(value: unknown): FulfillmentMode[] {
  if (value === "pickup") return ["pickup"];
  if (value === "both") return ["pickup", "shipping"];
  if (value === "shipping" || value === undefined || value === null || value === "") return ["shipping"];
  throw inputError("fulfillment must be one of pickup, shipping, both.");
}

function merchantIdFrom(payload: Record<string, unknown>, domain: string) {
  const requested = typeof payload.merchantId === "string" && payload.merchantId.trim()
    ? payload.merchantId.trim().toLowerCase()
    : domain.replace(/\./g, "-");
  const base = requested.startsWith("demo-") ? requested : `demo-${requested}`;
  if (!/^[a-z0-9-]{6,64}$/.test(base)) {
    throw inputError(`merchantId must be lowercase letters, digits, and dashes, got: ${base}`);
  }
  return base;
}

function requireDemoMerchantAuth(headers: Record<string, string | string[] | undefined>, payload: Record<string, unknown>, origin: string) {
  const expected = process.env.SLLR_DEMO_MERCHANT_SECRET?.trim();
  if (!expected) {
    const hostname = new URL(origin).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return;
    throw inputError("Demo merchant registration is disabled until SLLR_DEMO_MERCHANT_SECRET is configured.", 503);
  }
  const header = headers["x-sllr-demo-secret"];
  const provided = typeof header === "string" && header.trim()
    ? header.trim()
    : typeof payload.secret === "string" ? payload.secret.trim() : "";
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw inputError("Demo merchant secret is missing or invalid.", 401);
  }
}

export async function createDemoMerchant(headers: Record<string, string | string[] | undefined>, payload: Record<string, unknown>, origin: string) {
  requireDemoMerchantAuth(headers, payload, origin);
  const domain = assertSafeShopifyDomain(payload.storeDomain);
  const merchantId = merchantIdFrom(payload, domain);
  if (merchantForId(merchantId)) {
    throw inputError(`Merchant id ${merchantId} already exists. Choose a new id; demo merchant identities cannot be replaced.`, 409);
  }
  const fulfillment = fulfillmentFrom(payload.fulfillment);

  const rawProducts = Array.isArray(payload.products)
    ? payload.products as ShopifyProduct[]
    : await fetchShopifyProductsJson(domain);
  const catalog = mapShopifyProducts(domain, rawProducts, fulfillment);
  if (catalog.length === 0) {
    throw inputError(`No usable products found at https://${domain}/products.json (need handle, title, and a positive price).`, 422);
  }

  const profile: MerchantProfile = {
    id: merchantId,
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : domain,
    category: typeof payload.category === "string" && payload.category.trim() ? payload.category.trim() : "demo merchant",
    location: typeof payload.location === "string" && payload.location.trim() ? payload.location.trim() : "Online",
    fulfillment,
    paymentRails: ["counter", "shopify"],
    humanApproval: { requiredAboveUsd: "100.00" },
    catalog,
    menuSections: [menuSectionFor(merchantId, domain, catalog)],
  };
  await registerDemoMerchantProfile(profile);

  return {
    product: "SLL-R demo merchant ingestion",
    source: Array.isArray(payload.products) ? "provided_products" : `https://${domain}/products.json`,
    merchant: {
      id: profile.id,
      name: profile.name,
      category: profile.category,
      location: profile.location,
      fulfillment: profile.fulfillment,
      paymentRails: profile.paymentRails,
      catalogItems: profile.catalog.length,
    },
    demo: {
      agentPage: `${origin}/agent/${profile.id}`,
      terminalPage: `${origin}/terminal/${profile.id}`,
      menu: `${origin}/merchants/${profile.id}/menu`,
      quote: `${origin}/merchants/${profile.id}/quote`,
      examplePrompt: `Use SLL-R MCP. Quote "${profile.catalog[0].name}" from ${profile.name} and show me payment options before ordering.`,
    },
    notes: [
      "Prices come from the public products.json feed and are assumed to be USD.",
      "Payment rails default to counter + shopify checkout handoff; crypto rails are opt-in per merchant.",
      "Demo merchants live in memory and reset on server restart.",
    ],
  };
}

export function listDemoMerchants(origin: string) {
  return {
    product: "SLL-R demo merchants",
    merchants: allMerchantProfiles()
      .filter((merchant) => merchant.id.startsWith("demo-"))
      .map((merchant) => ({
        id: merchant.id,
        name: merchant.name,
        category: merchant.category,
        location: merchant.location,
        fulfillment: merchant.fulfillment,
        paymentRails: merchant.paymentRails,
        catalogItems: merchant.catalog.length,
        agentPage: `${origin}/agent/${merchant.id}`,
      })),
  };
}
