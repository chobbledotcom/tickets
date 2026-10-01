/** The Square link-end machine on `/admin/schema`, drawn from the shared
 * machine spec.
 *
 * The nodes, the events and the moves live in
 * `square-link-end-machine-spec.ts`, where the mirror test executes every
 * (node × event) cell against the real transition. This module only adds
 * layout and the one fact an operator needs at a glance: whether the link
 * behind a row can still take payment. */

import {
  LINK_END_EVENTS,
  LINK_END_NODES,
  type SquareLinkEndRow,
} from "#payment/square-link-end-machine-spec.ts";
/* jscpd:ignore-start -- imports */
import {
  atlasMachineFrom,
  factsFromNode,
  type MachineLayouts,
} from "#shared/schema-atlas/machine-spec.ts";
import type { AtlasMachine } from "#shared/schema-atlas/types.ts";

/* jscpd:ignore-end */

/** Where each node sits on the map: the row's life from left to right, the
 * lease in the middle, and both ways a row leaves on the right. */
const LAYOUTS: MachineLayouts<string> = {
  ending: { x: 620, y: 240 },
  gone: { x: 900, y: 240 },
  pending: { x: 380, y: 240 },
  unwritten: { x: 140, y: 240 },
};

/** The whole link-end machine, with each node's operator-facing fact. Drawn
 * once when this module loads. */
export const squareLinkEndAtlas: AtlasMachine = atlasMachineFrom(
  {
    events: LINK_END_EVENTS,
    nodeOf: (row: SquareLinkEndRow) => row.state,
    nodes: LINK_END_NODES,
  },
  {
    extraOf: factsFromNode(
      (node) => [
        {
          labelKey: "schema.square_link_ends.fact.takes_payment",
          value: node.takesPayment,
        },
      ],
      "unwritten",
    ),
    id: "square_link_ends",
    layouts: LAYOUTS,
  },
);
