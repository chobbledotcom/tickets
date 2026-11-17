/** Metadata stays independent of the application and lazy proof producers. */

import { assert } from "@std/assert";
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
/** A reduced control is a step control that keeps only the facts its law
 * reads. It declares a scope, and the checker must accept that scope. */
type ControlKind = CheckPhase | "reduced";
type ControlLabel = readonly [name: string, kind: ControlKind];
type ModelDeclaration = Extract<VerificationModule, { kind: "model" }>;

const phaseOf = (kind: ControlKind): CheckPhase =>
  kind === "reduced" ? "step" : kind;

const subscriptionModel = (
  module: string,
  load: () => Promise<Producer>,
  labels: Readonly<Record<string, ControlKind>>,
  context: readonly string[],
): ModelDeclaration => {
  const source = dataFrom(load);
  const entries = Object.entries(labels);
  /** The producer's control of one name, when it agrees with the label. */
  const controlOf = (
    producer: Producer,
    [name, kind]: ControlLabel,
  ): ModelControl => {
    const control = requireValue(
      producer.controls.find((control) => control.name === name),
      `The ${module} model has no ${name} control.`,
    );
    assert(
      control.phase === phaseOf(kind) &&
        (control.scope !== undefined) === (kind === "reduced") &&
        producer.controls.length === entries.length,
      `The ${module} control metadata differs at ${name}.`,
    );
    return control;
  };
  const controlFor = (label: ControlLabel): ModelControl => {
    const [name, kind] = label;
    const control = {
      data: source((producer) => controlOf(producer, label).data),
      name,
      phase: phaseOf(kind),
    };
    if (kind !== "reduced") return control;
    return {
      ...control,
      scope: source((producer) =>
        requireValue(
          controlOf(producer, label).scope,
          `The ${name} control has no scope.`,
        ),
      ),
    };
  };
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
  "extra-recurring-line": "reduced",
  "missing-booking-outcome": "initial",
  "missing-one-time-line": "reduced",
  "missing-refused-outcome": "initial",
  "rewritten-plan-amount": "reduced",
  "unsupported-order-admitted": "reduced",
  "wrong-booking-attribution": "step",
  "wrong-first-invoice-reference": "reduced",
  "wrong-frozen-vat": "reduced",
  "wrong-initial-amount": "reduced",
  "wrong-initial-quantity": "reduced",
  "wrong-invoice-read": "reduced",
  "wrong-ordinary-initial-line": "reduced",
  "wrong-plan-id": "reduced",
  "wrong-plan-interval": "reduced",
  "wrong-plan-status": "reduced",
  "wrong-recurring-amount": "reduced",
  "wrong-recurring-interval": "reduced",
  "wrong-recurring-quantity": "reduced",
  "wrong-recurring-time": "reduced",
  "wrong-request-listing": "reduced",
  "wrong-subscribed-initial-line": "reduced",
  "wrong-subscription-read": "reduced",
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
  "broken-failed-checkout-identity-join": "reduced",
  "corrupt-stored-renewal-vat": "step",
  "duplicate-provider-read": "initial",
  "duplicate-renewal-cash-leg": "reduced",
  "foreign-renewal-currency-accepted": "reduced",
  "missing-provider-read": "initial",
  "missing-renewal-arithmetic": "initial",
  "missing-renewal-attempt": "initial",
  "missing-renewal-currency": "initial",
  "partial-renewal-status-commit": "reduced",
  "replaced-booking-accepted": "reduced",
  "rewritten-joined-plan": "reduced",
  "wrong-exact-renewal-tax": "reduced",
  "wrong-invoice-list-subscription": "reduced",
  "wrong-joined-trial-time": "reduced",
  "wrong-renewal-attendee": "reduced",
  "wrong-renewal-cash": "reduced",
  "wrong-renewal-listing": "reduced",
  "wrong-renewal-paid-time": "reduced",
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
  "cancelled answer on a live row": "step",
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
  "lost-live-plan-delete": "reduced",
  "lost-live-plan-merge": "reduced",
  "lost-live-plan-remove": "reduced",
  "misattributed-projected-booking": "step",
  "missing-required-record-domain": "initial",
  "omitted-quantity-zero-booking": "step",
  "partial-refusal": "reduced",
  "partial-refusal-money": "reduced",
  "wrong-preserved-plan-amount": "reduced",
  "wrong-preserved-plan-identity": "reduced",
  "wrong-preserved-plan-interval": "reduced",
  "wrong-preserved-plan-status": "reduced",
  "wrong-preserved-plan-tax": "reduced",
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

/* jscpd:ignore-start -- a list of strings, not code */
const LIFECYCLE_CONTROLS = {
  "cancelled answer without an end": "step",
  "end before the last renewal": "step",
  "ended row opened again": "step",
  "local end before the Stripe end": "step",
  "missing lifecycle move": "initial",
  "renewal recorded twice": "step",
} as const;
/* jscpd:ignore-end */

/* jscpd:ignore-start -- a list of strings, not code */
const LIFECYCLE_CONTEXT = [
  "scripts/verify-models/subscriptions/lifecycle.ts",
  "scripts/verify-models/subscriptions/lifecycle-facts.ts",
  "scripts/verify-models/subscriptions/lifecycle-run.ts",
  "src/shared/subscriptions/status-check.ts",
  "src/shared/subscriptions/cancellation.ts",
  "src/shared/subscriptions/record.ts",
  "src/shared/subscriptions/plan.ts",
  "src/shared/db/subscriptions.ts",
  "src/shared/payment/subscription-machine-spec.ts",
  "src/features/admin/subscriptions.ts",
] as const;
/* jscpd:ignore-end */

/** The producer of a model is the file of its short name:
 * `SubscriptionRecords` loads `./records.ts`. */
const producerOf = (module: string) => (): Promise<Producer> =>
  import(`./${module.replace("Subscription", "").toLowerCase()}.ts`);

const LABELS: Readonly<Record<string, Readonly<Record<string, ControlKind>>>> =
  {
    SubscriptionCancellation: CANCELLATION_CONTROLS,
    SubscriptionCheckout: CHECKOUT_CONTROLS,
    SubscriptionLifecycle: LIFECYCLE_CONTROLS,
    SubscriptionRecords: RECORD_CONTROLS,
    SubscriptionRenewals: RENEWAL_CONTROLS,
  };
const CONTEXTS: Readonly<Record<keyof typeof LABELS, readonly string[]>> = {
  SubscriptionCancellation: CANCELLATION_CONTEXT,
  SubscriptionCheckout: CHECKOUT_CONTEXT,
  SubscriptionLifecycle: LIFECYCLE_CONTEXT,
  SubscriptionRecords: RECORD_CONTEXT,
  SubscriptionRenewals: RENEWAL_CONTEXT,
};
const contexts: Readonly<Record<string, readonly string[]>> = CONTEXTS;

export const SUBSCRIPTION_MODULES = [
  { context: [], kind: "helper", module: "SubscriptionRules" },
  ...Object.entries(LABELS).map(([module, labels]) =>
    subscriptionModel(
      module,
      producerOf(module),
      labels,
      requireValue(
        contexts[module],
        `The ${module} model has no review context.`,
      ),
    ),
  ),
] as const;
