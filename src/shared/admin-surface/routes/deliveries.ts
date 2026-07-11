import { operation, route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getDeliveries", "deliveries", "GET", "/admin/deliveries"),
  operation("postDeliveriesMark", "deliveries", "/admin/deliveries/mark"),
] as const;
