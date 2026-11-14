/** Metadata stays independent of the application and lazy proof producers. */
import type { ModelDataSource } from "#scripts/verify-models/data.ts";
import {
  type CheckPhase,
  dataFrom,
  type ModelControl,
  type VerificationModule,
} from "#scripts/verify-models/spec.ts";
import { requireValue } from "#shared/required-value.ts";

type Producer = {
  modelData: ModelDataSource;
  controls: readonly ModelControl[];
};
type ControlLabel = readonly [name: string, phase: CheckPhase];
type ModelDeclaration = Extract<VerificationModule, { kind: "model" }>;

const subscriptionModel = (
  module: string,
  load: () => Promise<Producer>,
  labels: Readonly<Record<string, CheckPhase>>,
  context: readonly string[],
): ModelDeclaration => {
  const source = dataFrom(load);
  const entries = Object.entries(labels);
  const controlFor = ([name, phase]: ControlLabel): ModelControl => ({
    data: source((producer) => {
      const control = requireValue(
        producer.controls.find((control) => control.name === name),
        `The ${module} model has no ${name} control.`,
      );
      if (
        control.phase !== phase ||
        producer.controls.length !== entries.length
      ) {
        throw new Error(`The ${module} control metadata differs at ${name}.`);
      }
      return control.data;
    }),
    name,
    phase,
  });
  const [first, ...rest] = entries;
  return {
    context: [
      "verification/ModelRules.tla",
      "verification/SubscriptionRules.tla",
      "scripts/verify-models/subscriptions/environment.ts",
      "scripts/verify-models/subscriptions/controls.ts",
      "scripts/verify-models/data.ts",
      ...context,
    ],
    controls: [
      controlFor(requireValue(first, `The ${module} model has no controls.`)),
      ...rest.map(controlFor),
    ],
    data: source((producer) => producer.modelData),
    kind: "model",
    module,
  };
};

/* jscpd:ignore-start -- a list of strings, not code */
const CHECKOUT_CONTROLS = {
  "extra-recurring-line": "step",
  "missing-booking-outcome": "initial",
  "missing-one-time-line": "step",
  "missing-refused-outcome": "initial",
  "rewritten-plan-amount": "step",
  "unsupported-order-admitted": "step",
  "wrong-booking-attribution": "step",
  "wrong-first-invoice-reference": "step",
  "wrong-frozen-vat": "step",
  "wrong-initial-amount": "step",
  "wrong-initial-quantity": "step",
  "wrong-invoice-read": "step",
  "wrong-ordinary-initial-line": "step",
  "wrong-plan-id": "step",
  "wrong-plan-interval": "step",
  "wrong-plan-status": "step",
  "wrong-recurring-amount": "step",
  "wrong-recurring-interval": "step",
  "wrong-recurring-quantity": "step",
  "wrong-recurring-time": "step",
  "wrong-request-listing": "step",
  "wrong-subscribed-initial-line": "step",
  "wrong-subscription-read": "step",
} as const;
/* jscpd:ignore-end */

/* jscpd:ignore-start -- a list of strings, not code */
const CHECKOUT_CONTEXT = [
  "scripts/verify-models/subscriptions/checkout.ts",
  "scripts/verify-models/subscriptions/checkout-admission.ts",
  "scripts/verify-models/subscriptions/checkout-provider.ts",
  "scripts/verify-models/subscriptions/checkout-storage.ts",
  "scripts/verify-models/subscriptions/checkout-facts.ts",
  "src/shared/subscriptions/checkout-rules.ts",
  "src/shared/subscriptions/booking-plan.ts",
  "src/shared/subscriptions/plan.ts",
  "src/shared/payment/checkout-session.ts",
  "src/shared/stripe.ts",
  "src/shared/stripe-provider.ts",
  "src/shared/stripe/subscription.ts",
  "src/shared/db/attendees/capacity/checks.ts",
  "src/shared/tax/assessment.ts",
] as const;
/* jscpd:ignore-end */

/* jscpd:ignore-start -- a list of strings, not code */
const RENEWAL_CONTROLS = {
  "broken-failed-checkout-identity-join": "step",
  "corrupt-stored-renewal-vat": "step",
  "duplicate-provider-read": "initial",
  "duplicate-renewal-cash-leg": "step",
  "foreign-renewal-currency-accepted": "step",
  "missing-provider-read": "initial",
  "missing-renewal-arithmetic": "initial",
  "missing-renewal-attempt": "initial",
  "missing-renewal-currency": "initial",
  "partial-renewal-status-commit": "step",
  "replaced-booking-accepted": "step",
  "rewritten-joined-plan": "step",
  "wrong-exact-renewal-tax": "step",
  "wrong-invoice-list-subscription": "step",
  "wrong-joined-trial-time": "step",
  "wrong-renewal-attendee": "step",
  "wrong-renewal-cash": "step",
  "wrong-renewal-listing": "step",
  "wrong-renewal-paid-time": "step",
  "wrong-renewal-subscription-read": "step",
} as const;
/* jscpd:ignore-end */

/* jscpd:ignore-start -- a list of strings, not code */
const RENEWAL_CONTEXT = [
  "scripts/verify-models/subscriptions/renewals.ts",
  "scripts/verify-models/subscriptions/renewal-cases.ts",
  "scripts/verify-models/subscriptions/renewal-facts.ts",
  "scripts/verify-models/subscriptions/renewal-observations.ts",
  "scripts/verify-models/subscriptions/journey.ts",
  "scripts/verify-models/subscriptions/cancellation-checkout.ts",
  "scripts/verify-models/subscriptions/cancellation-checkout-fixture.ts",
  "scripts/verify-models/subscriptions/cancellation-support.ts",
  "scripts/verify-models/subscriptions/cancellation-checkout-attempt.ts",
  "scripts/verify-models/subscriptions/checkout-provider.ts",
  "src/shared/subscriptions/record.ts",
  "src/shared/subscriptions/status-check.ts",
  "src/shared/subscriptions/cancellation.ts",
  "src/shared/subscriptions/plan.ts",
  "src/shared/db/subscriptions.ts",
  "src/shared/accounting/mappers.ts",
  "src/shared/accounting/store.ts",
  "src/shared/accounting/rows.ts",
  "src/shared/stripe.ts",
  "src/shared/tax/assessment.ts",
] as const;
/* jscpd:ignore-end */

/* jscpd:ignore-start -- a list of strings, not code */
const CANCELLATION_CONTROLS = {
  "anchorless retry lost its retained plan": "step",
  "cancellation sent to another subscription": "step",
  "duplicate failed checkout refund on replay": "step",
  "ended status overwritten by a stale live write": "step",
  "failed checkout fallback read sent to another subscription": "step",
  "false local refund completion": "step",
  "local end without final returned money": "step",
  "missing owner cancellation evidence": "initial",
  "owner fallback read sent to another subscription": "step",
  "owner invoice read sent to another subscription": "step",
  "refund before confirmed external end": "step",
} as const;
/* jscpd:ignore-end */

/* jscpd:ignore-start -- a list of strings, not code */
const CANCELLATION_CONTEXT = [
  "scripts/verify-models/subscriptions/cancellation.ts",
  "scripts/verify-models/subscriptions/cancellation-facts.ts",
  "scripts/verify-models/subscriptions/cancellation-owner.ts",
  "scripts/verify-models/subscriptions/cancellation-owner-fixture.ts",
  "scripts/verify-models/subscriptions/cancellation-checkout.ts",
  "scripts/verify-models/subscriptions/cancellation-checkout-fixture.ts",
  "scripts/verify-models/subscriptions/cancellation-support.ts",
  "scripts/verify-models/subscriptions/cancellation-checkout-attempt.ts",
  "src/shared/subscriptions/cancellation.ts",
  "src/shared/subscriptions/record.ts",
  "src/shared/subscriptions/plan.ts",
  "src/shared/db/subscriptions.ts",
  "src/features/api/payment-processing/rejected-subscription.ts",
  "src/features/api/payment-processing/placeholder-resume.ts",
  "src/features/api/payment-processing/placeholder-completion.ts",
  "src/features/api/payment-processing/rejected-money.ts",
  "src/shared/accounting/store.ts",
  "src/shared/accounting/mappers.ts",
  "src/shared/payment/refund-authority.ts",
] as const;
/* jscpd:ignore-end */

/* jscpd:ignore-start -- a list of strings, not code */
const RECORD_CONTROLS = {
  "duplicate-projected-booking": "step",
  "lost-live-plan-delete": "step",
  "lost-live-plan-merge": "step",
  "lost-live-plan-remove": "step",
  "misattributed-projected-booking": "step",
  "missing-required-record-domain": "initial",
  "omitted-quantity-zero-booking": "step",
  "partial-refusal": "step",
  "partial-refusal-money": "step",
  "wrong-preserved-plan-amount": "step",
  "wrong-preserved-plan-identity": "step",
  "wrong-preserved-plan-interval": "step",
  "wrong-preserved-plan-status": "step",
  "wrong-preserved-plan-tax": "step",
} as const;
/* jscpd:ignore-end */

/* jscpd:ignore-start -- a list of strings, not code */
const RECORD_CONTEXT = [
  "scripts/verify-models/subscriptions/records.ts",
  "scripts/verify-models/subscriptions/records-facts.ts",
  "scripts/verify-models/subscriptions/records-operations.ts",
  "scripts/verify-models/subscriptions/records-projection.ts",
  "scripts/verify-models/subscriptions/records-observation.ts",
  "src/shared/db/attendees/atomic-update.ts",
  "src/shared/db/attendees/delete.ts",
  "src/shared/db/subscriptions.ts",
  "src/shared/db/payment-admit-move.ts",
  "src/shared/merge/subscription-rows.ts",
  "src/shared/merge/attendee-merge.ts",
  "src/shared/merge/booking-copy.ts",
] as const;
/* jscpd:ignore-end */

const LOADERS = {
  SubscriptionCancellation: () => import("./cancellation.ts"),
  SubscriptionCheckout: () => import("./checkout.ts"),
  SubscriptionRecords: () => import("./records.ts"),
  SubscriptionRenewals: () => import("./renewals.ts"),
};
type ModuleName = keyof typeof LOADERS;

const LABELS: Readonly<
  Record<ModuleName, Readonly<Record<string, CheckPhase>>>
> = {
  SubscriptionCancellation: CANCELLATION_CONTROLS,
  SubscriptionCheckout: CHECKOUT_CONTROLS,
  SubscriptionRecords: RECORD_CONTROLS,
  SubscriptionRenewals: RENEWAL_CONTROLS,
};
const CONTEXTS: Readonly<Record<ModuleName, readonly string[]>> = {
  SubscriptionCancellation: CANCELLATION_CONTEXT,
  SubscriptionCheckout: CHECKOUT_CONTEXT,
  SubscriptionRecords: RECORD_CONTEXT,
  SubscriptionRenewals: RENEWAL_CONTEXT,
};
const labels: Readonly<Record<string, Readonly<Record<string, CheckPhase>>>> =
  LABELS;
const contexts: Readonly<Record<string, readonly string[]>> = CONTEXTS;

export const SUBSCRIPTION_MODULES = [
  { context: [], kind: "helper", module: "SubscriptionRules" },
  ...Object.entries(LOADERS).map(([module, load]) =>
    subscriptionModel(
      module,
      load,
      requireValue(
        labels[module],
        `The ${module} model has no control labels.`,
      ),
      requireValue(
        contexts[module],
        `The ${module} model has no review context.`,
      ),
    ),
  ),
] as const;
