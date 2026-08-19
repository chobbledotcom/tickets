/** The SumUp checkout-recovery machine on `/admin/schema`, drawn from the
 * shared machine spec.
 *
 * The nodes, the events and the moves live in
 * `sumup-recovery-machine-spec.ts`, where the mirror test executes every
 * (node × event) cell against the real transition. This module only adds
 * layout and the two facts an operator needs at a glance: whether a state may
 * be holding money nobody has accounted for, and whether it can be deleted. */

import {
  RECOVERY_EVENTS,
  RECOVERY_NODES,
  type RecoveryNodeId,
  recoveryNodeOf,
} from "#shared/payment/sumup-recovery-machine-spec.ts";
/* jscpd:ignore-start -- imports */
import {
  atlasStatesFromSpec,
  type MachineLayouts,
} from "#shared/schema-atlas/machine-spec.ts";
import type { AtlasMachine } from "#shared/schema-atlas/types.ts";

/* jscpd:ignore-end */

/** Where each node sits on the map: creation on the left, the two closed
 * answers on the right, and the state that still owes somebody below. */
const LAYOUTS: MachineLayouts<RecoveryNodeId> = {
  finished: { x: 820, y: 80 },
  owed: { x: 820, y: 400 },
  staged: { x: 140, y: 240 },
  unpaid: { x: 820, y: 240 },
  waiting: { x: 480, y: 240 },
};

/** The whole recovery machine, with each node's two operator-facing facts. */
export const sumupRecoveryAtlas = (): AtlasMachine => ({
  id: "sumup_recovery",
  introKey: "schema.sumup_recovery.intro",
  states: atlasStatesFromSpec(
    { events: RECOVERY_EVENTS, nodeOf: recoveryNodeOf, nodes: RECOVERY_NODES },
    "schema.sumup_recovery.state",
    LAYOUTS,
    (node) => ({
      facts: [
        {
          labelKey: "schema.sumup_recovery.fact.owes_money",
          value: node.owesMoney,
        },
        {
          labelKey: "schema.sumup_recovery.fact.kept",
          value: node.prunable ? "deleted once old" : "kept until answered",
        },
      ],
      ...(node.id === "staged" ? { start: true as const } : {}),
    }),
  ),
  titleKey: "schema.sumup_recovery.title",
});
