# Resumable Mutation Security Receipt

Date: 2026-07-13

Scope: SLL-R merchant runtime mutations for `create_order`, payment proof, and merchant fulfillment through HTTP, MCP, and provider webhook adapters.

## What Changed

- Side-effecting merchant mutations can accept `idempotencyKey` or `actionKey`.
- MCP tool calls add the JSON-RPC request id as a fallback action key for older clients.
- Direct payment adapters use `provider + paymentId` as the fallback action key.
- Direct fulfillment paths use `operation + orderId` when the caller does not provide a key.
- `merchant_fulfill_order`, `POST /orders/:id/fulfill`, and payment adapters now share the same domain-level mutation wrapper as the merchant API.
- The wrapper atomically claims a new action key before executing the mutation:
  - Redis uses `SET ... NX`.
  - Supabase uses the `sllr_kv.key` primary key with `resolution=ignore-duplicates`.
  - The in-process store uses one synchronous check-and-set operation.
- A concurrent identical request waits up to two seconds for the winning result and replays it without executing the mutation again. If the winner is still running, SLL-R returns retryable `idempotency_in_progress`; retrying with the same key remains safe.
- The mutation ledger stores the semantic result for a scoped action:
  - tenant
  - requester
  - operation
  - normalized request hash
  - resource id
  - state metadata
  - proof refs / receipt ref
- Same key + same normalized request returns the original semantic result.
- Same key + different normalized request is rejected with `idempotency_conflict`.

## Trust Boundaries

- Auth and merchant gating stay in existing HTTP/domain APIs.
- Payment and fulfillment proof still require the merchant verifier secret, unless `demo=true` is allowed in local/demo mode.
- The ledger excludes `verificationToken`, `secret`, `token`, and MCP request id from normalized request hashes.
- Discovery tools do not grant mutation permission.

## Verification

Ran:

```bash
pnpm check
```

Coverage added:

- MCP `create_order` retry returns the same order id.
- MCP same action key with different order payload returns `idempotency_conflict`.
- MCP `attach_payment_proof` retry returns the same terminal receipt.
- MCP `issue_receipt` retry returns the same terminal receipt.
- MCP `merchant_fulfill_order` retry returns the same terminal receipt and rejects key reuse for another order.
- HTTP `POST /orders/:id/fulfill` retry returns the same terminal receipt and rejects changed replay data.
- Shopify and generic payment webhook retries return the same receipt and reject changed amounts for the same provider event.
- Redis-backed restart smoke replays the same order and payment receipt after store reinitialization.
- A direct payment adapter replays the same provider event after Redis-backed store reinitialization without requiring a caller-supplied key.
- Concurrent first delivery executes once and replays one result on memory, Redis, and Supabase store paths.
- A completion-ledger write failure after successful business execution leaves the claim pending instead of overwriting it with a false failed result.
- A paid order keeps one canonical receipt when fulfillment is retried later.

## Residual Scope

- Buyer claim still relies on its order-state guard rather than a first-class action-ledger record; it is outside this merchant fulfillment/payment scope.
- A process crash, or a completion-ledger write failure after successful business execution, leaves the action key in `in_progress`. SLL-R intentionally does not auto-steal an abandoned claim because doing so could repeat an external side effect; recovery requires inspecting the target order/payment before resolving the ledger entry.
