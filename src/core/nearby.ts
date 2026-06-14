import { allMerchantProfiles } from "../merchants/profiles.js";

// Location-aware merchant lookup. Merchants carry an optional geo {lat,lng};
// this ranks the ones near a point by great-circle distance. Online-only
// merchants (no geo) are excluded from nearby results.

export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type NearbyMerchant = {
  id: string;
  name: string;
  category: string;
  location: string;
  geo: { lat: number; lng: number };
  distanceKm: number;
};

export function nearbyMerchants(
  lat: number,
  lng: number,
  opts: { radiusKm?: number; category?: string; limit?: number } = {},
): NearbyMerchant[] {
  const radiusKm = opts.radiusKm ?? 15;
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 25);
  const out: NearbyMerchant[] = [];
  for (const m of allMerchantProfiles()) {
    if (!m.geo) continue;
    if (opts.category && m.category !== opts.category) continue;
    const d = distanceKm(lat, lng, m.geo.lat, m.geo.lng);
    if (d <= radiusKm) {
      out.push({
        id: m.id,
        name: m.name,
        category: m.category,
        location: m.location,
        geo: m.geo,
        distanceKm: Math.round(d * 10) / 10,
      });
    }
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm);
  return out.slice(0, limit);
}
