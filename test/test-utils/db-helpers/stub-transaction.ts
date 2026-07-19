import type { Transaction } from "@libsql/client";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";

/**
 * Replace the guarded client's `transaction` with one that resolves to `tx`,
 * so a test can drive a transaction's begin/commit/rollback deterministically.
 *
 * Returns a disposable `Stub` (use `using`), so the client is restored without
 * a hand-rolled `try/finally`. `spy()` lacks `Symbol.dispose`, so a spy over the
 * stub's call still needs its own explicit cleanup.
 */
export const stubTransaction = (tx: Transaction) =>
  stub(getDb(), "transaction", () => Promise.resolve(tx));
