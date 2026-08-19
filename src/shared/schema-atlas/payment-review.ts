/** The payment-review machine on `/admin/schema`, drawn from the shared
 * machine spec.
 *
 * The slots and transitions live in `review-machine-spec.ts`, where the
 * mirror test executes every (node × event × shape) cell against the real
 * review functions. This module only adds layout; one source feeds the map
 * and the checks, so they cannot drift apart. */

import {
  REVIEW_EVENTS,
  REVIEW_NODES,
  type ReviewNodeId,
  reviewNodeOf,
} from "#payment/review-machine-spec.ts";
/* jscpd:ignore-start -- imports */
import {
  atlasStatesFromSpec,
  type MachineLayouts,
} from "#shared/schema-atlas/machine-spec.ts";
import type { AtlasMachine } from "#shared/schema-atlas/types.ts";

/* jscpd:ignore-end */

/** Where each node sits on the map. */
const LAYOUTS: MachineLayouts<ReviewNodeId> = {
  none: { x: 140, y: 160 },
  open: { x: 480, y: 160 },
  seen: { x: 820, y: 160 },
};

/** The whole review machine: slots from the spec's constructors, edges
 * from the real functions succeeding. */
export const paymentReviewAtlas = (): AtlasMachine => ({
  id: "review",
  introKey: "schema.review.intro",
  states: atlasStatesFromSpec(
    { events: REVIEW_EVENTS, nodeOf: reviewNodeOf, nodes: REVIEW_NODES },
    "schema.review.state",
    LAYOUTS,
    ({ id }) => (id === "none" ? { start: true as const } : {}),
  ),
  titleKey: "schema.review.title",
});
