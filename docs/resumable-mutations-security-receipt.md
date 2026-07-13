# Resumable Mutation Security Receipt

Date: 2026-07-13

Scope: SLL-R merchant runtime mutations for `create_order`, `attach_payment_proof`, and `issue_receipt` through HTTP/MCP merchant APIs.

## What Changed

- Side-effecting merchant mutations can accept `idempotencyKey` or `actionKey`.
- MCP tool calls add the JSON-RPC request id as a fallback action key for older clients.
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
- Redis-backed restart smoke replays the same order and payment receipt after store reinitialization.
- A paid order keeps one canonical receipt when fulfillment is retried later.

## Residual Scope

- Some lower-level webhook adapters still rely on existing order state guards instead of a first-class action ledger record. They remain protected against duplicate terminal receipt issuance, but a future PR should bind provider event ids into the same mutation ledger for fuller replay diagnostics.
- The current store abstraction is upsert-based, not a compare-and-swap transaction. This PR improves retry/restart safety, but high-concurrency duplicate-submit races should be closed with a store-level conditional insert if/when the backend supports it.
