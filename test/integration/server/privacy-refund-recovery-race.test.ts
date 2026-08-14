/** The rendered owner decision stays fenced through the provider engine. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { queryOne } from "#shared/db/client.ts";
import { refundRequestIdentityIndex } from "#shared/payment/refund-request-identity.ts";
import { requestProviderRefund } from "#shared/provider-refunds.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { chargeMoney, foundCharge } from "#test-utils/payment-state.ts";
import {
  addProviderRefundTestCase,
  readyRefundTestState,
} from "#test-utils/provider-refund-cases.ts";
import { adminGet } from "#test-utils/session.ts";
import {
  expectStaleProviderCheckRefused,
  refundCasePath,
} from "./privacy-refund-recovery-helpers.ts";

interface StoredReadyRevision {
  readonly refund_revision: number;
  readonly refund_state: string;
}

const storedReadyRevision = (id: number): Promise<StoredReadyRevision | null> =>
  queryOne<StoredReadyRevision>(
    "SELECT refund_revision, refund_state FROM payment_charges WHERE id = ?",
    [id],
  );

describeWithEnv("owner refund HTTP revision fence", { db: true }, () => {
  test("a stale ready form cannot send after a newer revision wins", async () => {
    const rawReference = "owner-stale-ready-reference";
    const reference = {
      kind: "tagged",
      provider: "sumup",
      reference: rawReference,
    } as const;
    const identity = await refundRequestIdentityIndex(reference, 1);
    const id = await addProviderRefundTestCase(
      rawReference,
      readyRefundTestState(identity),
    );
    const rendered = await adminGet(refundCasePath(id));
    expect(await rendered.text()).toContain(
      'name="revision" type="hidden" value="1"',
    );

    {
      using read = stub(sumupPaymentProvider, "readCharge", () =>
        Promise.resolve(foundCharge(chargeMoney(2_500))),
      );
      using send = stub(sumupPaymentProvider, "refundCharge", () =>
        Promise.resolve({ kind: "not_sent", reason: "not_configured" }),
      );
      expect(
        await requestProviderRefund({
          evidence: { kind: "read_provider" },
          mode: "send",
          reference,
        }),
      ).toMatchObject({ kind: "ready" });
      expect(read.calls).toHaveLength(1);
      expect(send.calls).toHaveLength(1);
    }

    const before = await storedReadyRevision(id);
    expect(before?.refund_revision).toBeGreaterThan(1);
    await expectStaleProviderCheckRefused(id, before, () =>
      storedReadyRevision(id),
    );
  });
});
