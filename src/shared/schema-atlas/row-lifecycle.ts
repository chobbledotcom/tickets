/** The payment row machine on `/admin/schema`, drawn from the shared
 * machine spec.
 *
 * The shapes and transitions live in `row-machine-spec.ts`, where the
 * mirror test executes every (node × event × shape) cell against the real
 * row functions. This module adds layout, wording keys, and the lifecycle
 * facts for the worst work each node carries. */

import {
  PAYMENT_ROW_LIFECYCLE,
  paymentWorkFor,
} from "#shared/payment/admit-move.ts";
import {
  ROW_EVENTS,
  ROW_NODES,
  type RowNodeId,
  rowNodeOf,
} from "#shared/payment/row-machine-spec.ts";
import type { PaymentRowState } from "#shared/payment/row-state.ts";
import {
  atlasStatesFromSpec,
  type MachineLayouts,
} from "#shared/schema-atlas/machine-spec.ts";
import type { AtlasMachine, AtlasState } from "#shared/schema-atlas/types.ts";

/** Where each node sits on the map: free on the left, the held column up
 * top, the ownerless work below it, and the ended row at the bottom. */
const LAYOUTS: MachineLayouts<RowNodeId> = {
  claim: { x: 370, y: 110 },
  claim_review: { x: 640, y: 110 },
  claim_review_unrecorded: { x: 900, y: 110 },
  claim_unrecorded: { x: 370, y: 400 },
  free: { x: 110, y: 250 },
  review: { x: 640, y: 250 },
  review_unrecorded: { x: 900, y: 250 },
  settled: { x: 110, y: 540 },
  unrecorded: { x: 640, y: 400 },
};

/** The lifecycle's words for the worst work this node carries; a node with
 * no live work carries no facts — its detail copy says why. */
const rowFacts = (state: PaymentRowState): AtlasState["facts"] => {
  const work = paymentWorkFor([state]);
  const entry = Object.values(PAYMENT_ROW_LIFECYCLE).find(
    (candidate) => candidate.status === work.status,
  );
  if (entry === undefined) return [];
  return [
    { labelKey: "schema.fact.cleared_by", value: entry.clearedBy },
    { labelKey: "schema.fact.route", value: entry.operatorRoute },
    { labelKey: "schema.fact.status", value: entry.status },
  ];
};

/** The whole row machine: shapes from the spec's constructors, edges from
 * the real transitions succeeding. */
export const rowLifecycleAtlas = (): AtlasMachine => ({
  id: "row",
  introKey: "schema.row.intro",
  states: atlasStatesFromSpec(
    { events: ROW_EVENTS, nodeOf: rowNodeOf, nodes: ROW_NODES },
    "schema.row.state",
    LAYOUTS,
    ({ id, reps }) => ({
      facts: rowFacts(reps[0]!.state),
      ...(id === "free" ? { start: true as const } : {}),
    }),
  ),
  titleKey: "schema.row.title",
});
