/* jscpd:ignore-start -- imports */
import { compact } from "#fp";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { markPaymentReferencesProviderRefunded } from "#shared/db/payment-references.ts";
import type { ObservedRefundAdmission } from "#shared/payment/admit-refund.ts";
import { PAYMENT_REVIEW_RETIREMENT } from "#shared/payment/review.ts";
import type { RefundProviderCapability } from "#shared/payment/row-state.ts";
import { reportWithheldRefund } from "#shared/payment-review.ts";
import { isPaymentOnlyAccount } from "#shared/refund-ledger/plan.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import type { RefundLedgerResult } from "#shared/refund-ledger/result.ts";
import type { RefundCandidate } from "./candidates.ts";
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
  applyRefundLedgerFindings,
  rememberFailedRefundLedger,
} from "./ledger-findings.ts";
import {
  currentPaymentReviews,
  type ProviderReviewFinding,
  reconcileProviderReviewFindings,
  resolvePaymentReview,
} from "./provider-reviews.ts";
import {
  prepareRefundReadiness,
  type ReadyRefundCandidate,
  type ReadyRefundReference,
} from "./readiness.ts";
import { runRefundReadiness } from "./readiness-run.ts";
import { readyRefundAdmission } from "./ready-admission.ts";

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

type UnreturnedReference = Extract<RefreshedReference, { kind: "unreturned" }>;

const hasUnreturnedReference = (
  observed: readonly RefreshedReference[],
  matches: (reference: UnreturnedReference) => boolean,
): boolean =>
  observed.some(
    (reference) => reference.kind === "unreturned" && matches(reference),
  );

const hasAdmission = (
  observed: readonly RefreshedReference[],
  kind: UnreturnedReference["admission"]["kind"],
): boolean =>
  hasUnreturnedReference(
    observed,
    (reference) => reference.admission.kind === kind,
  );

const resumedKeyedSendRemains = (
  observed: readonly RefreshedReference[],
  inherited: ReadonlyMap<string, RefundProviderCapability>,
): boolean =>
  hasUnreturnedReference(
    observed,
    ({ admission, reference }) =>
      admission.kind === "send" && inherited.get(reference.index) === "keyed",
  );

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

/** Keep only provider disagreements that need an owner's decision. */
const providerReviewFindings = (
  observed: readonly RefreshedReference[],
  uncertainKeyless: ReadonlySet<string>,
): ProviderReviewFinding[] =>
  observed.flatMap((result): ProviderReviewFinding[] =>
    result.kind !== "unreturned"
      ? []
      : result.admission.kind === "refused"
      ? [{ reason: result.admission.issue, reference: result.reference }]
      : result.admission.kind === "send" &&
          uncertainKeyless.has(result.reference.index)
      ? [
        {
          reason: { kind: "uncertain_keyless_refund" },
          reference: result.reference,
        },
      ]
      : []
  );

/** Retire only refund markers that a complete ledger post disproves. */
const retireCompletedRefundReviews = (
  returned: readonly TaggedRefundReference[],
  heldReviews: HeldRefundWork["reviews"],
  findings: RunFindings,
): void => {
  const returnedRows = returned.flatMap((reference) => reference.rowSessionIds);
  for (const sessionId of returnedRows) {
    const reason = heldReviews.get(sessionId);
    if (
      reason !== undefined &&
      PAYMENT_REVIEW_RETIREMENT[reason.kind] === "all_returned_and_recorded"
    ) {
      resolvePaymentReview(findings, sessionId, reason);
    }
  }
};

type AppliedRefundLedger = ReturnType<typeof applyRefundLedgerFindings>;
type RefreshPersistence = Required<
  Pick<RefreshPaymentDependencies, "markReturned" | "record">
>;

/** Keep or clear the safety hold for one attendee as a single transition. */
const setClaimProtection = (
  findings: RunFindings,
  attendeeId: number,
  keepsClaim: boolean,
): void => {
  if (keepsClaim) findings.doubts.set(attendeeId, "in_doubt");
  else findings.doubts.delete(attendeeId);
};

/** Mark and post returned money before the claim may be retired. */
const persistReturnedReferences = async (
  attendeeId: number,
  returned: readonly TaggedRefundReference[],
  keepsClaim: boolean,
  findings: RunFindings,
  dependencies: RefreshPersistence,
): Promise<AppliedRefundLedger | undefined> => {
  if (returned.length > 0) setClaimProtection(findings, attendeeId, true);
  await dependencies.markReturned(returned);
  if (returned.length === 0) return;

  let result: RefundLedgerResult;
  try {
    result = await dependencies.record(attendeeId, returned);
  } catch (error) {
    rememberFailedRefundLedger(findings, attendeeId, returned);
    setClaimProtection(findings, attendeeId, keepsClaim);
    throw error;
  }
  const ledger = applyRefundLedgerFindings(
    findings,
    attendeeId,
    returned,
    result,
  );
  setClaimProtection(findings, attendeeId, keepsClaim);
  return ledger;
};

const unreturnedResult = (
  attendeeId: number,
  keepsClaim: boolean,
  needsReview: boolean,
  findings: RunFindings,
): RefreshPaymentResult => {
  if (keepsClaim) {
    return { kind: "blocked", reason: "refund_in_progress" };
  }
  if (needsReview) {
    setClaimProtection(findings, attendeeId, false);
    return { kind: "needs_review", message: REVIEW_REQUIRED_MESSAGE };
  }
  return findings.doubts.has(attendeeId)
    ? { kind: "blocked", reason: "refund_in_progress" }
    : { kind: "current" };
};

const completedRefresh = async (
  candidate: ReadyRefundCandidate,
  returned: readonly TaggedRefundReference[],
  claim: HeldRefundClaim,
  heldReviews: HeldRefundWork["reviews"],
  findings: RunFindings,
  dependencies: Required<
    Pick<RefreshPaymentDependencies, "confirm" | "paymentOnly">
  >,
): Promise<RefreshPaymentResult> => {
  const attendeeId = candidate.attendee.id;
  setClaimProtection(findings, attendeeId, false);
  const paymentOnly = await dependencies.paymentOnly(attendeeId);
  retireCompletedRefundReviews(returned, heldReviews, findings);
  const confirmation = await dependencies.confirm({
    attendee: candidate.attendee,
    claim,
    paymentOnly,
    references: returned,
  });
  return { confirmation, kind: "returned", posted: true };
};

const refreshReadyCandidate = async (
  candidate: ReadyRefundCandidate,
  listingId: number,
  inherited: ReadonlyMap<string, RefundProviderCapability>,
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
  const currentProviderReviews = providerReviewFindings(
    observed,
    new Set(
      [...inherited].flatMap(([index, capability]) =>
        capability === "keyless" ? [index] : []
      ),
    ),
  );
  reconcileProviderReviewFindings(
    findings,
    heldReviews,
    candidate.references.map(({ reference }) => reference),
    currentProviderReviews,
  );
  const attendeeId = candidate.attendee.id;
  // The complete observation now replaces protection taken before provider IO.
  const keepsClaim = hasAdmission(observed, "in_flight") ||
    resumedKeyedSendRemains(observed, inherited);
  setClaimProtection(findings, attendeeId, keepsClaim);
  const ledger = await persistReturnedReferences(
    attendeeId,
    returned,
    keepsClaim,
    findings,
    dependencies,
  );
  const needsReview = currentPaymentReviews(heldReviews, findings).size > 0;
  if (hasUnreturned) {
    return unreturnedResult(attendeeId, keepsClaim, needsReview, findings);
  }

  if (ledger === undefined || !ledger.allRecorded) {
    setClaimProtection(findings, attendeeId, false);
    return { kind: "returned", posted: false };
  }
  return await completedRefresh(
    candidate,
    returned,
    claim,
    heldReviews,
    findings,
    dependencies,
  );
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
    action: "refresh",
    candidates: [candidate],
    changedMessage:
      "The attendee or payment set changed while this refresh was starting. Try again.",
    claim,
    label: "Admin payment refresh",
    listingId,
    notReady: (message) => ({ kind: "not_ready", message }),
    prepare,
    ready: (candidates, { claim: heldClaim, findings, inherited, reviews }) => {
      const readyCandidate = oneReadyCandidate(candidates);
      return refreshReadyCandidate(
        readyCandidate,
        listingId,
        inherited.get(readyCandidate.attendee.id) ?? new Map(),
        findings,
        heldClaim,
        reviews,
        { confirm, markReturned, paymentOnly, record },
      );
    },
  });
};
