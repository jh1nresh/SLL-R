# SLL-R go-live checklist — card-on-file + recurring (test → live)

End-to-end checklist to take the **pay-once-then-remembered** card flow and
**recurring orders** from "code merged" to "actually charging". Do **test mode**
first, verify the whole loop, then flip to live.

Two systems:
- **SLL-R** (this repo) — deployed on Vercel at `https://sll-r.vercel.app`. Owns
  payments, the recurring schedule (Vercel Cron), receipts.
- **SAV-E** (`JhiNResH/SAV-E`) — Railway. The iMessage consumer entrance; polls
  SLL-R for pending recurring runs and relays the confirm.

> Secrets live in the Vercel / Railway / Stripe dashboards. Never commit them or
> paste them in chat.

---

## Phase 0 — what's already done (no action)

- Card-on-file off-session charge, run-anchored idempotency, webhook replay
  protection, first-checkout card-save, recurring (confirm-each) + Vercel cron
  schedule — all merged to `main`.
- SAV-E: set/confirm recurring over iMessage, durable buyer-token store, in-process
  notifier — merged to `main`.

Everything below is **configuration**, not code.

---

## Phase 1 — SLL-R env (Vercel · TEST mode)

Vercel → Project (sll-r) → Settings → Environment Variables (scope: Production).

| Var | Value | Why |
|-----|-------|-----|
| `STRIPE_SECRET_KEY` | `sk_test_…` | Already set (test). Confirm it's the **test** key for now. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | From Phase 2. Enables signed webhooks (also kills the `demo=true` bypass). |
| `CRON_SECRET` | a long random string | Gate for `/internal/recurring/sweep`; Vercel Cron sends it as `Authorization: Bearer`. |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | from Supabase | Durable order/subscription store (else memory — unusable on serverless). |

Optional:
- `STRIPE_WEBHOOK_TOLERANCE_SEC` — leave unset (defaults 300s). Set `0` only to
  replay historical dashboard events.

After editing env → **Redeploy** (env changes need a fresh deploy).

> The Vercel Cron (`*/15`) is already in `vercel.json`. Sub-daily cron needs a
> **Vercel Pro** plan; on Hobby it runs at most daily (or trigger the sweep from
> an external scheduler — see Phase 5).

---

## Phase 2 — Stripe webhook (dashboard · TEST mode)

Stripe Dashboard (toggle **Test mode** on) → Developers → Webhooks → **Add endpoint**.

1. **Endpoint URL**: `https://sll-r.vercel.app/webhooks/stripe`
2. **Events to send** (exactly these three):
   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `setup_intent.succeeded`
3. **Add endpoint** → copy the **Signing secret** (`whsec_…`) → paste into
   `STRIPE_WEBHOOK_SECRET` (Phase 1) → redeploy.

Sanity: the endpoint's "Send test event" for `setup_intent.succeeded` should
return **200**.

---

## Phase 3 — SAV-E env (Railway)

Railway → SAV-E service → Variables.

| Var | Value | Why |
|-----|-------|-----|
| `SLLR_API_BASE` | `https://sll-r.vercel.app` | Default; set explicitly if different. |
| `SENDBLUE_*` | from Sendblue | iMessage send/receive (existing bot). |
| `SLLR_DEFAULT_MERCHANT` | e.g. `raposa-coffee` | Fallback merchant when no location. |
| `SLLR_DEFAULT_TZ` | e.g. `America/Los_Angeles` | Recurring schedule tz (no per-user tz yet). |
| `SLLR_RECURRING_MAX_USD` | e.g. `20.00` | Per-run spend cap for SAV-E-created subscriptions. |
| `SLLR_NOTIFY_INTERVAL_MS` | `300000` (or `0` to disable) | In-process notifier poll interval. |

Postgres (existing `DATABASE_URL` / pool) must be reachable — the buyer-token +
notified-run tables auto-create on boot (`ensureSendblueTable`). Redeploy.

---

## Phase 4 — end-to-end verification (TEST mode)

Use a Stripe **test card** (`4242 4242 4242 4242`, any future expiry / CVC).

### 4a. Card saves on the first checkout (the core unlock)
```bash
BASE=https://sll-r.vercel.app
# 1) buyer session
S=$(curl -s -X POST $BASE/buyer/session -H 'content-type: application/json' -d '{"label":"golive test"}')
TOKEN=$(echo "$S" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
# 2) buyer-bound order
O=$(curl -s -X POST $BASE/merchants/raposa-coffee/orders -H 'content-type: application/json' \
     -H "authorization: Bearer $TOKEN" \
     -d '{"userIntent":"cold brew in 10 minutes","deadlineMinutes":10,"paymentMode":"checkout"}')
OID=$(echo "$O" | python3 -c 'import sys,json;print(json.load(sys.stdin)["order"]["id"])')
# 3) get the Stripe Checkout link
curl -s -X POST $BASE/merchants/raposa-coffee/payment-options -H 'content-type: application/json' \
     -d "{\"orderId\":\"$OID\"}" | python3 -m json.tool
```
- [ ] Open the `checkout_url`, pay with the test card.
- [ ] Stripe dashboard → the webhook delivered `checkout.session.completed` **200**.
- [ ] Receipt issued: `curl -s $BASE/buyer/orders -H "authorization: Bearer $TOKEN"`
      shows the order `receipt_issued`.
- [ ] **Card saved**: a second order then pays with no link:
```bash
O2=$(curl -s -X POST $BASE/merchants/raposa-coffee/orders -H 'content-type: application/json' \
      -H "authorization: Bearer $TOKEN" \
      -d '{"userIntent":"cold brew in 10 minutes","deadlineMinutes":10,"paymentMode":"checkout"}')
OID2=$(echo "$O2" | python3 -c 'import sys,json;print(json.load(sys.stdin)["order"]["id"])')
curl -s -X POST $BASE/buyer/pay -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d "{\"orderId\":\"$OID2\"}"
# expect: {"status":"paid", ...}
```

### 4b. Recurring (manual, no waiting for cron)
```bash
# create a subscription due immediately-ish, then drive the sweep
curl -s -X POST $BASE/buyer/recurring -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' \
     -d '{"merchantId":"raposa-coffee","template":{"userIntent":"cold brew in 10 minutes","deadlineMinutes":10},"schedule":{"daysOfWeek":[0,1,2,3,4,5,6],"hour":8,"minute":0,"tz":"America/Los_Angeles"},"maxPerRunUsd":"15.00"}'
# trigger the sweep manually (same secret as CRON_SECRET)
curl -s -X POST $BASE/internal/recurring/sweep -H "x-sllr-cron-secret: <CRON_SECRET>"
# list the pending confirm prompt
curl -s $BASE/buyer/recurring/runs -H "authorization: Bearer $TOKEN" | python3 -m json.tool
# confirm it → charges the saved card
RID=$(curl -s $BASE/buyer/recurring/runs -H "authorization: Bearer $TOKEN" | python3 -c 'import sys,json;r=json.load(sys.stdin)["runs"];print(r[0]["id"] if r else "")')
curl -s -X POST $BASE/buyer/recurring/confirm -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d "{\"runId\":\"$RID\"}"
# expect: {"status":"charged","order":{...}}
```
- [ ] sweep returns `created >= 1`
- [ ] pending run listed
- [ ] confirm returns `charged` + a receipt

> Note: a freshly-created subscription's `nextRunAt` is the next future slot, so
> the manual `sweep` above may report `created: 0` until that time. To force a due
> run for testing, create the subscription with a `schedule` time a minute ahead,
> or wait for the slot.

### 4c. iMessage loop (SAV-E)
- [ ] Text the SAV-E number: order something → reply offers "🔁 want this regularly?"
- [ ] "每天早上 8點 cold brew" → "🔁 Set!" (mentions card if not yet saved)
- [ ] After the notifier interval (or your manual sweep), you receive "order your usual?"
- [ ] Reply "confirm my usual" → "✅ Done — ordered …"

---

## Phase 5 — go LIVE (real money)

Only after Phase 4 passes in test mode.

1. Swap `STRIPE_SECRET_KEY` → `sk_live_…` on Vercel.
2. Stripe Dashboard in **Live mode** → recreate the webhook (Phase 2); the **live**
   signing secret differs → update `STRIPE_WEBHOOK_SECRET` → redeploy.
3. (If Vercel Hobby) point an external scheduler at
   `GET https://sll-r.vercel.app/internal/recurring/sweep` with
   `Authorization: Bearer <CRON_SECRET>` at your desired cadence.
4. Re-run Phase 4 with a **real card and a small amount** once, then refund it.

---

## Known limitations (track separately)
- SAV-E notifier is **in-process** (assumes one Railway instance). Multi-instance →
  move the sweep to one worker / external cron. Duplicate **sends** are already
  prevented by the `markNotified` dedup; only extra SLL-R polls would occur.
- No per-user timezone in SAV-E — recurring uses `SLLR_DEFAULT_TZ`.
- `over_cap` / `declined` recurring runs leave an uncharged `pending_payment`
  order (harmless; cleanup is a follow-up).

## Quick reference — endpoints
| Method | Path | Auth |
|--------|------|------|
| POST | `/buyer/session` | — |
| POST | `/merchants/:id/orders` | `Bearer <buyer>` (binds order) |
| POST | `/merchants/:id/payment-options` | — (returns Checkout link) |
| POST | `/buyer/pay` | `Bearer <buyer>` (saved-card charge) |
| POST/GET/DELETE | `/buyer/recurring[...]` | `Bearer <buyer>` |
| POST | `/buyer/recurring/confirm` | `Bearer <buyer>` |
| GET/POST | `/internal/recurring/sweep` | `Bearer <CRON_SECRET>` or `x-sllr-cron-secret` |
| POST | `/webhooks/stripe` | Stripe signature (`whsec_`) |
