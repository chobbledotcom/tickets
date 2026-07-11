import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getAttendeesByAttendeeIdRefund",
    "attendeeRefunds",
    "GET",
    "/admin/attendees/:attendeeId/refund",
  ),
  route(
    "getListingByIdRefundAll",
    "attendeeRefunds",
    "GET",
    "/admin/listing/:id/refund-all",
  ),
  route(
    "postAttendeesByAttendeeIdRefund",
    "attendeeRefunds",
    "POST",
    "/admin/attendees/:attendeeId/refund",
  ),
  route(
    "postListingByIdRefundAll",
    "attendeeRefunds",
    "POST",
    "/admin/listing/:id/refund-all",
  ),
] as const;
