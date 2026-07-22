import type { Client, Transaction } from "@libsql/client";
import { type Stub, stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";

/**
 * Replace the guarded client's `transaction` with one that resolves to `tx`,
 * so a test can drive a transaction's begin/commit/rollback deterministically.
 *
 * Accepts a `Partial<Transaction>`: tests pass only the methods they care about,
 * and the one unsafe cast lives here rather than at every call site. Returns a
 * disposable `Stub` (use `using`), so the client is restored without a
 * hand-rolled `try/finally`. `spy()` lacks `Symbol.dispose`, so a spy over the
 * stub's call still needs its own explicit cleanup.
 */
export const stubTransaction = (
  tx: Partial<Transaction>,
): Stub<Client, Parameters<Client["transaction"]>, Promise<Transaction>> =>
  stub(getDb(), "transaction", () =>
    Promise.resolve(tx as unknown as Transaction),
  );
