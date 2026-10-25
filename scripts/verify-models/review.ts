/* jscpd:ignore-start -- imports */
import { map } from "#fp";
import {
  REVIEW_EVENTS,
  REVIEW_NODES,
  type ReviewMachineEvent,
  type ReviewSlot,
  reviewNodeOf,
} from "#payment/review-machine-spec.ts";
import {
  type ModelDataSource,
  tlaModule,
  tlaSet,
  tlaTuples,
} from "#scripts/verify-models/data.ts";
import { attemptTransition } from "#shared/schema-atlas/types.ts";

/* jscpd:ignore-end */

type NodeFact = readonly [
  node: string,
  held: boolean,
  seen: boolean,
  reason: string,
];
type EventFact = readonly [
  event: string,
  action: string,
  reason: string,
  movesMoney: boolean,
];
type Attempt = readonly [
  source: string,
  event: string,
  target: string,
  representative: string,
  accepted: boolean,
  sameCaseId: boolean,
  sameReason: boolean,
];

const nodeFact = (slot: ReviewSlot): NodeFact => [
  slot === undefined ? "none" : `${reviewNodeOf(slot)}(${slot.reason.kind})`,
  slot !== undefined,
  slot?.acknowledgedAt !== undefined,
  slot?.reason.kind ?? "",
];

/** Event names declare the operation and its evidence reason, not its moves. */
const eventFact = (event: ReviewMachineEvent): EventFact => {
  if (event.id === "acknowledge") {
    return [event.id, "acknowledge", "", event.movesMoney];
  }
  for (const action of ["open", "retire"]) {
    const prefix = `${action}_`;
    if (event.id.startsWith(prefix)) {
      return [
        event.id,
        action,
        event.id.slice(prefix.length),
        event.movesMoney,
      ];
    }
  }
  throw new Error(`Unknown review operation ${event.id}`);
};

/** Execute every representative/event pair, including refused attempts.
 * UUIDs are abstracted only after comparing the actual before/after values.
 * This is the review slot: wrong-reason settlement no-ops on payment rows
 * remain separate production behavior, covered by their direct row tests. */
export const reviewModelData: ModelDataSource = async () => {
  const nodes = new Map<string, NodeFact>();
  const attempts: Attempt[] = [];
  for (const node of REVIEW_NODES) {
    for (const representative of node.reps) {
      for (const event of REVIEW_EVENTS) {
        const input = structuredClone(representative.state);
        const source = nodeFact(input);
        const caseId = input?.caseId;
        const reason = input?.reason.kind;
        const result = attemptTransition(event.run, input);
        const accepted = result !== null;
        const after = accepted ? result : input;
        const target = nodeFact(after);
        nodes.set(source[0], source);
        nodes.set(target[0], target);
        attempts.push([
          source[0],
          event.id,
          target[0],
          representative.tag,
          accepted,
          caseId === after?.caseId,
          reason === after?.reason.kind,
        ]);
      }
    }
  }
  const events = map(eventFact)(REVIEW_EVENTS);
  const states = [...nodes.keys()];
  return tlaModule("PaymentReviewData", [
    `ReviewStates == ${tlaSet(states)}`,
    `\\* @type: Set(<<Str, Bool, Bool, Str>>);\nReviewNodes == ${tlaTuples([...nodes.values()])}`,
    `\\* @type: Set(<<Str, Str, Str, Bool>>);\nReviewEvents == ${tlaTuples(events)}`,
    `\\* @type: Set(<<Str, Str, Str, Str, Bool, Bool, Bool>>);\nReviewAttempts == ${tlaTuples(attempts)}`,
  ]);
};
