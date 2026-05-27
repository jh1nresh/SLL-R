import type { MerchantProfile } from "../types.js";

export const merchantProfiles: Record<string, MerchantProfile> = {
  "raposa-coffee": {
    id: "raposa-coffee",
    name: "Raposa Coffee",
    category: "cafe",
    location: "Miami Beach",
    fulfillment: ["pickup"],
    paymentRails: ["counter", "telegram_staff", "solana_pay"],
    humanApproval: { requiredAboveUsd: "25.00" },
    catalog: [
      { id: "espresso", name: "Espresso", amountUsd: "4.50", fulfillment: ["pickup"], productionClass: "espresso", prepMinutes: 4, tags: ["coffee"] },
      { id: "iced-latte", name: "Iced latte", amountUsd: "6.50", fulfillment: ["pickup"], productionClass: "espresso", prepMinutes: 7, tags: ["coffee", "latte", "iced"] },
      { id: "croissant", name: "Butter croissant", amountUsd: "5.25", fulfillment: ["pickup"], productionClass: "pastry", prepMinutes: 3, tags: ["pastry"] },
    ],
  },
  "raposa-shop": {
    id: "raposa-shop",
    name: "Raposa Shop",
    category: "coffee ecommerce",
    location: "Online",
    fulfillment: ["shipping"],
    paymentRails: ["shopify", "moonpay", "stripe", "solana_pay"],
    humanApproval: { requiredAboveUsd: "100.00" },
    catalog: [
      {
        id: "nitro-caramel-latte",
        name: "Nitro Cold Brew: Caramel Latte (250ml)",
        amountUsd: "17.95",
        fulfillment: ["shipping"],
        shippingDays: 5,
        inventory: 14,
        tags: ["nitro", "cold brew", "caramel", "latte"],
      },
      {
        id: "nitro-starter-pack",
        name: "Nitro Cold Brew: Starter Pack (8 Cans)",
        amountUsd: "24.95",
        fulfillment: ["shipping"],
        shippingDays: 5,
        inventory: 18,
        tags: ["nitro", "cold brew", "starter pack"],
      },
      {
        id: "sunrise-blend",
        name: "Sunrise Blend Medium-Dark Roast Specialty Coffee",
        amountUsd: "15.95",
        fulfillment: ["shipping"],
        shippingDays: 5,
        inventory: 12,
        tags: ["beans", "whole bean", "sunrise", "coffee"],
      },
      {
        id: "ethiopia-yirgacheffe",
        name: "Ethiopia Yirgacheffe Light Roast Specialty Coffee",
        amountUsd: "15.95",
        fulfillment: ["shipping"],
        shippingDays: 5,
        inventory: 12,
        tags: ["beans", "whole bean", "ethiopia", "yirgacheffe", "coffee"],
      },
    ],
  },
  solyd: {
    id: "solyd",
    name: "SOLYD",
    category: "phone accessories",
    location: "Online",
    fulfillment: ["shipping"],
    paymentRails: ["shopify", "moonpay", "stripe", "solana_pay"],
    humanApproval: { requiredAboveUsd: "150.00" },
    catalog: [
      {
        id: "iphone-16-black-magsafe",
        name: "Black MagSafe iPhone 16 case",
        amountUsd: "79.00",
        fulfillment: ["shipping"],
        shippingDays: 4,
        inventory: 12,
        tags: ["iphone", "case", "magsafe", "black"],
      },
      {
        id: "iphone-16-clear-magsafe",
        name: "Clear MagSafe iPhone 16 case",
        amountUsd: "74.00",
        fulfillment: ["shipping"],
        shippingDays: 4,
        inventory: 8,
        tags: ["iphone", "case", "magsafe", "clear"],
      },
    ],
  },
};

export function merchantForId(merchantId: string) {
  return merchantProfiles[merchantId] || null;
}
