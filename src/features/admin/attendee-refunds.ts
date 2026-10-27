/** Admin attendee refund routes. */
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import { bulkRefundHandlers } from "./attendee-refunds/bulk.ts";
import { singleRefundHandlers } from "./attendee-refunds/single.ts";

export const adminHandlers = defineAdminRoutes({
  ...singleRefundHandlers,
  ...bulkRefundHandlers,
});
