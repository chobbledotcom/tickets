import type { Transaction } from "@libsql/client";
import { type Stub, stub } from "@std/testing/mock";
import {
  getDb,
  type StatementClient,
  type StatementTransaction,
} from "#db/client.ts";

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
): Stub<
  StatementClient,
  Parameters<StatementClient["transaction"]>,
  Promise<StatementTransaction>
> => stub(getDb(), "transaction", () => Promise.resolve(tx as Transaction));

/**
 * A Transaction object for tests that drive begin/commit/rollback by hand —
 * name only the members the exercised path calls. The one unsafe cast lives
 * here, not at every call site.
 */
export const transactionStub = (members: Partial<Transaction>): Transaction =>
  members as Transaction;
