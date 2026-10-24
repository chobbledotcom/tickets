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
import { tlaModule, tlaSet, tlaTuples } from "#scripts/verify-models/data.ts";
import { movesIn } from "#shared/schema-atlas/machine-spec.ts";
import { attemptTransition } from "#shared/schema-atlas/types.ts";

/* jscpd:ignore-end */

type RepresentativeFact = readonly [
  node: string,
  representative: string,
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

/** Refusal is expected only where the production table has no move. */
const recoveryOutcomeOrNull = (
  node: RecoveryNode,
  representative: RecoveryNode["reps"][number],
  event: RecoveryMachineEvent,
) =>
  declared.expected(node.id, event.id, representative.tag) === "refused"
    ? attemptTransition(event.run, representative.state)
    : event.run(representative.state);

/** Execute every representative/event pair. Only opaque checkout-id values
 * are abstracted away: their presence and the real reader's agreement result
 * remain separate facts. A declared move with an invalid output must throw,
 * not disappear as a refusal. Mirror sweeps still check refused cells. */
export const sumupModelData = async (): Promise<string> => {
  const representatives: RepresentativeFact[] = [];
  const moves: MoveFact[] = [];
  for (const node of RECOVERY_NODES) {
    for (const representative of node.reps) {
      const from = representative.state;
      representatives.push([
        node.id,
        representative.tag,
        from.recoveryState,
        from.sumupId !== "",
        recoveryCheckoutIdAgrees(from),
      ]);
      for (const event of RECOVERY_EVENTS) {
        const to = recoveryOutcomeOrNull(node, representative, event);
        if (to === null) continue;
        moves.push([
          from.recoveryState,
          representative.tag,
          from.sumupId !== "",
          event.id,
          to.recoveryState,
          to.sumupId !== "",
          recoveryCheckoutIdAgrees(to),
        ]);
      }
    }
  }
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
    `\\* @type: Set(<<Str, Str, Str, Bool, Bool>>);\nRecoveryRepresentatives == ${tlaTuples(representatives)}`,
    `\\* @type: Set(<<Str, Str, Bool, Str, Str, Bool, Bool>>);\nRecoveryMoves == ${tlaTuples(moves)}`,
  ]);
};
