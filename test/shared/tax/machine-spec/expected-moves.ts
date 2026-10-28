import type { MachineMoves } from "#shared/schema-atlas/machine-spec.ts";
import {
  TAX_EVENTS,
  TAX_NODES,
  type TaxEventId,
  type TaxNodeId,
} from "#shared/tax/machine-spec.ts";

/** Independent contract table. Refused stale writes are intentionally absent. */
export const EXPECTED_MOVES: MachineMoves<TaxNodeId, TaxEventId> =
  Object.fromEntries(
    TAX_NODES.map(({ id }) => [
      id,
      Object.fromEntries(
        TAX_EVENTS.filter((item) => !item.stale).map((item) => [
          item.id,
          item.action === "refund" ? "refunded" : id,
        ]),
      ),
    ]),
  ) as MachineMoves<TaxNodeId, TaxEventId>;
