/** Run exported production rejected-session and placeholder completion tails. */
import type { SessionRejection } from "#payment/validated-session.ts";
import {
  type CheckoutCase,
  checkoutPasses,
  configureCheckoutAttempt,
  executeCheckoutAttempt,
  removeCheckoutAnchor,
  seedCheckoutDisposition,
  tamperCheckoutReadback,
} from "#scripts/verify-models/subscriptions/cancellation-checkout-attempt.ts";
import {
  CHECKOUT_SESSION,
  type CheckoutProbe,
  checkoutMetadata,
  checkoutPublicKey,
  checkoutReadback,
  checkoutReference,
  checkoutStart,
  seedCheckout,
  withCheckoutProvider,
} from "#scripts/verify-models/subscriptions/cancellation-checkout-fixture.ts";
import type {
  CancellationFacts,
  CancellationFault,
} from "#scripts/verify-models/subscriptions/cancellation-facts.ts";
import {
  cancellationProbeFacts,
  cancellationRefusalCases,
} from "#scripts/verify-models/subscriptions/cancellation-support.ts";
import {
  MODEL_TIME,
  withSubscriptionDb,
} from "#scripts/verify-models/subscriptions/environment.ts";
import {
  type SubscriptionStart,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";

const checkoutRejection = (
  sample: CheckoutCase,
  start: SubscriptionStart,
): SessionRejection => {
  const fields = {
    createdAt: MODEL_TIME,
    metadata: checkoutMetadata(sample.shape ?? "valid"),
    provider: "stripe" as const,
    sessionId: CHECKOUT_SESSION,
    subscription: start,
  };
  return sample.blankReference
    ? { ...fields, reason: "blank_reference" }
    : {
        ...fields,
        paymentReference: checkoutReference.reference,
        reason: "malformed_charge",
        refundable: true,
      };
};

type CheckoutDelivery = {
  sample: CheckoutCase;
  start: SubscriptionStart;
  rejection: SessionRejection;
  fault: CancellationFault;
  onAttempt:
    | ((fact: CancellationFacts["checkouts"][number]) => Promise<void>)
    | undefined;
};

const deliverCheckoutAttempts = async (
  delivery: CheckoutDelivery,
  probe: CheckoutProbe,
): Promise<CancellationFacts["checkouts"]> => {
  const { sample, start, rejection, fault, onAttempt } = delivery;
  const facts: CancellationFacts["checkouts"] = [];
  for (let attempt = 1; attempt <= checkoutPasses(sample); attempt++) {
    configureCheckoutAttempt(sample, attempt, probe);
    const entrypoint =
      sample.placeholder && attempt === 2 ? "placeholder" : "rejected";
    const result = await executeCheckoutAttempt(
      sample,
      attempt,
      rejection,
      entrypoint,
    );
    await tamperCheckoutReadback(sample, attempt, fault);
    const fact = await factFor(
      sample,
      attempt,
      entrypoint,
      start,
      probe,
      result.threw,
      result.refunded,
    );
    facts.push(fact);
    await onAttempt?.(fact);
    await removeCheckoutAnchor(sample, attempt);
  }
  return facts;
};

export const checkoutCase = (
  sample: CheckoutCase,
  publicKey: string,
  fault: CancellationFault,
  onAttempt?: (fact: CancellationFacts["checkouts"][number]) => Promise<void>,
): Promise<CancellationFacts["checkouts"]> =>
  withSubscriptionDb(async () => {
    await seedCheckout(publicKey);
    await seedCheckoutDisposition(sample);
    const start = sample.observedStart ?? checkoutStart(sample.start);
    const rejection = checkoutRejection(sample, start);
    const activeFault =
      sample.scenario === "retry" ||
      (sample.scenario === "read-ended" &&
        fault === "wrong-checkout-subscription-read")
        ? fault
        : "none";
    return withCheckoutProvider(start, activeFault, (probe) =>
      deliverCheckoutAttempts(
        { fault, onAttempt, rejection, sample, start },
        probe,
      ),
    );
  });

const factFor = async (
  sample: CheckoutCase,
  attempt: number,
  entrypoint: string,
  start: SubscriptionStart,
  probe: CheckoutProbe,
  threw: boolean,
  refunded: boolean,
): Promise<CancellationFacts["checkouts"][number]> => ({
  ...cancellationProbeFacts(probe),
  attempt,
  scenario: sample.scenario,
  ...(await checkoutReadback(start)),
  chargeNamed: !sample.blankReference,
  confirmed: probe.confirmed,
  disposition:
    sample.protected ??
    (sample.shape === "foreign"
      ? "foreign"
      : sample.shape === "unreadable"
        ? "unreadable"
        : "failed"),
  endOrder: probe.endOrder,
  entrypoint,
  heldAtCancel: probe.heldAtCancel,
  observed: probe.providerStatus,
  owned: sample.shape !== "foreign",
  paymentReference: sample.blankReference ? "" : checkoutReference.reference,
  planAtCancel: probe.planAtCancel,
  refundBeforeEnd: probe.refundBeforeEnd,
  refunded,
  refundOrder: probe.refundOrder,
  refunds: probe.refunds,
  sessionId: CHECKOUT_SESSION,
  signedOrder: sample.shape !== "unreadable" && sample.shape !== "foreign",
  start: start.status,
  subscriptionId: start.id,
  threw,
});

export const checkoutFacts = async (
  fault: CancellationFault,
): Promise<CancellationFacts["checkouts"]> => {
  const key = await checkoutPublicKey();
  const cases: CheckoutCase[] = [
    { retry: true, scenario: "retry" },
    { placeholder: true, scenario: "placeholder" },
    { interruption: true, scenario: "ledger-interrupted" },
    { cancelRefused: true, scenario: "read-ended" },
    ...cancellationRefusalCases("both", {
      cancelRefused: true,
      readRefused: true,
    }),
    { scenario: "already-ended", start: "canceled" },
    { scenario: "unreadable", shape: "unreadable" },
    { scenario: "foreign", shape: "foreign" },
    { blankReference: true, scenario: "blank-reference" },
    ...(["booked", "orphaned", "occupied", "anchorless"] as const).map(
      (protectedCase) => ({
        protected: protectedCase,
        scenario: protectedCase,
      }),
    ),
    ...SubscriptionStatusSchema.options.map((status) => ({
      scenario: `failed-start-${status}`,
      start: status,
    })),
    ...SubscriptionStatusSchema.options.map((status) => ({
      end: status,
      scenario: `failed-end-${status}`,
    })),
  ];
  const facts: CancellationFacts["checkouts"] = [];
  for (const sample of cases)
    facts.push(...(await checkoutCase(sample, key, fault)));
  return facts;
};
