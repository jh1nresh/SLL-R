#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function positiveInteger(value, fallback) {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got ${value}.`);
  }
  return parsed;
}

const url = argument("--url");
const expectedCommit = argument("--expected-commit");
const output = argument("--output");
const attempts = positiveInteger(argument("--attempts"), 20);
const intervalMs = positiveInteger(argument("--interval-ms"), 15_000);

if (!url || !expectedCommit || !output) {
  throw new Error("--url, --expected-commit, and --output are required.");
}
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(url)
  && !/^http:\/\/127\.0\.0\.1:\d+(?:\/.*)?$/.test(url)) {
  throw new Error("Delivery verification requires HTTPS or loopback HTTP.");
}
if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
  throw new Error("Expected commit must be a full lowercase 40-character SHA.");
}

const healthUrl = new URL("/health", url).toString();
const durableStores = new Set(["supabase", "redis_rest"]);
let lastObservation = null;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(healthUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    lastObservation = {
      status: response.status,
      ok: payload?.ok === true,
      product: payload?.product ?? null,
      store: payload?.store ?? null,
      revision: payload?.revision ?? null,
    };

    if (
      response.ok
      && lastObservation.ok
      && lastObservation.product === "SLL-R"
      && durableStores.has(lastObservation.store)
      && lastObservation.revision === expectedCommit
    ) {
      const receipt = {
        contractVersion: "sllr-delivery-receipt/v1",
        product: "SLL-R",
        expectedCommit,
        observedCommit: lastObservation.revision,
        productionUrl: url,
        store: lastObservation.store,
        attempts: attempt,
        checks: {
          serviceIdentity: "passed",
          exactRevision: "passed",
          durableStore: "passed",
          paymentMutation: "not-performed",
          merchantMutation: "not-performed",
        },
        status: "verified",
      };
      await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      console.log(`SLL-R delivery verified at ${expectedCommit}.`);
      process.exit(0);
    }
  } catch (error) {
    lastObservation = {
      error: error instanceof Error ? error.message : String(error),
    };
  }

  console.log(
    `Attempt ${attempt}/${attempts}: production has not converged to ${expectedCommit}.`,
  );
  if (attempt < attempts) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

throw new Error(
  `SLL-R production delivery did not converge: ${JSON.stringify(lastObservation)}`,
);
