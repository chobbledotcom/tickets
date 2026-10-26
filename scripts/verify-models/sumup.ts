/* jscpd:ignore-start -- imports */
import { filter, map, pipe } from "#fp";
import {
  RECOVERY_CHECKABLE_NODES,
  RECOVERY_EVENTS,
  RECOVERY_MOVES,
  RECOVERY_NODES,
  RECOVERY_PRUNABLE_NODES,
  RECOVERY_STATE_WITHOUT_CHECKOUT_ID,
  type RecoveryMachineEvent,
  type RecoveryNode,
  recoveryCheckoutIdAgrees,
} from "#payment/sumup-recovery-machine-spec.ts";
import {
  collectMachineFacts,
  representativeFields,
} from "#scripts/verify-models/attempt.ts";
import {
  type ModelDataSource,
  moveFields,
  type TlaFact,
  tlaModule,
  tlaRecords,
  tlaSet,
} from "#scripts/verify-models/data.ts";
import { movesIn } from "#shared/schema-atlas/machine-spec.ts";

/* jscpd:ignore-end */

const nodeFields = {
  moneyOwed: "Str",
  prunable: "Bool",
  state: "Str",
} as const;
const recoveryRepresentativeFields = {
  ...representativeFields,
  checkoutIdAgrees: "Bool",
  hasCheckoutId: "Bool",
  storedState: "Str",
} as const;
const recoveryMoveFields = {
  ...moveFields,
  sampleTag: "Str",
  sourceHasCheckoutId: "Bool",
  targetCheckoutIdAgrees: "Bool",
  targetHasCheckoutId: "Bool",
} as const;

const declared = movesIn(RECOVERY_MOVES);

// Checkout-id presence and the reader's agreement are independent observations.
export const sumupModelData: ModelDataSource = async () => {
  const facts = collectMachineFacts(
    RECOVERY_NODES,
    RECOVERY_EVENTS,
    declared,
    (state) => ({
      checkoutIdAgrees: recoveryCheckoutIdAgrees(state),
      hasCheckoutId: state.sumupId !== "",
      storedState: state.recoveryState,
    }),
    (representative, event, to): TlaFact<typeof recoveryMoveFields> | null => {
      if (to === null) return null;
      const from = representative.state;
      return {
        eventId: event.id,
        sampleTag: representative.tag,
        sourceHasCheckoutId: from.sumupId !== "",
        sourceState: from.recoveryState,
        targetCheckoutIdAgrees: recoveryCheckoutIdAgrees(to),
        targetHasCheckoutId: to.sumupId !== "",
        targetState: to.recoveryState,
      };
    },
  );
  const checkEvents = pipe(
    filter((event: RecoveryMachineEvent) => event.kind === "check"),
    map((event) => event.id),
  )(RECOVERY_EVENTS);
  const nodeFacts = map(
    (node: RecoveryNode): TlaFact<typeof nodeFields> => ({
      moneyOwed: node.owesMoney,
      prunable: node.prunable,
      state: node.id,
    }),
  )(RECOVERY_NODES);
  return tlaModule("SumupRecoveryData", [
    `RecoveryStates == ${tlaSet(map((node: RecoveryNode) => node.id)(RECOVERY_NODES))}`,
    `NoCheckoutIdState == ${JSON.stringify(RECOVERY_STATE_WITHOUT_CHECKOUT_ID)}`,
    `CheckEvents == ${tlaSet(checkEvents)}`,
    `CheckableStates == ${tlaSet(RECOVERY_CHECKABLE_NODES)}`,
    `PrunableStates == ${tlaSet(RECOVERY_PRUNABLE_NODES)}`,
    tlaRecords("RecoveryNodeFacts", nodeFields, nodeFacts),
    tlaRecords(
      "RecoveryRepresentatives",
      recoveryRepresentativeFields,
      facts.representatives,
    ),
    tlaRecords("RecoveryMoves", recoveryMoveFields, facts.attempts),
  ]);
};
