import { backfillReversesGroup } from "#accounting/reverses-group.ts";
import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-09-11_refund_order_link",
  "Add transfers.reverses_group — the booking-order event group each refund " +
    "leg reverses — and backfill it onto every stored refund leg, so the " +
    "refunded-status projection can ask per booking order instead of per " +
    "attendee and listing. mapRefund is the only poster of refund legs and " +
    "stamps the link going forward; the backfill re-derives the same " +
    "attribution for historical legs and refuses loudly on any refund leg " +
    "no derivation can attribute.",
  {
    columns: { transfers: ["reverses_group"] },
    indexes: ["idx_transfers_reverses_group"],
  },
  async () => {
    await backfillReversesGroup();
  },
);
