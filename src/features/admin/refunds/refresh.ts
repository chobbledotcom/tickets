/* jscpd:ignore-start -- imports */
import { compact } from "#fp";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { markPaymentReferencesProviderRefunded } from "#shared/db/payment-references.ts";
import type { ObservedRefundAdmission } from "#shared/payment/admit-refund.ts";
import { reportWithheldRefund } from "#shared/payment-review.ts";
import {
  isPaymentOnlyAccount,
  recordAttendeeRefund,
  type RefundLedgerResult,
} from "#shared/refund-ledger.ts";
import { referenceRowIds, type RefundCandidate } from "./candidates.ts";
import {
  durableRowClaim,
  type HeldRefundClaim,
  type HeldRefundWork,
  type RowClaim,
  type RunFindings,
} from "./claim.ts";
import {
  type ConfirmedRefund,
  confirmRefund,
  type RefundConfirmation,
} from "./confirmation.ts";
import {
  prepareRefundReadiness,
  type ReadyRefundCandidate,
  type ReadyRefundReference,
} from "./readiness.ts";
import { runRefundReadiness } from "./readiness-run.ts";
import { readyRefundAdmission } from "./ready-admission.ts";
import { applyRefundLedgerFindings } from "./ledger-findings.ts";

/* jscpd:ignore-end */

type TaggedRefundReference = ReadyRefundReference["reference"];
type MarkReturnedReferences = (
  references: readonly TaggedRefundReference[],
) => Promise<void>;
type RecordRefund = (
  attendeeId: number,
  references: readonly TaggedRefundReference[],
) => Promise<RefundLedgerResult>;
type ConfirmRefund = (
  facts: Omit<ConfirmedRefund, "listingId">,
) => Promise<RefundConfirmation>;

export type RefreshPaymentResult =
  | { kind: "blocked"; reason: "refund_in_progress" }
  | { kind: "current" }
  | { kind: "needs_review"; message: string }
  | { kind: "not_ready"; message: string }
  | { kind: "returned"; posted: false }
  | { confirmation: RefundConfirmation; kind: "returned"; posted: true };

export type RefreshPaymentDependencies = {
  claim?: RowClaim;
  confirm?: ConfirmRefund;
  markReturned?: MarkReturnedReferences;
  paymentOnly?: (attendeeId: number) => Promise<boolean>;
  prepare?: typeof prepareRefundReadiness;
  record?: RecordRefund;
};

const paymentOnlyBeforeRefund = async (
  attendeeId: number,
): Promise<boolean> => {
  const legs = await transfersByAccount(attendeeAccount(attendeeId));
  return isPaymentOnlyAccount(legs);
};

type RefreshedReference =
  | { kind: "returned"; reference: TaggedRefundReference }
  | {
    admission: Exclude<ObservedRefundAdmission, { kind: "already_returned" }>;
    kind: "unreturned";
    reference: TaggedRefundReference;
  };

const REVIEW_REQUIRED_MESSAGE =
  "This payment needs an owner review before another refund can be attempted.";

const observedReference = (
  ready: ReadyRefundReference,
  attendeeId: number,
  listingId: number,
): RefreshedReference => {
  const admission = readyRefundAdmission(ready);
  if (admission.kind === "already_returned") {
    return { kind: "returned", reference: ready.reference };
  }
  if (admission.kind !== "send") {
    reportWithheldRefund(admission, {
      attendeeId,
      listingId,
      paymentReference: ready.reference.reference,
    });
  }
  return {
    admission,
    kind: "unreturned",
    reference: ready.reference,
  };
};

const returnedReference = (
  observed: RefreshedReference,
): TaggedRefundReference | null =>
  observed.kind === "returned" ? observed.reference : null;

/** Persist each provider disagreement on the exact rows that carried it. */
const recordProviderReviews = (
  observed: readonly RefreshedReference[],
  attendeeId: number,
  findings: RunFindings,
): boolean => {
  const refused = observed.filter(
    (
      result,
    ): result is Extract<RefreshedReference, { kind: "unreturned" }> & {
      admission: Extract<ObservedRefundAdmission, { kind: "refused" }>;
    } => result.kind === "unreturned" && result.admission.kind === "refused",
  );
  for (const { admission, reference } of refused) {
    for (const sessionId of referenceRowIds(attendeeId, reference)) {
      findings.reviews.set(sessionId, {
        kind: "review",
        reason: admission.issue,
      });
    }
  }
  return refused.length > 0;
};

type CompletedRefundReview = Extract<
  PaymentReviewReason,
  { kind: "partial_refund" | "partially_returned_obligation" }
>;

const completedRefundReview = (
  reason: PaymentReviewReason | undefined,
): reason is CompletedRefundReview =>
  reason?.kind === "partial_refund" ||
  reason?.kind === "partially_returned_obligation";

/** Retire only refund markers that a complete ledger post disproves. */
const retireCompletedRefundReviews = (
  returned: readonly TaggedRefundReference[],
  attendeeId: number,
  heldReviews: HeldRefundWork["reviews"],
  findings: RunFindings,
): void => {
  const returnedRows = returned.flatMap((reference) =>
    referenceRowIds(attendeeId, reference)
  );
  for (const sessionId of returnedRows) {
    const reason = heldReviews.get(sessionId);
    if (completedRefundReview(reason)) {
      findings.reviews.set(sessionId, {
        kind: "resolved",
        reason: reason.kind,
      });
    }
  }
};

const refreshReadyCandidate = async (
  candidate: ReadyRefundCandidate,
  listingId: number,
  inheritedKeyless: boolean,
  findings: RunFindings,
  claim: HeldRefundClaim,
  heldReviews: HeldRefundWork["reviews"],
  dependencies: Required<
    Pick<
      RefreshPaymentDependencies,
      "confirm" | "markReturned" | "paymentOnly" | "record"
    >
  >,
): Promise<RefreshPaymentResult> => {
  const observed = candidate.references.map((reference) =>
    observedReference(reference, candidate.attendee.id, listingId)
  );
  const returned = compact(observed.map(returnedReference));
  const hasUnreturned = returned.length !== candidate.references.length;
  const providerNeedsReview = recordProviderReviews(
    observed,
    candidate.attendee.id,
    findings,
  );
  const keepsClaim = observed.some(
    (reference) =>
      reference.kind === "unreturned" &&
      reference.admission.kind === "in_flight",
  ) ||
    (inheritedKeyless &&
      observed.some(
        (reference) =>
          reference.kind === "unreturned" &&
          reference.admission.kind === "send",
      ));
  if (keepsClaim) {
    findings.doubts.set(candidate.attendee.id, "in_doubt");
  }
  await dependencies.markReturned(returned);
  const ledger = returned.length === 0 ? undefined : applyRefundLedgerFindings(
    findings,
    candidate.attendee.id,
    returned,
    await dependencies.record(candidate.attendee.id, returned),
  );
  const needsReview = providerNeedsReview || ledger?.needsReview === true;
  if (hasUnreturned) {
    if (keepsClaim) return { kind: "blocked", reason: "refund_in_progress" };
    return needsReview
      ? { kind: "needs_review", message: REVIEW_REQUIRED_MESSAGE }
      : { kind: "current" };
  }

  if (ledger === undefined || !ledger.allRecorded) {
    return { kind: "returned", posted: false };
  }
  const paymentOnly = await dependencies.paymentOnly(candidate.attendee.id);
  retireCompletedRefundReviews(
    returned,
    candidate.attendee.id,
    heldReviews,
    findings,
  );
  const confirmation = await dependencies.confirm({
    attendee: candidate.attendee,
    claim,
    paymentOnly,
    references: returned,
  });
  return { confirmation, kind: "returned", posted: true };
};

const oneReadyCandidate = (
  candidates: readonly ReadyRefundCandidate[],
): ReadyRefundCandidate => {
  const [candidate, extra] = candidates;
  if (candidate === undefined || extra !== undefined) {
    throw new Error("Refresh readiness must return exactly one attendee");
  }
  return candidate;
};

/** Refresh one attendee's payment facts while holding their exact row set. */
export const refreshClaimedPayment = async (
  candidate: RefundCandidate,
  listingId: number,
  dependencies: RefreshPaymentDependencies = {},
): Promise<RefreshPaymentResult> => {
  const {
    claim = durableRowClaim,
    confirm = (refund) => confirmRefund({ ...refund, listingId }),
    markReturned = markPaymentReferencesProviderRefunded,
    paymentOnly = paymentOnlyBeforeRefund,
    prepare = prepareRefundReadiness,
    record = recordAttendeeRefund,
  } = dependencies;
  return await runRefundReadiness<RefreshPaymentResult>({
    candidates: [candidate],
    changedMessage:
      "The attendee or payment set changed while this refresh was starting. Try again.",
    claim,
    label: "Admin payment refresh",
    listingId,
    notReady: (message) => ({ kind: "not_ready", message }),
    prepare,
    ready: (candidates, { claim: heldClaim, findings, inherited, reviews }) =>
      refreshReadyCandidate(
        oneReadyCandidate(candidates),
        listingId,
        inherited.get(candidate.attendee.id) === "keyless",
        findings,
        heldClaim,
        reviews,
        { confirm, markReturned, paymentOnly, record },
      ),
  });
};
