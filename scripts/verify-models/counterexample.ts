/* jscpd:ignore-start -- imports */
import {
  modelData,
  type PaymentModel,
  paymentModel,
} from "#scripts/verify-models/model.ts";
/* jscpd:ignore-end */

/** One emitted money edge with its refund request changed. The checker must
 *  report a counterexample for this data, or its clean verdicts prove
 *  nothing. */
export const corruptOneEdge = (model: PaymentModel): PaymentModel => {
  const edge = model.authorityMoves.findIndex(
    (move) => model.moneyEventIds.includes(move.eventId) && move.requestKept,
  );
  if (edge === -1) {
    throw new Error(
      "The refund machine emitted no money edge with a preserved request. There is no edge to corrupt.",
    );
  }
  const authorityMoves = model.authorityMoves.map((move, index) =>
    index === edge ? { ...move, requestKept: false } : move,
  );
  return { ...model, authorityMoves };
};

/** The JointState data module with one edge corrupted. */
export const counterexampleData = async (): Promise<string> =>
  modelData(corruptOneEdge(await paymentModel()));
