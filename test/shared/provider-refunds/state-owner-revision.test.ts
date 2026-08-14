import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadRefundAuthorityByReference } from "#shared/db/provider-refund-authority.ts";
import { transitionRefundAuthority } from "#shared/db/provider-refund-authority-change.ts";
import { readyRefund } from "#shared/payment/refund-authority.ts";
import { refundRequestIdentityIndex } from "#shared/payment/refund-request-identity.ts";
import {
  type OwnerRecoveryRefundTarget,
  type RefundAuthorityReceipt,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { completedRefund, foundCharge } from "#test-utils/payment-state.ts";
import {
  fakeRefundProvider,
  notSentRefundProvider,
  refundDependencies,
  refundReference,
  sendRefundTarget,
} from "./engine-helpers.ts";

type ReadyAnswer = Extract<
  Awaited<ReturnType<typeof requestProviderRefund>>,
  { kind: "ready" }
>;

const prepareReady = async (raw: string) => {
  const payment = refundReference(raw);
  const dependencies = refundDependencies(
    notSentRefundProvider("sumup").provider,
  );
  const answer = await requestProviderRefund(
    sendRefundTarget(payment),
    dependencies,
  );
  if (answer.kind !== "ready") {
    throw new Error("Expected a ready refund authority");
  }
  return { answer, dependencies, payment };
};

const ownerSendTarget = (
  authority: RefundAuthorityReceipt,
  reference: ReadyAnswer["reference"],
): OwnerRecoveryRefundTarget => ({
  authority: { id: authority.id, revision: authority.revision },
  evidence: { kind: "read_provider" },
  mode: "send",
  reference,
});

describeWithEnv("owner refund revision fences", { db: true }, () => {
  test("a stale owner send cannot touch a newer ready revision", async () => {
    const {
      answer: rendered,
      dependencies,
      payment,
    } = await prepareReady("txn-stale-owner-send");
    const winning = await requestProviderRefund(
      sendRefundTarget(payment),
      dependencies,
    );
    if (winning.kind !== "ready") {
      throw new Error("Expected the newer ready refund authority");
    }
    expect(winning.authority.revision).toBeGreaterThan(
      rendered.authority.revision,
    );
    const before = await loadRefundAuthorityByReference(
      rendered.authority.referenceIndex,
    );
    let loads = 0;
    let reads = 0;
    let sends = 0;
    const staleProvider = fakeRefundProvider(
      "sumup",
      () => {
        reads++;
        return Promise.resolve(foundCharge());
      },
      (request) => {
        sends++;
        return Promise.resolve(completedRefund(request.charge));
      },
    );

    const answer = await requestProviderRefund(
      ownerSendTarget(rendered.authority, payment),
      {
        loadProvider: () => {
          loads++;
          return Promise.resolve(staleProvider);
        },
        now: () => 300,
      },
    );

    expect(answer).toEqual({ kind: "changed", reference: payment });
    expect({ loads, reads, sends }).toEqual({ loads: 0, reads: 0, sends: 0 });
    expect(
      await loadRefundAuthorityByReference(rendered.authority.referenceIndex),
    ).toEqual(before);
  });

  test("an owner send reports a revision won after its provider read", async () => {
    const { answer: prepared, payment } = await prepareReady(
      "txn-owner-send-cas-race",
    );
    const row = await loadRefundAuthorityByReference(
      prepared.authority.referenceIndex,
    );
    if (row === null || row.state.kind !== "ready") {
      throw new Error("Expected the stored ready refund authority");
    }
    const generation = row.state.request.generation + 1;
    const newerState = readyRefund({
      evidenceRevision: row.state.evidenceRevision + 1,
      nextActionAt: 200,
      now: 200,
      request: {
        capability: "keyless",
        generation,
        identityIndex: await refundRequestIdentityIndex(payment, generation),
      },
    });
    let sends = 0;
    const provider = fakeRefundProvider(
      "sumup",
      async () => {
        const changed = await transitionRefundAuthority(
          row,
          200,
          row.refunded,
          () => newerState,
        );
        if (changed === null) throw new Error("The newer revision did not win");
        return foundCharge();
      },
      (request) => {
        sends++;
        return Promise.resolve(completedRefund(request.charge));
      },
    );

    expect(
      await requestProviderRefund(
        ownerSendTarget(prepared.authority, payment),
        refundDependencies(provider),
      ),
    ).toEqual({ kind: "changed", reference: payment });
    expect(sends).toBe(0);
    expect(
      await loadRefundAuthorityByReference(prepared.authority.referenceIndex),
    ).toMatchObject({ state: { request: { generation } } });
  });
});
