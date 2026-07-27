import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb, queryOne } from "#shared/db/client.ts";
import { resolvePaymentCaseRevision } from "#shared/db/payments/cases.ts";
import { PAYMENT_HISTORY_REDACTION_PAGE_SIZE } from "#shared/db/payments/redaction-page.ts";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  oldPaymentTime,
  recordTestPaymentCase,
  redactedAt,
  seedTerminalPayment,
} from "./payment-redaction-helpers.ts";

const redactedCount = async (): Promise<number> =>
  Number(
    (await queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM payment_sessions WHERE redacted_at IS NOT NULL",
    ))!.count,
  );

describeWithEnv("db > bounded payment redaction", { db: true }, () => {
  test("requests a follow-up and resumes a full keyset page", async () => {
    for (
      let index = 0;
      index < PAYMENT_HISTORY_REDACTION_PAGE_SIZE + 1;
      index += 1
    ) {
      await seedTerminalPayment(`page-${String(index).padStart(2, "0")}`);
    }

    const first = await runDatabasePruning();

    expect(first.fullBatch).toBe(true);
    expect(first.checkpoint).not.toBeNull();
    expect(await redactedCount()).toBe(PAYMENT_HISTORY_REDACTION_PAGE_SIZE);

    const second = await runDatabasePruning(first.checkpoint);

    expect(second.fullBatch).toBe(false);
    expect(second.checkpoint).toBeNull();
    expect(await redactedCount()).toBe(PAYMENT_HISTORY_REDACTION_PAGE_SIZE + 1);
  });

  test("finishes an older session after redacting its case beside a full page", async () => {
    const casePayment = await seedTerminalPayment("case-before-page", {
      createdAt: oldPaymentTime() - 1_000,
    });
    const paymentCase = await recordTestPaymentCase(casePayment);
    expect(
      await resolvePaymentCaseRevision(
        paymentCase.id,
        paymentCase.revision,
        oldPaymentTime(),
      ),
    ).toBe(true);
    for (
      let index = 0;
      index < PAYMENT_HISTORY_REDACTION_PAGE_SIZE;
      index += 1
    ) {
      await seedTerminalPayment(`newer-page-${index}`, {
        createdAt: oldPaymentTime() + 1_000,
      });
    }

    const first = await runDatabasePruning();
    const second = await runDatabasePruning(first.checkpoint);

    expect(first.fullBatch).toBe(true);
    expect(second.fullBatch).toBe(false);
    expect(await redactedAt(casePayment.id)).not.toBeNull();
  });

  test("uses the declared five-call maintenance budget", async () => {
    await seedTerminalPayment("query-budget");
    const client = getDb();
    const execute = client.execute.bind(client);
    const batch = client.batch.bind(client);
    let calls = 0;
    using _execute = stub(client, "execute", (...args) => {
      calls += 1;
      return execute(...args);
    });
    using _batch = stub(client, "batch", (...args) => {
      calls += 1;
      return batch(...args);
    });

    await runDatabasePruning();

    expect(calls).toBe(5);
  });
});
