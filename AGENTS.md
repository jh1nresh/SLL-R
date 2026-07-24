# SLL-R Agent Contract

SLL-R is the merchant-side execution rail:

```text
merchant-backed offer
-> exact quote
-> quote-bound consent
-> idempotent order
-> payment proof
-> fulfillment proof
-> canonical receipt
```

Payment proof is never fulfillment proof. Demo merchants are fixtures, not
partnership claims.

## Required Brief

Before editing, record:

- merchant or buyer failure being solved
- acceptance criteria and failure fixture
- feature, repeated loop, or maintenance classification
- demand proof, pricing hypothesis, and first distribution format, or `N/A`
- affected state transitions and authorization boundary
- verification commands
- actions that remain human-controlled

Ambiguous payment, merchant authority, consent, or receipt semantics block
implementation.

## Engineering Loop

- Trigger: one scoped brief or GitHub issue.
- Durable state: issue/PR, tests, and the production delivery receipt.
- Input boundary: repo files plus redacted deterministic fixtures; no customer
  messages, payment credentials, or production payload dumps.
- Maker: engineering agent on an isolated branch.
- Checker: `pnpm check`, dependency audit, review, and post-deploy health check.
- Feedback: a deterministic test, security review, or commit-aware production
  check.
- Artifact: one atomic PR and one `sllr-delivery-receipt.json`.
- Convergence: tests pass and production reports the exact merged commit on a
  durable store.
- Human approval: merge, Vercel settings/deploy changes, merchant onboarding,
  production secrets, payment mode changes, cron activation, live transaction,
  refund, and external messaging.
- Stop: unverifiable merchant data, missing consent, non-idempotent mutation,
  payment/fulfillment conflation, tenant leak, production `memory` store,
  revision mismatch, or three failed repair iterations.

## Verification

Run:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm audit --prod --audit-level high
```

For payment, auth, webhook, merchant mutation, or externally exposed changes,
include a focused security receipt. Raw scanner output is not a confirmed bug
until the reachable path is reproduced or regraded.

## Delivery Boundary

Vercel may deploy merged `main`. GitHub Actions does not initiate that deploy.
After CI succeeds, the delivery workflow polls only `GET /health` until it
observes the exact main commit on `supabase` or `redis_rest`, then uploads a
receipt. The checker must never create sessions, orders, payment attempts,
receipts, cron runs, or merchant mutations.

Never run a production deploy, activate live payments, send outreach, or merge
a PR without explicit user approval at action time.
