/**
 * The set-up the mixed-order stories share. An order can hold bundles, add-ons
 * under a parent, plain things and things booked by the day — and the same
 * thing more than one way. The journey harness walks the real buyer route (the
 * gallery, the combined booking page, the submit) and checks the order that
 * was stored, so these helpers only carry the story's own bookkeeping.
 */

import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import {
  type JourneyCatalog,
  type JourneyCatalogSpec,
  type OrderJourneyCtx,
  runOrderJourney,
  type StoredOrderRow,
} from "#test-utils/order-journey.ts";

/** What the shop sells for this story, kept until the customer orders. */
export const orderCatalog = (
  world: TicketsWorld,
  spec: JourneyCatalogSpec,
): void => {
  world.orderCatalogSpec = spec;
};

/** The customer places the order, through the real buyer journey. */
export const orderJourney = async (
  world: TicketsWorld,
  spec: {
    form: (catalog: JourneyCatalog) => Record<string, string>;
    paid?: boolean;
    rows: (catalog: JourneyCatalog) => StoredOrderRow[];
    select: { packages: string[]; listings: string[]; date?: string };
    through?: (ctx: OrderJourneyCtx) => Promise<void>;
  },
): Promise<OrderJourneyCtx> => {
  const ctx = await runOrderJourney({
    catalog: requiredWorldValue(world.orderCatalogSpec, "what the shop sells"),
    ...spec,
  });
  world.orderCtx = ctx;
  world.attendeeId = ctx.attendeeId;
  return ctx;
};

/** The order the story placed, with the organiser's browser and the catalog. */
export const placedOrder = (world: TicketsWorld): OrderJourneyCtx =>
  requiredWorldValue(world.orderCtx, "the order the customer placed");
