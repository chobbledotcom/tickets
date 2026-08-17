/** Admin attendee refund routes. */
import { defineRoutes } from "#routes/router.ts";
import { bulkRefundHandlers } from "./attendee-refunds/bulk.ts";
import { singleRefundHandlers } from "./attendee-refunds/single.ts";

export const adminHandlers = defineRoutes({
  ...singleRefundHandlers,
  ...bulkRefundHandlers,
});
