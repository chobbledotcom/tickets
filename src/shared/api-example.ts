/**
 * Example API responses for documentation.
 *
 * These constants are rendered in the admin guide. A test validates
 * that calling toPublicEvent() with the same inputs produces matching
 * output, so a shape change will break the test and force an update.
 */

import { type PublicEvent, toPublicEvent } from "#routes/api/index.ts";
import type { EventWithCount } from "#shared/types.ts";
import { EXAMPLE_EVENT } from "#shared/webhook-example.ts";

/** Example event matching the webhook example data */
export const API_EXAMPLE_EVENT: EventWithCount = {
  active: true,
  assign_built_site: false,
  attachment_name: "",
  attachment_url: "",
  attendee_count: 3,
  bookable_days: [],
  can_pay_more: false,
  closes_at: null,
  created: "2025-07-01T00:00:00.000Z",
  date: "Sat 20 Aug 2025, 10:00 AM",
  description:
    "A hands-on workshop covering watercolours and sketching techniques. All materials provided.",
  event_type: "standard",
  fields: "email",
  group_id: 0,
  hidden: false,
  id: 1,
  image_url: "",
  location: "Village Hall",
  max_attendees: 20,
  max_price: EXAMPLE_EVENT.unit_price,
  max_quantity: 5,
  maximum_days_after: 30,
  minimum_days_before: 1,
  months_per_unit: 0,
  initial_site_months: 0,
  name: EXAMPLE_EVENT.name,
  non_transferable: false,
  purchase_only: false,
  slug: EXAMPLE_EVENT.slug,
  slug_index: EXAMPLE_EVENT.slug,
  thank_you_url: "",
  unit_price: EXAMPLE_EVENT.unit_price,
  webhook_url: "",
};

/** The example PublicEvent, produced by toPublicEvent */
export const API_EXAMPLE_PUBLIC_EVENT: PublicEvent = toPublicEvent(
  API_EXAMPLE_EVENT,
  false,
  undefined,
  undefined,
);

/** Example list response JSON */
export const API_LIST_EXAMPLE_JSON: string = JSON.stringify(
  { events: [API_EXAMPLE_PUBLIC_EVENT] },
  null,
  2,
);

/** Example single-event response JSON */
export const API_SINGLE_EXAMPLE_JSON: string = JSON.stringify(
  {
    event: {
      ...API_EXAMPLE_PUBLIC_EVENT,
      availableDates: ["2025-08-20", "2025-08-21"],
    },
  },
  null,
  2,
);

/** Example availability response JSON */
export const API_AVAILABILITY_EXAMPLE_JSON: string = JSON.stringify(
  { available: true },
  null,
  2,
);

/** Example free booking response JSON */
export const API_BOOK_FREE_EXAMPLE_JSON: string = JSON.stringify(
  { ticketToken: "A1B2C3D4E5", ticketUrl: "/t/A1B2C3D4E5" },
  null,
  2,
);

/** Example paid booking response JSON */
export const API_BOOK_PAID_EXAMPLE_JSON: string = JSON.stringify(
  { checkoutUrl: "https://checkout.stripe.com/c/pay/cs_live_..." },
  null,
  2,
);

/** Example booking request body */
export const API_BOOK_REQUEST_JSON: string = JSON.stringify(
  {
    customPrice: 10.0,
    date: "2025-08-20",
    email: "alice@example.com",
    name: "Alice Smith",
    phone: "+44 7700 900000",
    quantity: 2,
  },
  null,
  2,
);
