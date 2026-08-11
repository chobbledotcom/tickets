import { compact } from "#fp";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { markPaymentReferencesProviderRefunded } from "#shared/db/payment-references.ts";
import { legMatches } from "#shared/ledger/legs.ts";
import {
  admitObservedRefund,
  type ObservedRefundAdmission,
} from "#shared/payment/admit-refund.ts";
import { reportWithheldRefund } from "#shared/payment-review.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger.ts";
import type { RefundCandidate } from "./candidates.ts";
import {
  durableRowClaim,
  type RowClaim,
  type RunFindings,
  underAttendeeClaim,
} from "./claim.ts";
import {
  prepareRefundReadiness,
  type ReadyRefundCandidate,
  type ReadyRefundReference,
} from "./readiness.ts";
import { refundReadinessMessage } from "./readiness-problem.ts";
import { reportRefundProblem } from "./report.ts";

type TaggedRefundReference = ReadyRefundReference["reference"];
type MarkReturnedReferences = (
  references: readonly TaggedRefundReference[],
) => Promise<void>;
type RecordRefund = (
  attendeeId: number,
  references: readonly TaggedRefundReference[],
) => Promise<{ posted: boolean }>;

export type RefreshPaymentResult =
  | { kind: "blocked"; reason: "refund_in_progress" }
  | { kind: "current" }
  | { kind: "not_ready"; message: string }
  | { kind: "returned"; paymentOnly: boolean; posted: boolean };

export type RefreshPaymentDependencies = {
  claim?: RowClaim;
  markReturned?: MarkReturnedReferences;
  paymentOnly?: (attendeeId: number) => Promise<boolean>;
  prepare?: typeof prepareRefundReadiness;
  record?: RecordRefund;
};

const isProviderPayment = legMatches({ from: WORLD, kind: KIND.payment });

const paymentOnlyBeforeRefund = async (attendeeId: number): Promise<boolean> => {
  const legs = await transfersByAccount(attendeeAccount(attendeeId));
  return legs.length > 0 && legs.every(isProviderPayment);
};

type RefreshedReference =
  | { kind: "returned"; reference: TaggedRefundReference }
  | { doubt: boolean; kind: "unreturned" };

const observedReference = (
  ready: ReadyRefundReference,
  attendeeId: number,
  listingId: number,
): RefreshedReference => {
  if (ready.kind === "already_returned") {
    return { kind: "returned", reference: ready.reference };
  }
  const admission = admitObservedRefund(
    ready.reference.reference,
    ready.charge,
  );
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
    doubt: admission.kind === "in_flight",
    kind: "unreturned",
  };
};

const returnedReference = (
  observed: RefreshedReference,
): TaggedRefundReference | null =>
  observed.kind === "returned" ? observed.reference : null;

const refreshReadyCandidate = async (
  candidate: ReadyRefundCandidate,
  listingId: number,
  inheritedKeyless: boolean,
  findings: RunFindings,
  dependencies: Required<
    Pick<
      RefreshPaymentDependencies,
      "markReturned" | "paymentOnly" | "record"
    >
  >,
): Promise<RefreshPaymentResult> => {
  const observed = candidate.references.map((reference) =>
    observedReference(
      reference,
      candidate.attendee.id,
      listingId,
    )
  );
  const returned = compact(observed.map(returnedReference));
  const hasUnreturned = returned.length !== candidate.references.length;
  const keepsClaim =
    observed.some(
      (reference) => reference.kind === "unreturned" && reference.doubt,
    ) ||
    (inheritedKeyless && hasUnreturned);
  if (keepsClaim) {
    findings.doubts.set(candidate.attendee.id, "in_doubt");
  }
  await dependencies.markReturned(returned);
  if (hasUnreturned) {
    return keepsClaim
      ? { kind: "blocked", reason: "refund_in_progress" }
      : { kind: "current" };
  }

  const paymentOnly = await dependencies.paymentOnly(candidate.attendee.id);
  const { posted } = await dependencies.record(
    candidate.attendee.id,
    returned,
  );
  if (!posted) {
    findings.unrecorded.set(
      candidate.attendee.id,
      returned.flatMap(({ rowSessionIds }) => rowSessionIds),
    );
  }
  return { kind: "returned", paymentOnly, posted };
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
    markReturned = markPaymentReferencesProviderRefunded,
    paymentOnly = paymentOnlyBeforeRefund,
    prepare = prepareRefundReadiness,
    record = recordAttendeeRefund,
  } = dependencies;
  return await underAttendeeClaim<RefreshPaymentResult>(
    claim,
    [
      {
        attendeeId: candidate.attendee.id,
        loadedPiiBlob: candidate.attendee.pii_blob,
        references: candidate.references,
      },
    ],
    "unresolved",
    listingId,
    {
      blocked: ({ kind, reason }) => {
        if (kind === "claim_held") {
          return { kind: "blocked", reason: "refund_in_progress" };
        }
        reportRefundProblem(
          `Admin payment refresh not started for attendee ${candidate.attendee.id}: ${reason}`,
          listingId,
        );
        return {
          kind: "not_ready",
          message:
            "The attendee or payment set changed while this refresh was starting. Try again.",
        };
      },
      work: async ({ alreadyReturned, claim, findings, inherited }) => {
        const readiness = await prepare(
          [candidate],
          claim,
          alreadyReturned,
        );
        if (readiness.kind === "not_ready") {
          const message = refundReadinessMessage(readiness);
          if (readiness.reason !== "historical_marker") {
            findings.doubts.set(candidate.attendee.id, "unread");
          }
          reportRefundProblem(
            `Admin payment refresh not started for attendee ${candidate.attendee.id}: ${message}`,
            listingId,
          );
          return { kind: "not_ready", message };
        }
        return await refreshReadyCandidate(
          oneReadyCandidate(readiness.candidates),
          listingId,
          inherited.get(candidate.attendee.id) === "keyless",
          findings,
          { markReturned, paymentOnly, record },
        );
      },
    },
  );
};
