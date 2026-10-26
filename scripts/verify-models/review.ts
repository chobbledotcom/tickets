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
  attemptFields,
  type ModelDataSource,
  type TlaFact,
  tlaModule,
  tlaRecords,
  tlaSet,
} from "#scripts/verify-models/data.ts";
import { attemptTransition } from "#shared/schema-atlas/types.ts";

/* jscpd:ignore-end */

const nodeFields = {
  held: "Bool",
  reason: "Str",
  seen: "Bool",
  state: "Str",
} as const;
const eventFields = {
  action: "Str",
  eventId: "Str",
  movesMoney: "Bool",
  reason: "Str",
} as const;
const reviewAttemptFields = {
  ...attemptFields,
  sameCaseId: "Bool",
  sameReason: "Bool",
} as const;
type NodeFact = TlaFact<typeof nodeFields>;
type EventFact = TlaFact<typeof eventFields>;
type Attempt = TlaFact<typeof reviewAttemptFields>;

const nodeFact = (slot: ReviewSlot): NodeFact => ({
  held: slot !== undefined,
  reason: slot?.reason.kind ?? "",
  seen: slot?.acknowledgedAt !== undefined,
  state:
    slot === undefined ? "none" : `${reviewNodeOf(slot)}(${slot.reason.kind})`,
});

/** Event names declare the operation and its evidence reason, not its moves. */
const eventFact = (event: ReviewMachineEvent): EventFact => {
  if (event.id === "acknowledge") {
    return {
      action: "acknowledge",
      eventId: event.id,
      movesMoney: event.movesMoney,
      reason: "",
    };
  }
  for (const action of ["open", "retire"]) {
    const prefix = `${action}_`;
    if (event.id.startsWith(prefix)) {
      return {
        action,
        eventId: event.id,
        movesMoney: event.movesMoney,
        reason: event.id.slice(prefix.length),
      };
    }
  }
  throw new Error(`Unknown review operation ${event.id}`);
};

/** Compare actual case identity and reason before abstracting the slot. */
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
        nodes.set(source.state, source);
        nodes.set(target.state, target);
        attempts.push({
          accepted,
          eventId: event.id,
          sameCaseId: caseId === after?.caseId,
          sameReason: reason === after?.reason.kind,
          sampleTag: representative.tag,
          sourceState: source.state,
          targetState: target.state,
        });
      }
    }
  }
  const events = map(eventFact)(REVIEW_EVENTS);
  const states = [...nodes.keys()];
  return tlaModule("PaymentReviewData", [
    `ReviewStates == ${tlaSet(states)}`,
    tlaRecords("ReviewNodes", nodeFields, [...nodes.values()]),
    tlaRecords("ReviewEvents", eventFields, events),
    tlaRecords("ReviewAttempts", reviewAttemptFields, attempts),
  ]);
};
