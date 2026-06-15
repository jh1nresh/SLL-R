# Spec — SLL-R recurring orders (confirm-each)

> Status: BUILT (this PR). Deployed: NO — needs CRON_SECRET + Stripe webhook live first.

## Goal
A buyer saves a "usual" + a weekly schedule. SLL-R **asks before each order**
(confirm-each); on "yes" it creates the order and charges the saved card
off-session. Builds directly on card-on-file (off_session charge is the engine).

## Locked decisions
- **Schedule owner = SLL-R** (Vercel Cron). Recurring is a rail capability, so any
  entrance (SAV-E / direct API / other agents) gets it. SLL-R opens the prompt;
  the buyer's channel relays it.
- **Charge model = confirm-each.** Nothing is charged without an explicit per-run
  human confirm. (Rejected: fully unattended; cancel-window — kept simple for v1.)
- **Notification = poll-based v1.** SLL-R exposes pending runs; SAV-E's own cron
  polls + messages the user. No outbound callback/push surface in v1.

## Flow
```
buyer sets recurring  ──>  POST /buyer/recurring {merchantId, template, schedule, maxPerRunUsd}
Vercel Cron (*/15)    ──>  GET /internal/recurring/sweep  (CRON_SECRET)
   sweep: due subs ──> open RecurringRun(awaiting_confirm, expires +2h), advance nextRunAt
SAV-E cron polls      ──>  GET /buyer/recurring/runs  ──> iMessage "order your usual? yes/no"
buyer: yes            ──>  POST /buyer/recurring/confirm {runId}
   confirm: createOrder(template) ──> cap check (<= maxPerRunUsd) ──> payWithSavedCard (off_session)
                                  ──> charged + receipt memory
buyer: no             ──>  POST /buyer/recurring/decline {runId}
```

## Surfaces
- REST: `POST/GET /buyer/recurring`, `DELETE /buyer/recurring/:id`,
  `GET /buyer/recurring/runs`, `POST /buyer/recurring/confirm|decline`,
  `GET|POST /internal/recurring/sweep` (secret-gated).
- MCP: `create_recurring`, `list_recurring`, `cancel_recurring`,
  `list_pending_recurring`, `confirm_recurring`.
- Order responses carry `suggestRecurring` (the "SLL-R asks" hint).

## Payment-safety
- Per-run hard cap `maxPerRunUsd`; an order above it → `over_cap`, never charged.
- Confirm prompts expire (2h) → a stale yes can't charge late.
- Run-level idempotency: a charged run re-confirms to `already_done` (no double).
- Off-session charge keeps its own idempotency key (= order id) from card-on-file.
- No card → `no_card`; SCA → `requires_action`; decline → `declined` → caller
  falls back to a hosted Checkout link.
- Sweep is secret-gated (CRON_SECRET / SLLR_CRON_SECRET).

## Data (KV store)
- `sllr:subscription:<id>` BuyerSubscription {buyerId, merchantId, template,
  schedule{daysOfWeek,hour,minute,tz}, maxPerRunUsd, status, nextRunAt, lastRunAt}
- `sllr:buyer-subs:<buyerId>`, `sllr:subscriptions:active` (indexes)
- `sllr:recurring-run:<id>` RecurringRun {subscriptionId, status, orderId, expiresAt, ...}
- `sllr:buyer-runs:<buyerId>`, `sllr:recurring-runs:pending` (indexes)

## Go-live TODO (not in this PR)
1. Set `CRON_SECRET` (or `SLLR_CRON_SECRET`) on Vercel; sub-daily cron needs Pro plan.
2. Stripe webhook live (shared with card-on-file) for card binding + receipts.
3. SAV-E: poll `GET /buyer/recurring/runs`, message the user, relay yes→confirm;
   surface `suggestRecurring` after an order.
