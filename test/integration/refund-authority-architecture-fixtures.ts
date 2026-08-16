export const REFUND_AUTHORITY_ARCHITECTURE_FILES = new Set([
  "integration/refund-authority-architecture-fixtures.ts",
  "integration/refund-authority-architecture.test.ts",
  // Names the clearers as lifecycle data for the binding property, without
  // touching the authority entry points themselves.
  "shared/payment/refund-machine-spec/graph.test.ts",
]);

const AUTHORITY_BUILDING_MARKERS = [
  /\bProviderRefundResult\b/,
  /\bRefundAuthorityReceipt\b/,
  /\badmitObservedRefund\b/,
  /\brefundCharge\b/,
] as const;

const AUTHORITY_RESULT_KINDS = [
  "needs_owner_choice",
  "needs_provider_check",
  "pending",
  "ready",
  "returned",
  "unchanged",
  "wait",
  "withheld",
] as const;

export const couldBuildRefundAuthority = (code: string): boolean =>
  AUTHORITY_BUILDING_MARKERS.some((marker) => marker.test(code)) ||
  AUTHORITY_RESULT_KINDS.filter((kind) =>
    new RegExp(`kind:\\s*["']${kind}["']`).test(code),
  ).length >= 4;

export const PARALLEL_AUTHORITY_FORMS = [
  `type RequestRefund = typeof requestProviderRefund;
   const duplicate: RequestRefund = async (target, dependencies) => {
     const provider = await dependencies.loadProvider(target.reference.provider);
     await provider.refundCharge(request);
     return target.mode === "send"
       ? { authority, kind: "returned", local: "due", reference: target.reference }
       : { authority, kind: "pending", state: "observing", reference: target.reference };
   };`,
  `const duplicate = async (target, dependencies) => {
     const provider = await dependencies.loadProvider(target.reference.provider);
     await provider.refundCharge(request);
     if (target.mode === "send") return { authority, kind: "ready", reference: target.reference };
     return { kind: "unchanged", reference: target.reference };
   };`,
  `async function duplicate(target, dependencies) {
     const provider = await dependencies.loadProvider(target.reference.provider);
     await provider.refundCharge(request);
     return { authority, kind: "needs_owner_choice", reason: "possibly_sent", reference: target.reference };
   }`,
  `const dependencies = {
     request: async (target, engine) => {
       const provider = await engine.loadProvider(target.reference.provider);
       await provider.refundCharge(request);
       return { admission, kind: "withheld", reference: target.reference };
     },
   };`,
] as const;

const AMBIENT_REFUND_PROVIDER_MARKERS = [
  /\bgetActivePaymentProvider\b/,
  /\bgetPaymentProviderForExistingPayments\b/,
  /\bexistingPaymentProviderState\b/,
  /\borderedCredentialedPaymentProviderTypes\b/,
  /\bloadPaymentProvider\b/,
  /#shared\/(?:square|stripe|sumup)-provider\.ts/,
] as const;

export const couldChooseAmbientRefundProvider = (code: string): boolean =>
  AMBIENT_REFUND_PROVIDER_MARKERS.some((marker) => marker.test(code));

export const AMBIENT_REFUND_PROVIDER_FORMS = [
  "await getPaymentProviderForExistingPayments()",
  "await getActivePaymentProvider()",
  "existingPaymentProviderState().provider",
  "orderedCredentialedPaymentProviderTypes().map(loadPaymentProvider)",
  "await loadPaymentProvider(reference.provider)",
  'import { stripePaymentProvider } from "#shared/stripe-provider.ts"',
] as const;

export const TEST_AUTHORITY_BUILDING_PATHS = [
  "features/admin/attendee-refunds/authorization.test.ts",
  "features/admin/refunds/attempt/outcomes.test.ts",
  "features/admin/refunds/attempt/unrecorded.test.ts",
  "features/admin/refunds/provider/helpers.ts",
  "features/admin/refunds/readiness-findings/authority-failure.test.ts",
  "features/admin/refunds/refresh/helpers.ts",
  "features/api/payment-processing/classify.test.ts",
  "features/api/payment-processing/index/refunds.test.ts",
  "features/api/payment-processing/refunds.test.ts",
  "features/api/payment-processing/refunds/provider-result.test.ts",
  "features/api/payment-processing/refunds/rejected-charge.test.ts",
  "features/api/webhooks/helpers.ts",
  "features/api/webhooks/provider.test.ts",
  "integration/server/payments-success-refunds.test.ts",
  "integration/server/payments/confirm.test.ts",
  "integration/server/payments/replay.test.ts",
  "integration/server/payments/sales-off-safety.test.ts",
  "integration/server/privacy-refund-recovery-helpers.ts",
  "integration/server/privacy-refund-recovery-race.test.ts",
  "integration/server/privacy-refund-recovery.test.ts",
  "integration/server/webhooks/multi-ticket-booking.test.ts",
  "integration/server/webhooks/refund-skip-conditions.test.ts",
  "integration/server/webhooks/sumup.test.ts",
  "integration/server/webhooks/unrecognized-sessions.test.ts",
  "integration/stripe/core.test.ts",
  "integration/webhook-price-signature/helpers.ts",
  "shared/payment/admit-refund.test.ts",
  "shared/payment/refund-attempt.test.ts",
  "shared/payment/refund-authority-choice.test.ts",
  "shared/payment/refund-authority-state.test.ts",
  "shared/provider-refunds.test.ts",
  "shared/provider-refunds/engine-helpers.ts",
  "shared/provider-refunds/send.test.ts",
  "shared/provider-refunds/state-owner-revision.test.ts",
  "shared/provider-refunds/state.test.ts",
  "shared/provider-refunds/state/contracts.test.ts",
  "shared/provider-refunds/target-conflict.test.ts",
  "shared/provider-refunds/target.test.ts",
  "shared/square-provider/provider.test.ts",
  "shared/square/refund-outcomes.test.ts",
  "shared/square/refund-payment.test.ts",
  "shared/square/refund-transport.test.ts",
  "shared/stripe-provider/refund-outcomes.test.ts",
  "shared/sumup/provider-money.test.ts",
  "specs/support/refund-safety/provider-script.ts",
  "test-utils/refund-routes.ts",
  "test-utils/webhooks/stripe.ts",
];

export const REFUND_AUTHORITY_SOURCE_PATHS = [
  "features/admin/privacy.ts",
  "features/admin/refunds/attempt.ts",
  "features/admin/refunds/authority.ts",
  "features/admin/refunds/dispatch.ts",
  "features/admin/refunds/provider.ts",
  "features/admin/refunds/readiness-findings.ts",
  "features/admin/refunds/readiness-run.ts",
  "features/admin/refunds/refresh.ts",
  "features/api/payment-processing/refunds.ts",
  "shared/payment/refund-authority-lifecycle.ts",
  "shared/provider-refunds.ts",
];

export const REFUND_AUTHORITY_TEST_PATHS = [
  "features/admin/refunds/attempt/unrecorded.test.ts",
  "features/admin/refunds/provider/batch/budget.test.ts",
  "features/admin/refunds/provider/claim-lifecycle.test.ts",
  "features/admin/refunds/provider/dispatch-helpers.ts",
  "features/admin/refunds/provider/mixed-capability.test.ts",
  "features/admin/refunds/provider/readiness-helpers.ts",
  "features/admin/refunds/readiness-findings/authority-failure.test.ts",
  "features/admin/refunds/refresh/helpers.ts",
  "integration/server/privacy-refund-recovery-race.test.ts",
  "shared/payment/refund-authority-lifecycle.test.ts",
  "shared/provider-refunds.test.ts",
  "shared/provider-refunds/send.test.ts",
  "shared/provider-refunds/send/outcomes.test.ts",
  "shared/provider-refunds/state-owner-revision.test.ts",
  "shared/provider-refunds/state.test.ts",
  "shared/provider-refunds/target-conflict.test.ts",
  "shared/provider-refunds/target.test.ts",
  "specs/steps/refund-safety/owner-cases.ts",
];

export const LOWER_SEND_SOURCE_PATHS = {
  armReadyRefund: [
    "shared/provider-refunds.ts",
    "shared/provider-refunds/send.ts",
  ],
  authorizeDurableRefundSend: [
    "shared/payment/refund-provider-authorization.ts",
    "shared/provider-refunds/send.ts",
  ],
  continueActiveRefund: [
    "shared/provider-refunds.ts",
    "shared/provider-refunds/send.ts",
  ],
  dispatchRefundBatch: [
    "features/admin/refunds/dispatch.ts",
    "features/admin/refunds/provider.ts",
  ],
  finishPreparedCandidate: [
    "features/admin/refunds/attempt.ts",
    "features/admin/refunds/dispatch.ts",
  ],
  prepareReadyCandidate: [
    "features/admin/refunds/attempt.ts",
    "features/admin/refunds/dispatch.ts",
  ],
  requestReadyRefund: [
    "features/admin/refunds/attempt.ts",
    "features/admin/refunds/authority.ts",
    "features/admin/refunds/refresh.ts",
  ],
} as const;

export const LOWER_SEND_TEST_PATHS = {
  armReadyRefund: ["shared/provider-refunds/send.test.ts"],
  authorizeDurableRefundSend: [
    "shared/payment/refund-attempt.test.ts",
    "shared/payment/refund-provider-authorization.test.ts",
    "shared/sumup/provider-money.test.ts",
    "test-utils/square/fixtures.ts",
    "test-utils/stripe/fixtures.ts",
  ],
  continueActiveRefund: [],
  dispatchRefundBatch: [],
  finishPreparedCandidate: [
    "features/admin/refunds/provider/dispatch-helpers.ts",
  ],
  prepareReadyCandidate: [
    "features/admin/refunds/provider/dispatch-helpers.ts",
  ],
  requestReadyRefund: [],
} as const;
