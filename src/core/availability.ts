import { sllrStore } from "./store.js";

// Per-merchant item availability — lets a merchant "86" a sold-out item from the
// Agent POS. Default is available; we only persist the set of UNavailable item
// ids per merchant. Order creation checks this so an 86'd item can't be ordered.

function key(merchantId: string): string {
  return `sllr:avail:${merchantId}`;
}

export async function getUnavailableItems(merchantId: string): Promise<string[]> {
  return (await sllrStore().getJson<string[]>(key(merchantId))) ?? [];
}

export async function isItemAvailable(merchantId: string, itemId: string): Promise<boolean> {
  return !(await getUnavailableItems(merchantId)).includes(itemId);
}

// Mark an item available/unavailable. Returns the current unavailable list.
export async function setItemAvailability(
  merchantId: string,
  itemId: string,
  available: boolean,
): Promise<string[]> {
  const unavailable = new Set(await getUnavailableItems(merchantId));
  if (available) unavailable.delete(itemId);
  else unavailable.add(itemId);
  const next = [...unavailable];
  await sllrStore().setJson(key(merchantId), next);
  return next;
}
