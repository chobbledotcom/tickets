/** The refund authority machine on `/admin/schema`, drawn from the shared
 * machine spec.
 *
 * The states and transitions live in `refund-machine-spec.ts`, where the
 * mirror test executes every (node × event × representative) cell against
 * the declared expectations. This module only adds what a map needs: layout,
 * wording keys, and the lifecycle facts shown beside each node. One source
 * feeds the map and the checks, so they cannot drift apart. */

import { refundLifecycleFor } from "#shared/payment/refund-authority-lifecycle.ts";
import type { RefundAuthorityState } from "#shared/payment/refund-authority-state.ts";
import {
  REFUND_EVENTS,
  REFUND_NODES,
  type RefundNodeId,
  refundNodeOf,
} from "#shared/payment/refund-machine-spec.ts";
/* jscpd:ignore-start -- imports */
import {
  atlasStatesFromSpec,
  factsAndStart,
  type MachineLayouts,
} from "#shared/schema-atlas/machine-spec.ts";
import type { AtlasMachine, AtlasState } from "#shared/schema-atlas/types.ts";

/* jscpd:ignore-end */

/** Where each node sits on the map. */
const LAYOUTS: MachineLayouts<RefundNodeId> = {
  check: { x: 900, y: 250 },
  choice_not_sent: { x: 370, y: 540 },
  choice_open: { x: 370, y: 400 },
  choice_returned: { x: 640, y: 400 },
  observing: { x: 640, y: 110 },
  ready: { x: 110, y: 250 },
  recorded: { x: 900, y: 540 },
  returned: { x: 640, y: 540 },
  send_armed: { x: 370, y: 110 },
};

/** What the lifecycle declaration says ends this state, and where. */
const lifecycleFacts = (state: RefundAuthorityState): AtlasState["facts"] => {
  const lifecycle = refundLifecycleFor(state);
  return [
    { labelKey: "schema.fact.cleared_by", value: lifecycle.clearedBy },
    { labelKey: "schema.fact.route", value: lifecycle.operatorRoute },
  ];
};

/** The whole refund machine: states from the spec's constructors, edges from
 * the real transitions succeeding. */
export const refundAuthorityAtlas = (): AtlasMachine => ({
  id: "refund",
  introKey: "schema.refund.intro",
  states: atlasStatesFromSpec(
    { events: REFUND_EVENTS, nodeOf: refundNodeOf, nodes: REFUND_NODES },
    "schema.refund.state",
    LAYOUTS,
    factsAndStart(lifecycleFacts, "ready"),
  ),
  titleKey: "schema.refund.title",
});
