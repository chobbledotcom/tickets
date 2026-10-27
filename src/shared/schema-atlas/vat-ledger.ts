import {
  atlasMachineFrom,
  factsFromNode,
} from "#shared/schema-atlas/machine-spec.ts";
import { TAX_EVENTS, TAX_NODES, taxNodeOf } from "#shared/tax/machine-spec.ts";

/** Settings are independent. Self-loops do not mean an assessment changed. */
export const vatLedgerAtlas = atlasMachineFrom(
  { events: TAX_EVENTS, nodeOf: taxNodeOf, nodes: TAX_NODES },
  {
    extraOf: factsFromNode(() => [], "active"),
    id: "vat",
    layouts: { active: { x: 200, y: 160 }, refunded: { x: 650, y: 160 } },
  },
);
