/* jscpd:ignore-start -- imports */
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { PAYMENT_REVIEW_RETIREMENT } from "#shared/payment/review.ts";
import { reportProviderWithheldRefund } from "#shared/payment-review.ts";
import {
  type ProviderRefundResult,
  recordProviderRefunds,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import { isPaymentOnlyAccount } from "#shared/refund-ledger/plan.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import type { RefundLedgerResult } from "#shared/refund-ledger/result.ts";
import {
  type AuthorityBearingReference,
  recordedRefundAuthorities,
  requestReadyRefund,
} from "./authority.ts";
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
import { mapProviderRequests } from "./provider-requests.ts";
import {
  prepareRefundReadiness,
  type ReadyRefundCandidate,
  type ReadyRefundReference,
} from "./readiness.ts";
import { runRefundReadiness } from "./readiness-run.ts";
import { currentPaymentReviews, resolvePaymentReview } from "./row-reviews.ts";

/* jscpd:ignore-end */

type TaggedRefundReference = ReadyRefundReference["reference"];
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
  paymentOnly?: (attendeeId: number) => Promise<boolean>;
  prepare?: typeof prepareRefundReadiness;
  record?: RecordRefund;
  recordAuthorities?: typeof recordProviderRefunds;
  request?: typeof requestProviderRefund;
};

const paymentOnlyBeforeRefund = async (
  attendeeId: number,
): Promise<boolean> => {
  const legs = await transfersByAccount(attendeeAccount(attendeeId));
  return isPaymentOnlyAccount(legs);
};

const REVIEW_REQUIRED_MESSAGE =
  "This payment needs an owner review before another refund can be attempted.";

const observeReference = async (
  ready: ReadyRefundReference,
  attendeeId: number,
  listingId: number,
  request: typeof requestProviderRefund,
): Promise<ProviderRefundResult> => {
  const result = await requestReadyRefund(ready, "observe_only", request);
  return result.kind === "withheld"
    ? reportProviderWithheldRefund(result, { attendeeId, listingId })
    : result;
};

const returnedReference = (
  result: ProviderRefundResult,
  reference: TaggedRefundReference,
): AuthorityBearingReference<TaggedRefundReference>[] => {
  if (
    result.reference.provider !== reference.provider ||
    result.reference.reference !== reference.reference
  ) {
    throw new Error("Refund authority answered for a different payment");
  }
  return result.kind === "returned"
    ? [{ authority: result.authority, reference }]
    : [];
};

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
  Pick<RefreshPaymentDependencies, "record" | "recordAuthorities">
>;

/** Post returned money, then retire only matching durable authorities. */
const persistReturnedReferences = async (
  attendeeId: number,
  returned: readonly AuthorityBearingReference<TaggedRefundReference>[],
  findings: RunFindings,
  dependencies: RefreshPersistence,
): Promise<AppliedRefundLedger | undefined> => {
  if (returned.length === 0) return;
  const references = returned.map(({ reference }) => reference);

  let result: RefundLedgerResult;
  try {
    result = await dependencies.record(attendeeId, references);
  } catch (error) {
    rememberFailedRefundLedger(findings, attendeeId, references);
    throw error;
  }
  const ledger = applyRefundLedgerFindings(
    findings,
    attendeeId,
    references,
    result,
  );
  const recordedAuthorities = recordedRefundAuthorities(returned, result);
  if (recordedAuthorities.length > 0) {
    await dependencies.recordAuthorities(recordedAuthorities);
  }
  return ledger;
};

const unreturnedResult = (
  observed: readonly ProviderRefundResult[],
  needsReview: boolean,
): RefreshPaymentResult => {
  if (
    needsReview ||
    observed.some((result) => result.kind === "needs_owner_choice")
  ) {
    return { kind: "needs_review", message: REVIEW_REQUIRED_MESSAGE };
  }
  if (observed.some((result) => result.kind === "pending")) {
    return { kind: "blocked", reason: "refund_in_progress" };
  }
  if (observed.some((result) => result.kind === "changed")) {
    throw new Error("Observed payment refresh reached an owner revision fence");
  }
  if (observed.some((result) => result.kind === "withheld")) {
    throw new Error("Observed payment refresh lost its provider evidence");
  }
  return { kind: "current" };
};

const completedRefresh = async (
  candidate: ReadyRefundCandidate,
  returned: readonly TaggedRefundReference[],
  claim: HeldRefundClaim,
  dependencies: Required<
    Pick<RefreshPaymentDependencies, "confirm" | "paymentOnly">
  >,
): Promise<RefreshPaymentResult> => {
  const attendeeId = candidate.attendee.id;
  const paymentOnly = await dependencies.paymentOnly(attendeeId);
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
  findings: RunFindings,
  claim: HeldRefundClaim,
  heldReviews: HeldRefundWork["reviews"],
  dependencies: Required<
    Pick<
      RefreshPaymentDependencies,
      "confirm" | "paymentOnly" | "record" | "recordAuthorities" | "request"
    >
  >,
): Promise<RefreshPaymentResult> => {
  const observed = await mapProviderRequests(
    candidate.references,
    (reference) =>
      observeReference(
        reference,
        candidate.attendee.id,
        listingId,
        dependencies.request,
      ),
  );
  const returned = observed.flatMap((result, offset) =>
    returnedReference(result, candidate.references[offset]!.reference),
  );
  const hasUnreturned = returned.length !== candidate.references.length;
  const attendeeId = candidate.attendee.id;
  const ledger = await persistReturnedReferences(
    attendeeId,
    returned,
    findings,
    dependencies,
  );
  if (ledger?.allRecorded) {
    retireCompletedRefundReviews(
      returned.map(({ reference }) => reference),
      heldReviews,
      findings,
    );
  }
  const needsReview = currentPaymentReviews(heldReviews, findings).size > 0;
  if (hasUnreturned) {
    return unreturnedResult(observed, needsReview);
  }

  if (needsReview) {
    return { kind: "needs_review", message: REVIEW_REQUIRED_MESSAGE };
  }
  if (ledger === undefined || !ledger.allRecorded) {
    return { kind: "returned", posted: false };
  }
  return await completedRefresh(
    candidate,
    returned.map(({ reference }) => reference),
    claim,
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
    paymentOnly = paymentOnlyBeforeRefund,
    prepare = prepareRefundReadiness,
    record = recordAttendeeRefund,
    recordAuthorities = recordProviderRefunds,
    request = requestProviderRefund,
  } = dependencies;
  return await runRefundReadiness<RefreshPaymentResult>({
    action: "refresh",
    candidates: [candidate],
    changedMessage:
      "The attendee or payment set changed while this refresh was starting. Try again.",
    claim,
    listingId,
    notReady: (message) => ({ kind: "not_ready", message }),
    prepare,
    ready: (candidates, { claim: heldClaim, findings, reviews }) => {
      const readyCandidate = oneReadyCandidate(candidates);
      return refreshReadyCandidate(
        readyCandidate,
        listingId,
        findings,
        heldClaim,
        reviews,
        {
          confirm,
          paymentOnly,
          record,
          recordAuthorities,
          request,
        },
      );
    },
    request,
  });
};
