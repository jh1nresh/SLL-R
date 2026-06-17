import type { CatalogItem, MerchantProfile } from "../types.js";
import { sllrStore, storeBackendName } from "../core/store.js";

const nounCoffeeInStoreMenu = [
  {
    id: "noun-coffee-matcha",
    name: "Coffee + Matcha",
    service: "in_store" as const,
    source: "https://noun.coffee/",
    items: [
      {
        id: "easy-drinker-pourover",
        name: "Easy drinker pourover",
        section: "Coffee + Matcha",
        description: "Colombia washed Opal. Notes: honeydew, lemongrass, pluot. Served hot or iced.",
        priceStatus: "unlisted" as const,
        tags: ["coffee", "pourover", "colombia", "washed", "honeydew", "lemongrass", "pluot", "hot", "iced"],
      },
      {
        id: "crowd-pleaser-pourover",
        name: "Crowd pleaser pourover",
        section: "Coffee + Matcha",
        description: "Vietnam natural Opal. Notes: raspberry, watermelon, black tea. Served hot or iced.",
        priceStatus: "unlisted" as const,
        tags: ["coffee", "pourover", "vietnam", "natural", "raspberry", "watermelon", "black tea", "hot", "iced"],
      },
      {
        id: "wildcard-pourover",
        name: "Wildcard pourover",
        section: "Coffee + Matcha",
        description: "Dealer's choice rotating selection. Served hot or iced.",
        priceStatus: "unlisted" as const,
        tags: ["coffee", "pourover", "rotating", "hot", "iced"],
      },
      {
        id: "short-stack",
        name: "Short stack",
        section: "Coffee + Matcha",
        description: "Chilled espresso dulce, maple cream, milk, Maldon salt, and ice. Served cappuccino style, iced.",
        priceStatus: "unlisted" as const,
        tags: ["coffee", "espresso", "dulce", "maple", "cream", "milk", "iced"],
      },
      {
        id: "gold-rush",
        name: "Gold rush",
        section: "Coffee + Matcha",
        description: "Espresso dulce, warming spice blend, and milk. Served cappuccino style, hot or iced. Creamtop available.",
        priceStatus: "unlisted" as const,
        tags: ["coffee", "espresso", "spice", "milk", "hot", "iced", "creamtop"],
      },
      {
        id: "fridge-cigarette",
        name: "Fridge cigarette",
        section: "Coffee + Matcha",
        description: "Chilled espresso, Diet Coke, and ice. Served iced. Creamtop available.",
        priceStatus: "unlisted" as const,
        tags: ["coffee", "espresso", "diet coke", "iced", "creamtop"],
      },
      {
        id: "mocha",
        name: "Mocha",
        section: "Coffee + Matcha",
        description: "Espresso, raw cacao mocha, and milk. Served hot or iced. Creamtop available.",
        priceStatus: "unlisted" as const,
        tags: ["coffee", "espresso", "mocha", "cacao", "milk", "hot", "iced", "creamtop"],
      },
      {
        id: "the-usual",
        name: "The usual",
        section: "Coffee + Matcha",
        description: "Espresso dulce, brown sugar, and milk. Served hot or iced. Creamtop available.",
        priceStatus: "unlisted" as const,
        tags: ["coffee", "espresso", "brown sugar", "milk", "hot", "iced", "creamtop"],
      },
      {
        id: "matcha-heaven",
        name: "Matcha heaven",
        section: "Coffee + Matcha",
        description: "Standstill matcha, milk, matcha cream, vanilla, and ice. Served iced.",
        priceStatus: "unlisted" as const,
        tags: ["matcha", "milk", "cream", "vanilla", "iced"],
      },
      {
        id: "coquito-verde",
        name: "Coquito verde",
        section: "Coffee + Matcha",
        description: "Standstill matcha, coquito cream, and ice. Served iced.",
        priceStatus: "unlisted" as const,
        tags: ["matcha", "coquito", "cream", "iced"],
      },
      {
        id: "tropicoqueta",
        name: "Tropicoqueta",
        section: "Coffee + Matcha",
        description: "Standstill matcha, sparkling water, mango, guava, cream of coconut, and ice.",
        priceStatus: "unlisted" as const,
        tags: ["matcha", "sparkling", "mango", "guava", "coconut", "iced"],
      },
      {
        id: "hoji-stack",
        name: "Hoji stack",
        section: "Coffee + Matcha",
        description: "Standstill hojicha, maple cream, milk, and ice. Served cappuccino style, iced.",
        priceStatus: "unlisted" as const,
        tags: ["hojicha", "maple", "cream", "milk", "iced"],
      },
      {
        id: "strawberry-gains",
        name: "Strawberry gains",
        section: "Coffee + Matcha",
        description: "Standstill matcha and strawberry milk with 20g protein. Served hot or iced. Creamtop available.",
        priceStatus: "unlisted" as const,
        tags: ["matcha", "strawberry", "milk", "protein", "hot", "iced", "creamtop"],
      },
      {
        id: "the-classic",
        name: "The classic",
        section: "Coffee + Matcha",
        description: "Choice of Standstill matcha or hojicha with milk. Served hot or iced. Vanilla bean and creamtop available.",
        priceStatus: "unlisted" as const,
        tags: ["matcha", "hojicha", "milk", "hot", "iced", "vanilla", "creamtop"],
      },
      {
        id: "pt-cruiser",
        name: "PT cruiser",
        section: "Coffee + Matcha",
        description: "Standstill gui fei oolong and spiced pear. Served hot or iced.",
        priceStatus: "unlisted" as const,
        tags: ["tea", "oolong", "spiced pear", "hot", "iced"],
      },
      {
        id: "slow-burn",
        name: "Slow burn",
        section: "Coffee + Matcha",
        description: "House chai, adaptogens, and warming spices. Served hot or iced. Creamtop available.",
        priceStatus: "unlisted" as const,
        tags: ["tea", "chai", "adaptogens", "spice", "hot", "iced", "creamtop"],
      },
      {
        id: "cran-bomb",
        name: "Cran bomb",
        section: "Coffee + Matcha",
        description: "Sparkling chai, cranberry, and ice. Iced only.",
        priceStatus: "unlisted" as const,
        tags: ["tea", "chai", "cranberry", "sparkling", "iced"],
      },
      {
        id: "gardenia-green-tea",
        name: "Standstill gardenia green tea",
        section: "Coffee + Matcha",
        priceStatus: "unlisted" as const,
        tags: ["tea", "green tea", "gardenia"],
      },
      {
        id: "bug-bitten-gui-fei-oolong",
        name: "Standstill bug bitten gui fei oolong",
        section: "Coffee + Matcha",
        priceStatus: "unlisted" as const,
        tags: ["tea", "oolong", "gui fei"],
      },
      {
        id: "hibiscus-goji-lemongrass",
        name: "Standstill hibiscus goji lemongrass",
        section: "Coffee + Matcha",
        priceStatus: "unlisted" as const,
        tags: ["tea", "hibiscus", "goji", "lemongrass"],
      },
      {
        id: "yuzu-dream",
        name: "Yuzu dream",
        section: "Coffee + Matcha",
        description: "Sparkling yuzu, simple syrup, sancho, and ice. Matcha available.",
        priceStatus: "unlisted" as const,
        tags: ["yuzu", "sparkling", "sancho", "iced", "matcha"],
      },
      {
        id: "hot-chocolate",
        name: "Hot chocolate",
        section: "Coffee + Matcha",
        description: "Chocolate ganache and milk.",
        priceStatus: "unlisted" as const,
        tags: ["chocolate", "milk", "hot"],
      },
    ],
  },
  {
    id: "noun-wine-beer-cocktails",
    name: "Wine, Beer, Cider, Sake + Cocktails",
    service: "in_store" as const,
    source: "https://noun.coffee/",
    items: [
      { id: "margins-neutral-oak-hotel", name: "Margins neutral oak hotel", section: "Wine", description: "California 2024 white: chenin blanc, muscat blanc, and vermentino.", priceStatus: "unlisted" as const, tags: ["wine", "white", "california", "chenin blanc", "muscat", "vermentino"] },
      { id: "sol-y-mar", name: "Mas Vino Please x Wonderwerk Sol y Mar", section: "Wine", description: "Los Angeles 2024 white: albarino, riesling, and sauvignon blanc.", priceStatus: "unlisted" as const, tags: ["wine", "white", "los angeles", "albarino", "riesling", "sauvignon blanc"] },
      { id: "noun-chilled-red", name: "Noun chilled red", section: "Wine", description: "California 2024 chilled red: grenache, sauvignon blanc, mourvedre, and cinsaut.", priceStatus: "unlisted" as const, tags: ["wine", "chilled red", "california", "grenache", "sauvignon blanc", "mourvedre", "cinsaut"] },
      { id: "bodillard-les-laforest", name: "Bodillard Les Laforest Beaujolais Villages", section: "Wine", description: "France 2024 red, 100% gamay.", priceStatus: "unlisted" as const, tags: ["wine", "red", "france", "gamay", "beaujolais"] },
      { id: "field-recordings-ouille", name: "Field Recordings Ouille", section: "Wine", description: "California 2024 white, 100% savagnin blanc.", priceStatus: "unlisted" as const, tags: ["wine", "white", "california", "savagnin blanc"] },
      { id: "so-far-out-all-the-rage", name: "So Far Out All the Rage Red", section: "Wine", description: "Santa Barbara 2022 red: cabernet sauvignon, merlot, syrah, and marselan.", priceStatus: "unlisted" as const, tags: ["wine", "red", "santa barbara", "cabernet sauvignon", "merlot", "syrah", "marselan"] },
      { id: "itri-cellars-red-blend", name: "Itri Cellars red blend", section: "Wine", description: "Santa Barbara 2025 red blend: pinot noir and grenache.", priceStatus: "unlisted" as const, tags: ["wine", "red", "santa barbara", "pinot noir", "grenache"] },
      { id: "mr-brightside-gamay-noir", name: "Mr. Brightside gamay noir", section: "Wine", description: "Santa Barbara 2022 red, gamay noir.", priceStatus: "unlisted" as const, tags: ["wine", "red", "santa barbara", "gamay noir"] },
      { id: "wonderwerk-free-your-mind", name: "Wonderwerk Free Your Mind", section: "Wine", description: "Los Angeles 2023 co-ferment: carignan and riesling.", priceStatus: "unlisted" as const, tags: ["wine", "co-ferment", "los angeles", "carignan", "riesling"] },
      { id: "chismosa-rose", name: "Mas Vino Please x Wonderwerk Chismosa", section: "Wine", description: "Los Angeles 2024 rose: montepulciano, gewurztraminer, mourvedre, petite sirah, grenache, and syrah.", priceStatus: "unlisted" as const, tags: ["wine", "rose", "los angeles", "montepulciano", "gewurztraminer", "mourvedre", "petite sirah", "grenache", "syrah"] },
      { id: "noun-orange", name: "Noun orange", section: "Wine", description: "California 2025 orange wine: sauvignon, riesling, and pinot gris.", priceStatus: "unlisted" as const, tags: ["wine", "orange", "california", "sauvignon", "riesling", "pinot gris"] },
      { id: "itri-cellars-skin-contact-white", name: "Itri Cellars skin contact white", section: "Wine", description: "Santa Barbara 2025 skin contact white: sauvignon blanc and viognier.", priceStatus: "unlisted" as const, tags: ["wine", "white", "skin contact", "santa barbara", "sauvignon blanc", "viognier"] },
      { id: "como-la-flor", name: "Mas Vino Please x Wonderwerk Como La Flor", section: "Wine", description: "Los Angeles 2024 chilled red: montepulciano, grenache, malbec, tempranillo, and mencia.", priceStatus: "unlisted" as const, tags: ["wine", "chilled red", "los angeles", "montepulciano", "grenache", "malbec", "tempranillo", "mencia"] },
      { id: "sapporo-reserve", name: "Sapporo Reserve", section: "Beer", description: "Premium malt lager, smooth and full-bodied.", priceStatus: "unlisted" as const, tags: ["beer", "lager", "malt"] },
      { id: "orion-lager", name: "Orion lager", section: "Beer", description: "Classic Okinawan beer, light and crisp.", priceStatus: "unlisted" as const, tags: ["beer", "lager", "okinawan", "crisp"] },
      { id: "orion-draft", name: "Orion draft", section: "Beer", description: "Subtle malt, floral hops, refreshing finish.", priceStatus: "unlisted" as const, tags: ["beer", "draft", "malt", "floral hops"] },
      { id: "sapporo-draft", name: "Sapporo draft", section: "Beer", description: "Clean malt, light hop bitterness, ultra-refreshing finish.", priceStatus: "unlisted" as const, tags: ["beer", "draft", "malt", "hops"] },
      { id: "durham-rhubenstein-gps", name: "Durham Rhubenstein GPS", section: "Ciders", description: "Santa Barbara 2022 cider with gravenstein apples and rhubarb.", priceStatus: "unlisted" as const, tags: ["cider", "santa barbara", "apple", "rhubarb"] },
      { id: "wild-arc-to-eris", name: "Wild Arc To Eris apple / quince cider", section: "Ciders", description: "New York 2022 cider with fresh apple and floral quince.", priceStatus: "unlisted" as const, tags: ["cider", "new york", "apple", "quince"] },
      { id: "wild-arc-florescence", name: "Wild Arc Florescence", section: "Ciders", description: "New York 2022 cider with concord grape and chamomile.", priceStatus: "unlisted" as const, tags: ["cider", "new york", "concord grape", "chamomile"] },
      { id: "suigei-drunken-whale", name: "Suigei Tokubetsu Junmai Drunken Whale", section: "Sake", description: "Dry, savory junmai with a clean finish from Kochi prefecture.", priceStatus: "unlisted" as const, tags: ["sake", "junmai", "dry", "savory", "kochi"] },
      { id: "hakkaisan-junmai-daiginjo", name: "Hakkaisan Junmai Daiginjo", section: "Sake", description: "Elegant, crisp, and floral sake from Niigata.", priceStatus: "unlisted" as const, tags: ["sake", "junmai daiginjo", "crisp", "floral", "niigata"] },
      { id: "in-bloom", name: "In-bloom", section: "Cocktails", description: "Mommenpop blood orange and Lite Werk hibiscus sparkling wine.", priceStatus: "unlisted" as const, tags: ["cocktail", "blood orange", "hibiscus", "sparkling wine"] },
      { id: "zora", name: "Zora", section: "Cocktails", description: "Shochu, seville orange, oolong syrup, and mango boba.", priceStatus: "unlisted" as const, tags: ["cocktail", "shochu", "seville orange", "oolong", "mango boba"] },
      { id: "new-day-one-martini", name: "New day one martini", section: "Cocktails", description: "Vanilla shochu, pistachio orgeat, and chilled espresso.", priceStatus: "unlisted" as const, tags: ["cocktail", "martini", "vanilla shochu", "pistachio", "espresso"] },
    ],
  },
];

const nounCoffeeUberEatsPickupCatalog: CatalogItem[] = [
  { id: "ue-short-stack", name: "Short Stack", amountUsd: "8.96", fulfillment: ["pickup"], productionClass: "espresso" as const, prepMinutes: 7, inventory: 20, tags: ["short", "stack", "chilled", "espresso", "dulce", "maple", "cream", "milk", "iced"] },
  { id: "ue-golden-hour", name: "Golden Hour", amountUsd: "8.96", fulfillment: ["pickup"], productionClass: "espresso" as const, prepMinutes: 7, inventory: 20, tags: ["golden", "hour", "espresso", "dulce", "spice", "milk", "hot", "iced"] },
  { id: "ue-fridge-cigarette", name: "Fridge Cigarette", amountUsd: "8.96", fulfillment: ["pickup"], productionClass: "espresso" as const, prepMinutes: 7, inventory: 20, tags: ["fridge", "cigarette", "espresso", "diet coke", "iced", "creamtop"] },
  { id: "ue-matcha-heaven", name: "Matcha Heaven", amountUsd: "10.08", fulfillment: ["pickup"], productionClass: "cold" as const, prepMinutes: 7, inventory: 20, tags: ["matcha", "milk", "cream", "vanilla", "iced"] },
  { id: "ue-tropicoqueta", name: "Tropicoqueta", amountUsd: "8.96", fulfillment: ["pickup"], productionClass: "cold" as const, prepMinutes: 7, inventory: 20, tags: ["matcha", "sparkling", "mango", "guava", "coconut", "iced"] },
  { id: "ue-the-classic-matcha-latte", name: "The Classic Matcha Latte", amountUsd: "7.84", fulfillment: ["pickup"], productionClass: "cold" as const, prepMinutes: 7, inventory: 20, tags: ["classic", "matcha", "latte", "milk", "hot", "iced", "vanilla", "creamtop"] },
  { id: "ue-the-classic-hojicha-latte", name: "The Classic Hojicha Latte", amountUsd: "7.84", fulfillment: ["pickup"], productionClass: "cold" as const, prepMinutes: 7, inventory: 20, tags: ["classic", "hojicha", "latte", "milk", "hot", "iced", "vanilla", "creamtop"] },
  { id: "ue-pt-cruiser", name: "PT Cruiser", amountUsd: "7.84", fulfillment: ["pickup"], productionClass: "cold" as const, prepMinutes: 7, inventory: 20, tags: ["tea", "oolong", "spiced pear", "hot", "iced"] },
  { id: "ue-yuzu-dream", name: "Yuzu Dream", amountUsd: "8.96", fulfillment: ["pickup"], productionClass: "cold" as const, prepMinutes: 7, inventory: 20, tags: ["yuzu", "sparkling", "sancho", "iced", "matcha"] },
  { id: "ue-easy-drinker", name: "Easy Drinker", amountUsd: "6.72", fulfillment: ["pickup"], productionClass: "espresso" as const, prepMinutes: 7, inventory: 20, tags: ["coffee", "pourover", "easy drinker", "hot", "iced"] },
  { id: "ue-crowd-pleaser", name: "Crowd Pleaser", amountUsd: "11.20", fulfillment: ["pickup"], productionClass: "espresso" as const, prepMinutes: 7, inventory: 20, tags: ["coffee", "pourover", "crowd pleaser", "vietnam", "raspberry", "watermelon", "black tea"] },
  { id: "ue-wildcard", name: "Wildcard", amountUsd: "13.44", fulfillment: ["pickup"], productionClass: "espresso" as const, prepMinutes: 7, inventory: 20, tags: ["coffee", "pourover", "wildcard", "rotating"] },
  { id: "ue-americano", name: "Americano", amountUsd: "5.60", fulfillment: ["pickup"], productionClass: "espresso" as const, prepMinutes: 7, inventory: 20, tags: ["coffee", "espresso", "americano"] },
  { id: "ue-the-usual-latte", name: "The Usual Latte", amountUsd: "7.84", fulfillment: ["pickup"], productionClass: "espresso" as const, prepMinutes: 7, inventory: 20, tags: ["coffee", "latte", "espresso", "brown sugar", "milk", "hot", "iced"] },
  { id: "ue-tea", name: "Tea", amountUsd: "5.60", fulfillment: ["pickup"], productionClass: "cold" as const, prepMinutes: 7, inventory: 20, tags: ["tea", "hot", "iced"] },
  { id: "ue-chai-del-rey", name: "Chai Del Rey", amountUsd: "7.84", fulfillment: ["pickup"], productionClass: "cold" as const, prepMinutes: 7, inventory: 20, tags: ["tea", "chai", "spice", "hot", "iced", "creamtop"] },
  { id: "ue-avocado-toast", name: "Avocado Toast", amountUsd: "15.68", fulfillment: ["pickup"], productionClass: "pastry" as const, prepMinutes: 12, inventory: 20, tags: ["food", "toast", "avocado", "sourdough", "vegetarian", "gluten free"] },
  { id: "ue-yogurt-granola-bowl", name: "Yogurt + Granola Bowl", amountUsd: "16.80", fulfillment: ["pickup"], productionClass: "pastry" as const, prepMinutes: 12, inventory: 20, tags: ["food", "yogurt", "granola", "blackberries", "banana", "vegetarian", "gluten free"] },
  { id: "ue-cachapa", name: "Cachapa", amountUsd: "16.80", fulfillment: ["pickup"], productionClass: "pastry" as const, prepMinutes: 12, inventory: 20, tags: ["food", "corn", "pancake", "queso", "vegetarian", "gluten free"] },
  { id: "ue-pressed-sando", name: "Pressed Sando", amountUsd: "20.16", fulfillment: ["pickup"], productionClass: "pastry" as const, prepMinutes: 12, inventory: 20, tags: ["food", "sando", "gruyere", "jamon", "mustard", "sourdough"] },
  { id: "ue-market-bowl", name: "Market Bowl", amountUsd: "17.92", fulfillment: ["pickup"], productionClass: "pastry" as const, prepMinutes: 12, inventory: 20, tags: ["food", "bowl", "quinoa", "greens", "egg", "avocado", "vegetarian", "gluten free"] },
  { id: "ue-market-greens", name: "Market Greens", amountUsd: "19.04", fulfillment: ["pickup"], productionClass: "pastry" as const, prepMinutes: 12, inventory: 20, tags: ["food", "greens", "gruyere", "mustard", "pepitas", "olives", "vegetarian", "gluten free"] },
  { id: "ue-cinnamon-bun", name: "Cinnamon Bun", amountUsd: "10.08", fulfillment: ["pickup"], productionClass: "pastry" as const, prepMinutes: 3, inventory: 20, tags: ["pastry", "cinnamon", "bun", "brown sugar", "vanilla"] },
  { id: "ue-banana-bread-pudding", name: "Banana Bread Pudding", amountUsd: "6.72", fulfillment: ["pickup"], productionClass: "pastry" as const, prepMinutes: 3, inventory: 20, tags: ["pastry", "banana", "bread", "pudding", "vegetarian"] },
  { id: "ue-dark-chocolate-pudding", name: "Dark Chocolate Pudding", amountUsd: "8.96", fulfillment: ["pickup"], productionClass: "pastry" as const, prepMinutes: 12, inventory: 20, tags: ["pastry", "chocolate", "pudding", "plantain", "vegan", "gluten free"] },
  { id: "ue-camins-2-dreams-duo", name: "Camins 2 Dreams Duo", amountUsd: "67.20", fulfillment: ["pickup"], productionClass: "general" as const, prepMinutes: 3, inventory: 20, tags: ["wine", "duo", "carignan", "gruner veltliner"] },
  { id: "ue-red-trio", name: "Red Trio", amountUsd: "100.80", fulfillment: ["pickup"], productionClass: "general" as const, prepMinutes: 3, inventory: 20, tags: ["wine", "red", "trio"] },
  { id: "ue-vinho-branco-marcio-lopes-portugal", name: "Vinho Branco Marcio Lopes (Portugal)", amountUsd: "33.60", fulfillment: ["pickup"], productionClass: "general" as const, prepMinutes: 7, inventory: 20, tags: ["wine", "white", "portugal", "arinto", "loureiro", "avesso"] },
  { id: "ue-vinho-rubro-marcio-lopes-red-portugal", name: "Vinho Rubro Marcio Lopes Red (Portugal)", amountUsd: "35.84", fulfillment: ["pickup"], productionClass: "general" as const, prepMinutes: 3, inventory: 20, tags: ["wine", "red", "portugal", "vinhao", "baga", "touriga nacional"] },
  { id: "ue-rosa-marcio-lopes-rose-portugal", name: "Rosa Marcio Lopes Rose (Portugal)", amountUsd: "33.60", fulfillment: ["pickup"], productionClass: "general" as const, prepMinutes: 7, inventory: 20, tags: ["wine", "rose", "portugal", "touriga nacional", "tinta roriz"] },
  { id: "ue-lou-38-portuguese-white", name: "LOU 38 Portuguese White", amountUsd: "42.56", fulfillment: ["pickup"], productionClass: "general" as const, prepMinutes: 7, inventory: 20, tags: ["wine", "white", "portugal", "loureiro", "citrus"] },
  { id: "ue-hat-fridge-cig", name: "Hat - Fridge Cig", amountUsd: "44.80", fulfillment: ["pickup"], productionClass: "general" as const, prepMinutes: 3, inventory: 20, tags: ["hat", "merch", "fridge", "cig"] },
  { id: "ue-hat-matcha-heaven", name: "Hat - Matcha Heaven", amountUsd: "44.80", fulfillment: ["pickup"], productionClass: "general" as const, prepMinutes: 3, inventory: 20, tags: ["hat", "merch", "matcha", "heaven"] },
  { id: "ue-58-percent-oat-milk-chocolate-bar", name: "58% Oat Milk Chocolate Bar", amountUsd: "10.08", fulfillment: ["pickup"], productionClass: "general" as const, prepMinutes: 3, inventory: 20, tags: ["chocolate", "bar", "oat milk", "vegan", "organic"] },
  { id: "ue-desert-fleur-botanical-perfume-rollerball", name: "Desert Fleur Botanical Perfume Rollerball", amountUsd: "44.80", fulfillment: ["pickup"], productionClass: "general" as const, prepMinutes: 3, inventory: 20, tags: ["perfume", "rollerball", "botanical", "earthy"] },
];

export const merchantProfiles: Record<string, MerchantProfile> = {
  // Hermes hackathon demo: the "Game Day Order Lane". Busy before kickoff — the
  // recommender must pick what's fast + in budget + on-taste and reject the rest.
  "game-day-boba": {
    id: "game-day-boba",
    name: "Game Day Boba Bar",
    category: "boba",
    location: "Los Angeles",
    geo: { lat: 34.0407, lng: -118.2468 },
    fulfillment: ["pickup"],
    paymentRails: ["counter", "stripe"],
    humanApproval: { requiredAboveUsd: "25.00" },
    catalog: [
      { id: "brown-sugar-boba", name: "Brown Sugar Boba", amountUsd: "6.50", fulfillment: ["pickup"], productionClass: "cold", prepMinutes: 5, inventory: 50, tags: ["cold", "sweet", "boba", "milk", "caffeine"] },
      { id: "fruit-tea", name: "Fruit Tea", amountUsd: "5.75", fulfillment: ["pickup"], productionClass: "cold", prepMinutes: 2, inventory: 60, tags: ["cold", "fast", "fruit", "caffeine_free", "light"] },
      { id: "fried-chicken", name: "Fried Chicken", amountUsd: "9.00", fulfillment: ["pickup"], productionClass: "general", prepMinutes: 18, inventory: 30, tags: ["hot", "food", "savory"] },
      { id: "taro-milk", name: "Taro Milk", amountUsd: "6.25", fulfillment: ["pickup"], productionClass: "cold", prepMinutes: 5, inventory: 40, tags: ["cold", "sweet", "taro", "milk"] },
    ],
  },
  "raposa-coffee": {
    id: "raposa-coffee",
    name: "Raposa Coffee",
    category: "cafe",
    location: "Miami Beach",
    geo: { lat: 25.7907, lng: -80.1300 },
    fulfillment: ["pickup"],
    // stripe = prepay-in-flow (card / Apple Pay) over iMessage; counter stays as
    // the pay-on-pickup fallback. Requires STRIPE_SECRET_KEY on the backend.
    paymentRails: ["counter", "stripe", "telegram_staff", "solana_pay"],
    humanApproval: { requiredAboveUsd: "25.00" },
    catalog: [
      { id: "espresso", name: "Espresso", amountUsd: "4.50", fulfillment: ["pickup"], productionClass: "espresso", prepMinutes: 4, inventory: 40, tags: ["coffee", "espresso", "fast"] },
      { id: "cortado", name: "Cortado", amountUsd: "5.50", fulfillment: ["pickup"], productionClass: "espresso", prepMinutes: 6, inventory: 30, tags: ["coffee", "espresso", "milk", "small"] },
      { id: "iced-latte", name: "Iced latte", amountUsd: "6.50", fulfillment: ["pickup"], productionClass: "espresso", prepMinutes: 7, inventory: 35, tags: ["coffee", "latte", "iced", "milk"] },
      { id: "cold-brew", name: "Cold brew", amountUsd: "5.75", fulfillment: ["pickup"], productionClass: "cold", prepMinutes: 3, inventory: 25, tags: ["coffee", "cold", "fast", "iced"] },
      { id: "matcha-latte", name: "Matcha latte", amountUsd: "7.00", fulfillment: ["pickup"], productionClass: "cold", prepMinutes: 6, inventory: 20, tags: ["matcha", "latte", "iced", "milk"] },
      { id: "croissant", name: "Butter croissant", amountUsd: "5.25", fulfillment: ["pickup"], productionClass: "pastry", prepMinutes: 3, inventory: 18, tags: ["pastry", "fast"] },
    ],
    menuSections: [
      {
        id: "raposa-pickup-drinks",
        name: "Pickup drinks",
        service: "in_store",
        source: "SLL-R Raposa pilot menu",
        items: [
          { id: "espresso", name: "Espresso", section: "Pickup drinks", description: "Fast espresso order for pickup.", priceStatus: "listed", amountUsd: "4.50", tags: ["coffee", "espresso", "fast"] },
          { id: "cortado", name: "Cortado", section: "Pickup drinks", description: "Espresso with steamed milk.", priceStatus: "listed", amountUsd: "5.50", tags: ["coffee", "espresso", "milk"] },
          { id: "iced-latte", name: "Iced latte", section: "Pickup drinks", description: "Espresso and milk over ice. Main pilot item for pickup promise demos.", priceStatus: "listed", amountUsd: "6.50", tags: ["coffee", "latte", "iced"] },
          { id: "cold-brew", name: "Cold brew", section: "Pickup drinks", description: "Fast cold coffee option when espresso queue is busy.", priceStatus: "listed", amountUsd: "5.75", tags: ["coffee", "cold", "fast"] },
          { id: "matcha-latte", name: "Matcha latte", section: "Pickup drinks", description: "Matcha latte for non-coffee orders.", priceStatus: "listed", amountUsd: "7.00", tags: ["matcha", "iced"] },
        ],
      },
      {
        id: "raposa-pickup-pastries",
        name: "Pickup pastries",
        service: "in_store",
        source: "SLL-R Raposa pilot menu",
        items: [
          { id: "croissant", name: "Butter croissant", section: "Pickup pastries", description: "Quick pastry add-on.", priceStatus: "listed", amountUsd: "5.25", tags: ["pastry", "fast"] },
        ],
      },
    ],
  },
  "raposa-shop": {
    id: "raposa-shop",
    name: "Raposa Shop",
    category: "coffee ecommerce",
    location: "Online",
    fulfillment: ["shipping"],
    paymentRails: ["shopify", "moonpay", "helio", "stripe", "solana_pay", "binance_pay"],
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
    paymentRails: ["shopify", "moonpay", "helio", "stripe", "solana_pay", "binance_pay"],
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
  "changbaishan-rice": {
    id: "changbaishan-rice",
    name: "Changbaishan Rice",
    category: "specialty grocery",
    location: "Online",
    fulfillment: ["shipping"],
    paymentRails: ["shopify", "stripe", "solana_pay"],
    humanApproval: { requiredAboveUsd: "80.00" },
    catalog: [
      {
        id: "fresh-milled-rice-5kg",
        name: "Fresh-milled Changbaishan rice 5kg",
        amountUsd: "24.00",
        fulfillment: ["shipping"],
        shippingDays: 5,
        inventory: 50,
        tags: ["rice", "fresh", "fresh milled", "unpolished", "natural", "changbaishan", "daily cooking"],
        productUrl: "https://changbaishan-rice.example/products/fresh-milled-rice-5kg",
      },
      {
        id: "rice-gift-box-2kg",
        name: "Changbaishan rice gift box 2kg",
        amountUsd: "18.00",
        fulfillment: ["shipping"],
        shippingDays: 5,
        inventory: 30,
        tags: ["rice", "gift", "gift box", "natural", "changbaishan"],
        productUrl: "https://changbaishan-rice.example/products/rice-gift-box-2kg",
      },
      {
        id: "bulk-rice-50kg",
        name: "Bulk Changbaishan rice 50kg",
        amountUsd: "89.00",
        fulfillment: ["shipping"],
        shippingDays: 7,
        inventory: 8,
        tags: ["rice", "bulk", "wholesale", "restaurant", "changbaishan"],
        productUrl: "https://changbaishan-rice.example/products/bulk-rice-50kg",
      },
    ],
    menuSections: [
      {
        id: "changbaishan-rice-products",
        name: "Rice products",
        service: "shipping",
        source: "SLL-R content-commerce example catalog",
        items: [
          { id: "fresh-milled-rice-5kg", name: "Fresh-milled Changbaishan rice 5kg", section: "Rice products", description: "Natural, unpolished rice for daily cooking.", priceStatus: "listed", amountUsd: "24.00", tags: ["rice", "fresh milled", "unpolished"] },
          { id: "rice-gift-box-2kg", name: "Changbaishan rice gift box 2kg", section: "Rice products", description: "Gift-ready smaller pack.", priceStatus: "listed", amountUsd: "18.00", tags: ["rice", "gift"] },
          { id: "bulk-rice-50kg", name: "Bulk Changbaishan rice 50kg", section: "Rice products", description: "Bulk order for restaurants or group buys.", priceStatus: "listed", amountUsd: "89.00", tags: ["rice", "bulk", "wholesale"] },
        ],
      },
    ],
  },
  "noun-coffee": {
    id: "noun-coffee",
    name: "Noun Coffee",
    category: "coffee ecommerce",
    location: "Marina del Rey",
    geo: { lat: 33.9802, lng: -118.4517 },
    fulfillment: ["shipping", "pickup"],
    paymentRails: ["shopify", "base_usdc", "counter"],
    humanApproval: { requiredAboveUsd: "100.00" },
    menuSections: nounCoffeeInStoreMenu,
    catalog: [
      ...nounCoffeeUberEatsPickupCatalog,
      {
        id: "dalat-highlands",
        name: "Dalat Highlands",
        amountUsd: "32.00",
        fulfillment: ["shipping"],
        shippingDays: 5,
        inventory: 20,
        tags: ["coffee", "beans", "vietnam", "dalat", "highlands", "raspberry", "watermelon", "black tea"],
        productUrl: "https://noun.coffee/products/dalat-highlands",
      },
      {
        id: "block-zero",
        name: "Block Zero",
        amountUsd: "21.00",
        fulfillment: ["shipping"],
        shippingDays: 5,
        inventory: 20,
        tags: ["coffee", "bitcoin", "block", "beans"],
        productUrl: "https://noun.coffee/products/bitcoin-block",
      },
      {
        id: "fridge-cig-hat",
        name: "Fridge Cig Hat",
        amountUsd: "40.00",
        fulfillment: ["shipping"],
        shippingDays: 5,
        inventory: 20,
        tags: ["hat", "merch", "fridge", "cig"],
        productUrl: "https://noun.coffee/products/fridge-cig-hat",
      },
    ],
  },
  "louisa-coffee": {
    id: "louisa-coffee",
    name: "Louisa Coffee",
    category: "cafe",
    location: "Taipei",
    fulfillment: ["pickup"],
    // Taiwan demo: counter pay + LINE Pay prepay-in-flow. Prices are TWD
    // (the amount field is a plain decimal; LINE Pay charges TWD whole units).
    paymentRails: ["counter", "line_pay"],
    humanApproval: { requiredAboveUsd: "1000.00" },
    catalog: [
      { id: "americano", name: "美式咖啡 Americano", amountUsd: "55.00", fulfillment: ["pickup"], productionClass: "espresso", prepMinutes: 4, inventory: 50, tags: ["coffee", "americano", "espresso", "fast"] },
      { id: "latte", name: "拿鐵 Latte", amountUsd: "70.00", fulfillment: ["pickup"], productionClass: "espresso", prepMinutes: 6, inventory: 40, tags: ["coffee", "latte", "milk", "espresso"] },
      { id: "oat-latte", name: "燕麥拿鐵 Oat Latte", amountUsd: "85.00", fulfillment: ["pickup"], productionClass: "espresso", prepMinutes: 6, inventory: 30, tags: ["coffee", "latte", "oat", "milk"] },
      { id: "matcha-latte", name: "抹茶拿鐵 Matcha Latte", amountUsd: "80.00", fulfillment: ["pickup"], productionClass: "cold", prepMinutes: 6, inventory: 25, tags: ["matcha", "latte", "milk"] },
    ],
    menuSections: [
      {
        id: "louisa-pickup-drinks",
        name: "Pickup drinks",
        service: "in_store",
        source: "SLL-R Louisa Taiwan demo menu",
        items: [
          { id: "americano", name: "美式咖啡 Americano", section: "Pickup drinks", description: "Pickup americano.", priceStatus: "listed", amountUsd: "55.00", tags: ["coffee", "americano"] },
          { id: "latte", name: "拿鐵 Latte", section: "Pickup drinks", description: "Pickup latte.", priceStatus: "listed", amountUsd: "70.00", tags: ["coffee", "latte"] },
          { id: "oat-latte", name: "燕麥拿鐵 Oat Latte", section: "Pickup drinks", description: "Oat milk latte.", priceStatus: "listed", amountUsd: "85.00", tags: ["coffee", "oat"] },
          { id: "matcha-latte", name: "抹茶拿鐵 Matcha Latte", section: "Pickup drinks", description: "Matcha latte.", priceStatus: "listed", amountUsd: "80.00", tags: ["matcha"] },
        ],
      },
    ],
  },
};

// Demo merchants ingested at runtime (for example from a public Shopify
// products.json feed). Backed by the durable store so they survive serverless
// cold starts; mirrored into an in-process cache so merchantForId stays sync.
const MAX_DEMO_MERCHANTS = 24;
const DEMO_KEY_PREFIX = "sllr:demo-merchant:";
const DEMO_INDEX = "sllr:demo-merchant-ids";
const demoMerchantProfiles = new Map<string, MerchantProfile>();

function demoKey(merchantId: string) {
  return `${DEMO_KEY_PREFIX}${merchantId}`;
}

// Load persisted demo merchants into the in-process cache. Call once per
// request before any merchantForId lookup so a fresh serverless instance sees
// demo merchants created by an earlier request on another instance. On the
// memory backend the in-process Map is already authoritative (the store lives
// in this same process), so hydration is skipped and adds no per-request cost.
export async function hydrateDemoMerchants() {
  if (storeBackendName() === "memory") return;
  const store = sllrStore();
  const ids = await store.indexMembers(DEMO_INDEX);
  if (ids.length === 0) return;
  const profiles = await Promise.all(ids.map((id) => store.getJson<MerchantProfile>(demoKey(id))));
  for (const profile of profiles) {
    if (!profile) continue;
    if (!demoMerchantProfiles.has(profile.id) && demoMerchantProfiles.size >= MAX_DEMO_MERCHANTS) break;
    demoMerchantProfiles.set(profile.id, profile);
  }
}

export async function registerDemoMerchantProfile(profile: MerchantProfile) {
  if (!profile.id.startsWith("demo-")) {
    throw Object.assign(new Error("Demo merchant ids must start with demo-."), { status: 400 });
  }
  if (merchantProfiles[profile.id]) {
    throw Object.assign(new Error(`Merchant id ${profile.id} is reserved.`), { status: 409 });
  }
  if (!demoMerchantProfiles.has(profile.id) && demoMerchantProfiles.size >= MAX_DEMO_MERCHANTS) {
    throw Object.assign(new Error(`Demo merchant limit reached (${MAX_DEMO_MERCHANTS}). Reuse an existing demo merchant id.`), { status: 409 });
  }
  // Re-registering the same id replaces the profile so a demo can re-ingest a
  // fresher catalog without losing the slot.
  demoMerchantProfiles.set(profile.id, profile);
  const store = sllrStore();
  await store.setJson(demoKey(profile.id), profile);
  await store.addToIndex(DEMO_INDEX, profile.id);
  return profile;
}

export function allMerchantProfiles(): MerchantProfile[] {
  return [...Object.values(merchantProfiles), ...demoMerchantProfiles.values()];
}

export function merchantForId(merchantId: string) {
  return merchantProfiles[merchantId] || demoMerchantProfiles.get(merchantId) || null;
}
