/** The payment-review machine, derived from the declared review vocabulary.
 *
 * The review's own transitions are the exported functions in
 * `review.ts` — open, acknowledge — and the one declared retirement table:
 * each reason names the exact evidence that retires it. A review opens only
 * when a row has none (the engine's `withReviewChange` refuses a second case
 * for the same reason), and acknowledging keeps the case until that evidence
 * arrives. */

import {
  acknowledgePaymentReview,
  openPaymentReview,
  PAYMENT_REVIEW_RETIREMENT,
  type PaymentReviewCase,
  type PaymentReviewReason,
} from "#shared/payment/review.ts";
import {
  type AtlasEdge,
  type AtlasMachine,
  type AtlasTrigger,
  atlasState,
  edgesFromTriggers,
} from "#shared/schema-atlas/types.ts";

/** The review slot of one payment row: undefined means no review is held. */
type ReviewSlot = PaymentReviewCase | undefined;

const SEEN_AT = "2026-08-16T00:00:00.000Z";

/** The declared reasons a payment row can be kept for review. */
const REVIEW_REASONS = Object.keys(
  PAYMENT_REVIEW_RETIREMENT,
) as PaymentReviewReason["kind"][];

const openCases = REVIEW_REASONS.map((kind) => openPaymentReview({ kind }));
const seenCases = openCases.map((open) =>
  acknowledgePaymentReview(open, SEEN_AT),
);

/** The node a produced review slot belongs to. */
const nodeIdOf = (slot: ReviewSlot): string =>
  slot === undefined
    ? "none"
    : slot.acknowledgedAt === undefined
      ? "open"
      : "seen";

/** One named transition. Retirement has no function — it is the declared
 * evidence per reason, applied to whichever case carries that reason. */
type ReviewTrigger = AtlasTrigger<ReviewSlot>;
type SlotRun = ReviewTrigger["run"];

const refuse = (message: string): never => {
  throw new Error(message);
};

/** A case opens only on a row that holds none; the same-reason reopen the
 * engine refuses stays refused here by construction. */
const opensFor =
  (reason: PaymentReviewReason): SlotRun =>
  (slot) =>
    slot === undefined
      ? openPaymentReview(reason)
      : refuse("A row with a review cannot open another");

/** The one declared way each reason retires. */
const retires =
  (kind: PaymentReviewReason["kind"]): SlotRun =>
  (slot) =>
    slot !== undefined && slot.reason.kind === kind
      ? undefined
      : refuse(`This evidence retires only a ${kind} review`);

const TRIGGERS: readonly ReviewTrigger[] = [
  ...openCases.map(
    (caseFor): ReviewTrigger => ({
      actor: "system",
      labelKey: `schema.review.reason.${caseFor.reason.kind}`,
      run: opensFor(caseFor.reason),
    }),
  ),
  {
    actor: "owner",
    labelKey: "schema.review.edge.acknowledge",
    run: (slot: ReviewSlot): ReviewSlot => {
      if (slot === undefined || slot.acknowledgedAt !== undefined) {
        throw new Error("Only an unseen case can be acknowledged");
      }
      return acknowledgePaymentReview(slot, SEEN_AT);
    },
  },
  ...REVIEW_REASONS.map(
    (kind): ReviewTrigger => ({
      actor: "system",
      labelKey: `schema.review.evidence.${PAYMENT_REVIEW_RETIREMENT[kind]}`,
      run: retires(kind),
    }),
  ),
];

/** The whole review machine. */
export const paymentReviewAtlas = (): AtlasMachine => {
  /** The edges out of one node, from the shared trigger executor. */
  const edgesOf = (states: readonly ReviewSlot[]): AtlasEdge[] =>
    edgesFromTriggers<ReviewSlot>(TRIGGERS, nodeIdOf, states);
  return {
    id: "review",
    introKey: "schema.review.intro",
    states: [
      atlasState(
        "schema.review.state",
        "none",
        { x: 140, y: 160 },
        edgesOf([undefined]),
        {
          start: true,
        },
      ),
      atlasState(
        "schema.review.state",
        "open",
        { x: 480, y: 160 },
        edgesOf(openCases),
      ),
      atlasState(
        "schema.review.state",
        "seen",
        { x: 820, y: 160 },
        edgesOf(seenCases),
      ),
    ],
    titleKey: "schema.review.title",
  };
};
