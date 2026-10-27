import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryAll } from "#db/client.ts";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import { reserveSession } from "#db/processed-payments.ts";
import {
  createOrLoadRefundAuthority,
  loadRefundAuthorityByReference,
} from "#db/provider-refund-authority.ts";
import { transitionRefundAuthority } from "#db/provider-refund-authority-change.ts";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import {
  armRefundSend,
  returnRefundToReady,
} from "#payment/refund-authority.ts";
import { returnedRefundMoney } from "#payment/resources.ts";
import { initialRefundState } from "#shared/provider-refunds/state.ts";
import { requestProviderRefund } from "#shared/provider-refunds.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  fakeRefundProvider,
  refundDependencies,
} from "#test/shared/provider-refunds/engine-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import { observePaymentSeam } from "#test-utils/payment-seam.ts";
import {
  chargeMoney,
  completedRefund,
  foundCharge,
} from "#test-utils/payment-state.ts";
import {
  bookedWithPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

describeWithEnv("payment proof boundary observer", { db: true }, () => {
  test("records a changed refund generation even after the authority leaves its armed state", async () => {
    const verify = await observePaymentSeam();
    const reference = taggedPaymentReference("pi_changed_generation");
    const attendeeId = await bookedWithPayment(
      "sess_generation",
      reference.reference,
    );
    await claimCurrentAttendeeRows([attendeeId]);
    const charge = chargeMoney();
    const row = await createOrLoadRefundAuthority({
      captured: charge.captured,
      now: 100,
      reference,
      state: await initialRefundState(reference, 100),
    });
    const armed = requireValue(
      await transitionRefundAuthority(
        row,
        100,
        returnedRefundMoney(charge),
        (state) => ({
          ...armRefundSend(state, 100, 200),
          request: {
            ...state.request,
            generation: state.request.generation + 1,
          },
        }),
      ),
      "The test authority did not change",
    );
    await transitionRefundAuthority(
      armed,
      101,
      returnedRefundMoney(charge),
      (state) =>
        returnRefundToReady(state, state.evidenceRevision + 1, 101, 200),
    );

    await expect(verify()).rejects.toThrow("Payment send guard failed");
  });

  test("records an unindexed claim even after its release", async () => {
    const verify = await observePaymentSeam();
    await reserveSession("sess_missing_reference");
    for (const mirror of [CLAIM_MIRROR, ""]) {
      await execute(
        "UPDATE processed_payments SET protected_state = ? WHERE payment_session_id = ?",
        [mirror, "sess_missing_reference"],
      );
    }
    await expect(verify()).rejects.toThrow("Payment claim guard failed");
  });

  test("records a claimed reference that was stripped and restored", async () => {
    const verify = await observePaymentSeam();
    const reference = taggedPaymentReference("pi_stripped_reference");
    const attendeeId = await bookedWithPayment(
      "sess_stripped",
      reference.reference,
    );
    await claimCurrentAttendeeRows([attendeeId]);
    for (const index of ["", await paymentReferenceIndex(reference)]) {
      await execute(
        "UPDATE processed_payments SET payment_reference_index = ? WHERE payment_session_id = ?",
        [index, "sess_stripped"],
      );
    }
    await expect(verify()).rejects.toThrow("Payment claim guard failed");
  });

  test("a callback sends under its durable armed authority before any attendee row exists", async () => {
    const verify = await observePaymentSeam();
    const reference = taggedPaymentReference("pi_callback_before_booking");
    const index = await paymentReferenceIndex(reference);
    const provider = fakeRefundProvider(
      "stripe",
      () => Promise.resolve(foundCharge()),
      async (request) => {
        expect(await loadRefundAuthorityByReference(index)).toMatchObject({
          revision: 2,
          state: { kind: "send_armed" },
        });
        expect(
          await queryAll(
            "SELECT payment_session_id FROM processed_payments WHERE payment_reference_index = ?",
            [index],
          ),
        ).toEqual([]);
        return completedRefund(request.charge);
      },
    );
    expect(
      await requestProviderRefund(
        {
          callbackSessionId: "sess_callback_before_booking",
          evidence: { kind: "read_provider" },
          mode: "send",
          reference,
        },
        refundDependencies(provider),
      ),
    ).toMatchObject({
      kind: "returned",
      local: "due",
      reference,
    });
    await verify();
  });
});
