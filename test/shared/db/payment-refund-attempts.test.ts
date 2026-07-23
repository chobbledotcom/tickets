import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#shared/db/client.ts";
import {
  claimPaymentRefundAttempt,
  releasePaymentRefundAttempt,
} from "#shared/db/payment-refund-attempts.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > payment refund attempts", { db: true }, () => {
  test("claims one provider payment only once without storing its reference", async () => {
    expect(await claimPaymentRefundAttempt("sumup", "secret-reference")).toBe(
      true,
    );
    expect(await claimPaymentRefundAttempt("sumup", "secret-reference")).toBe(
      false,
    );
    const rows = await queryAll<{
      provider: string;
      reference_index: string;
      started_at: string;
    }>(
      "SELECT reference_index, provider, started_at FROM payment_refund_attempts",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe("sumup");
    expect(rows[0]!.reference_index).not.toContain("secret-reference");
    expect(rows[0]!.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("keeps the same reference independent between providers", async () => {
    expect(await claimPaymentRefundAttempt("sumup", "shared-reference")).toBe(
      true,
    );
    expect(await claimPaymentRefundAttempt("stripe", "shared-reference")).toBe(
      true,
    );
    expect(
      await queryAll(
        "SELECT provider FROM payment_refund_attempts ORDER BY provider",
      ),
    ).toEqual([{ provider: "stripe" }, { provider: "sumup" }]);
  });

  test("allows a new claim after an authoritative failure releases it", async () => {
    await claimPaymentRefundAttempt("sumup", "failed-reference");
    await releasePaymentRefundAttempt("sumup", "failed-reference");
    expect(await claimPaymentRefundAttempt("sumup", "failed-reference")).toBe(
      true,
    );
  });
});
