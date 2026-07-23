import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { refundCandidateAtProvider } from "#routes/admin/refunds/provider.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { candidateWithReferences } from "#test/features/admin/refunds/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("admin SumUp refund provider", { db: true }, () => {
  test("checks an uncertain refund without submitting it twice", async () => {
    using refund = stub(sumupPaymentProvider, "refundPayment", () =>
      Promise.resolve("pending" as const),
    );
    using status = stub(sumupPaymentProvider, "inspectPaymentRefund", () =>
      Promise.resolve("pending" as const),
    );
    const candidate = candidateWithReferences(["sumup-admin-payment"]);

    const first = await refundCandidateAtProvider(
      sumupPaymentProvider,
      candidate,
      7,
    );
    const second = await refundCandidateAtProvider(
      sumupPaymentProvider,
      candidate,
      7,
    );

    expect(first.outcome).toBe("pending");
    expect(second.outcome).toBe("pending");
    expect(refund.calls).toHaveLength(1);
    expect(status.calls.map((call) => call.args)).toEqual([
      ["sumup-admin-payment"],
    ]);
  });
});
