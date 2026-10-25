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
import { collectMachineFacts } from "#scripts/verify-models/attempt.ts";
import {
  type ModelDataSource,
  tlaModule,
  tlaSet,
  tlaTuples,
} from "#scripts/verify-models/data.ts";
import { movesIn } from "#shared/schema-atlas/machine-spec.ts";

/* jscpd:ignore-end */

type RepresentativeFact = readonly [
  state: string,
  hasCheckoutId: boolean,
  checkoutIdAgrees: boolean,
];

type MoveFact = readonly [
  source: string,
  representative: string,
  sourceHasCheckoutId: boolean,
  event: string,
  target: string,
  targetHasCheckoutId: boolean,
  targetCheckoutIdAgrees: boolean,
];

const declared = movesIn(RECOVERY_MOVES);

/** Execute every representative/event pair. Only opaque checkout-id values
 * are abstracted away: their presence and the real reader's agreement result
 * remain separate facts. A declared move with an invalid output must throw,
 * not disappear as a refusal. Mirror sweeps still check refused cells. */
export const sumupModelData: ModelDataSource = async () => {
  const facts = collectMachineFacts(
    RECOVERY_NODES,
    RECOVERY_EVENTS,
    declared,
    (state): RepresentativeFact => [
      state.recoveryState,
      state.sumupId !== "",
      recoveryCheckoutIdAgrees(state),
    ],
    (representative, event, to): MoveFact | null => {
      if (to === null) return null;
      const from = representative.state;
      return [
        from.recoveryState,
        representative.tag,
        from.sumupId !== "",
        event.id,
        to.recoveryState,
        to.sumupId !== "",
        recoveryCheckoutIdAgrees(to),
      ];
    },
  );
  const checkEvents = pipe(
    filter((event: RecoveryMachineEvent) => event.kind === "check"),
    map((event) => event.id),
  )(RECOVERY_EVENTS);
  const nodeFacts = map(
    (node: RecoveryNode): readonly [string, string, boolean] => [
      node.id,
      node.owesMoney,
      node.prunable,
    ],
  )(RECOVERY_NODES);
  return tlaModule("SumupRecoveryData", [
    `RecoveryStates == ${tlaSet(map((node: RecoveryNode) => node.id)(RECOVERY_NODES))}`,
    `NoCheckoutIdState == ${JSON.stringify(RECOVERY_STATE_WITHOUT_CHECKOUT_ID)}`,
    `CheckEvents == ${tlaSet(checkEvents)}`,
    `CheckableStates == ${tlaSet(RECOVERY_CHECKABLE_NODES)}`,
    `PrunableStates == ${tlaSet(RECOVERY_PRUNABLE_NODES)}`,
    `\\* @type: Set(<<Str, Str, Bool>>);\nRecoveryNodeFacts == ${tlaTuples(nodeFacts)}`,
    `\\* @type: Set(<<Str, Str, Str, Bool, Bool>>);\nRecoveryRepresentatives == ${tlaTuples(facts.representatives)}`,
    `\\* @type: Set(<<Str, Str, Bool, Str, Str, Bool, Bool>>);\nRecoveryMoves == ${tlaTuples(facts.attempts)}`,
  ]);
};
