import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import {
  loadRefundAuthorityByReference,
  type RefundAuthorityRow,
} from "#shared/db/provider-refund-authority.ts";
import {
  armRefundSend,
  markRefundObservationDue,
} from "#shared/payment/refund-authority.ts";
import { markRefundProviderConflict } from "#shared/payment/refund-authority-choice.ts";
import type { RefundAuthorityState } from "#shared/payment/refund-authority-state.ts";
import {
  observePendingRefund,
  ownerReasonWhenDue,
  REFUND_OBSERVATION_DELAY_MS,
  refundAfterTransition,
  refundAnswerFrom,
  requireCurrentRefund,
  requireMatchingRefundProvider,
} from "#shared/provider-refunds/state.ts";
import type { RefundEngineProvider } from "#shared/provider-refunds.ts";
import {
  notSentRefundProvider,
  refundReference,
} from "#test/shared/provider-refunds/engine-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { chargeMoney, gbp } from "#test-utils/payment-state.ts";
import {
  addProviderRefundTestCase,
  ownerRefundChoiceTestState,
} from "#test-utils/provider-refund-cases.ts";
import { readyRefundForTest } from "#test-utils/refund-authority.ts";

const providerCheckState = (identityIndex: string): RefundAuthorityState =>
  markRefundProviderConflict(
    readyRefundForTest("keyless", { identityIndex }),
    100,
    {
      captured: gbp(2_500),
      kind: "wait",
      refunded: gbp(400),
    },
  );

const storeAndLoad = async (
  rawReference: string,
  state: RefundAuthorityState,
): Promise<RefundAuthorityRow> => {
  const reference = refundReference(rawReference);
  await addProviderRefundTestCase(rawReference, state, reference.provider);
  const row = await loadRefundAuthorityByReference(
    await paymentReferenceIndex(reference),
  );
  if (row === null) throw new Error("Expected a stored refund authority");
  return row;
};

test("pending provider evidence waits five minutes before another check", () => {
  expect(REFUND_OBSERVATION_DELAY_MS).toBe(300_000);
});

test("only the exact provider and its declared capability may use an authority", () => {
  const stripe = notSentRefundProvider("stripe").provider;
  const keyedSumUp = {
    ...stripe,
    type: "sumup",
  } satisfies RefundEngineProvider;

  expect(() =>
    requireMatchingRefundProvider(
      stripe,
      refundReference("square-reference", "square"),
    ),
  ).toThrow("Refund provider does not match its durable identity");
  expect(() =>
    requireMatchingRefundProvider(
      keyedSumUp,
      refundReference("sumup-reference"),
    ),
  ).toThrow("Refund provider does not match its durable identity");
});

test("only due sends escalate to the owner", () => {
  const keyless = armRefundSend(readyRefundForTest("keyless"), 100, 200);
  const keyed = armRefundSend(
    readyRefundForTest("keyed", { replayUntil: 300 }),
    100,
    200,
  );

  expect(ownerReasonWhenDue(keyless, 199)).toBeNull();
  expect(ownerReasonWhenDue(keyless, 200)).toBe("possibly_sent");
  expect(ownerReasonWhenDue(keyed, 200)).toBeNull();
  expect(ownerReasonWhenDue(keyed, 300)).toBeNull();
  expect(ownerReasonWhenDue(keyed, 301)).toBe("replay_window_expired");
});

describeWithEnv("provider refund state contracts", { db: true }, () => {
  test("attention answers preserve the exact stored kind and reason", async () => {
    const ownerReference = refundReference("attention-owner");
    const providerReference = refundReference("attention-provider");
    const owner = await storeAndLoad(
      ownerReference.reference,
      ownerRefundChoiceTestState("owner-request"),
    );
    const providerCheck = await storeAndLoad(
      providerReference.reference,
      providerCheckState("provider-request"),
    );

    expect(refundAnswerFrom(owner, ownerReference)).toEqual({
      authority: {
        id: owner.id,
        referenceIndex: owner.referenceIndex,
        revision: owner.revision,
      },
      kind: "needs_owner_choice",
      reason: "possibly_sent",
      reference: ownerReference,
    });
    expect(refundAnswerFrom(providerCheck, providerReference)).toEqual({
      authority: {
        id: providerCheck.id,
        referenceIndex: providerCheck.referenceIndex,
        revision: providerCheck.revision,
      },
      kind: "needs_provider_check",
      reason: "provider_conflict",
      reference: providerReference,
    });
  });

  test("a transition result wins, while a lost write reloads current state", async () => {
    const reference = refundReference("transition-result");
    const current = await storeAndLoad(
      reference.reference,
      ownerRefundChoiceTestState("transition-request"),
    );
    const changed = { ...current, revision: current.revision + 10 };

    expect(
      await refundAfterTransition(changed, current, reference),
    ).toMatchObject({ authority: { revision: changed.revision } });
    expect(await refundAfterTransition(null, current, reference)).toMatchObject(
      { authority: { revision: current.revision } },
    );
  });

  test("pending evidence advances only send work", async () => {
    const providerReference = refundReference("pending-provider-check");
    const providerCheck = await storeAndLoad(
      providerReference.reference,
      providerCheckState("pending-provider-request"),
    );

    expect(
      await observePendingRefund(chargeMoney())(
        providerCheck,
        500,
        providerReference,
      ),
    ).toMatchObject({
      authority: { revision: providerCheck.revision },
      kind: "needs_provider_check",
    });
    expect((await requireCurrentRefund(providerCheck)).revision).toBe(
      providerCheck.revision,
    );

    const liveCases = [
      {
        reference: refundReference("pending-observing"),
        state: markRefundObservationDue(
          armRefundSend(
            readyRefundForTest("keyless", {
              identityIndex: "observing-request",
            }),
            100,
            200,
          ),
          110,
          200,
        ),
      },
      {
        reference: refundReference("pending-armed"),
        state: armRefundSend(
          readyRefundForTest("keyless", {
            identityIndex: "armed-request",
          }),
          100,
          200,
        ),
      },
    ];
    const advanced = await Promise.all(
      liveCases.map(async ({ reference, state }) => {
        const before = await storeAndLoad(reference.reference, state);
        const answer = await observePendingRefund(chargeMoney())(
          before,
          500,
          reference,
        );
        return { after: await requireCurrentRefund(before), answer, before };
      }),
    );

    expect(advanced).toEqual(
      liveCases.map((_case, index) => ({
        after: expect.objectContaining({
          revision: advanced[index]!.before.revision + 1,
          state: expect.objectContaining({
            kind: "observing",
            nextActionAt: 500 + REFUND_OBSERVATION_DELAY_MS,
          }),
        }),
        answer: expect.objectContaining({
          kind: "pending",
          state: "observing",
        }),
        before: advanced[index]!.before,
      })),
    );
  });
});
