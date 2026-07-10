# SLL-R Merchant Journey Landing

## PM Gate

- **Customer-paid job:** let a merchant understand, in under one minute, how SLL-R turns a customer message into a fulfilled order and reusable proof.
- **Demand proof:** outreach needs a merchant-readable demo before asking stores to pilot the iMessage flow.
- **Pricing hypothesis:** the landing does not claim a price. The pilot CTA validates merchant interest before a paywall is introduced.
- **Distribution format:** a direct `/world` link plus a short screen recording for merchant outreach.
- **Classification:** one public campaign route, not a replacement for the merchant terminal or agent runtime.
- **Security receipt:** low-risk read-only surface. Generated media is served from an exact filename allowlist; no auth, order, payment, webhook, or persistence behavior changes.

## Scope

Build a three-scene, scroll-scrubbed journey at `/world`:

1. **Intent:** scan the merchant QR and state budget, taste, and timing in iMessage.
2. **Fulfillment:** SLL-R recommends from the live menu and keeps customer and merchant status in sync.
3. **Proof:** completed payment and pickup become verified receipt memory.

The final scene links to the existing Raposa customer agent and merchant terminal. Desktop uses 1080p clips; mobile uses 720p, tighter-GOP variants. Reduced-motion visitors receive still-image crossfades without video downloads.

## Visual Direction

- Soft matte-clay diorama, isometric camera, warm practical light.
- One coherent miniature coffee shop world across all scenes.
- SLL-R palette: paper `#fbfaf6`, ink `#17251f`, forest `#0f4a35`, gold `#c78c2f`, red `#a3372d`, mint `#edf4f0`.
- HTML carries the readable product copy. Generated marks outside the focal scene are occluded by the solid copy band; no generated QR payload is treated as functional.

## Acceptance

- `/world` renders the complete journey and keeps the existing `/` discovery response unchanged.
- Desktop and mobile asset sources are declared for all three scenes and two connectors.
- Route and scene controls are keyboard accessible and expose current state.
- `prefers-reduced-motion` avoids clip loading and animated decoration.
- Unknown `/world/assets/*` filenames return `404`.
- `pnpm check` passes.
- Desktop and mobile screenshots plus a dynamic scroll receipt show nonblank media, stable copy, working scene changes, and no incoherent overlap.

## Asset Budget

- 3 generated scene stills.
- 3 scene dive preview clips derived from the generated stills.
- 2 connector preview clips built from the adjacent clips' actual endpoint frames.
- Do not exceed this budget without explicit approval.

Higgsfield `seedance_2_0` was costed at 17.5 credits per 720p/5s job while the selected free workspace had 10 credits. The preview therefore uses local, replaceable MP4s rather than silently exceeding the available balance. The route keeps stable filenames so AI video can replace the preview clips later without a code change.
