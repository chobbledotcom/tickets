/**
 * Example API responses for documentation.
 *
 * These constants are rendered in the admin guide. A test validates
 * that calling toPublicEvent() with the same inputs produces matching
 * output, so a shape change will break the test and force an update.
 */

import { type PublicEvent, toPublicEvent } from "#routes/api.ts";
import type { EventWithCount } from "#lib/types.ts";
import { EXAMPLE_EVENT } from "#lib/webhook-example.ts";

/** Example event matching the webhook example data */
export const API_EXAMPLE_EVENT: EventWithCount = {
  id: 1,
  name: EXAMPLE_EVENT.name,
  description:
    "A hands-on workshop covering watercolours and sketching techniques. All materials provided.",
  date: "Sat 20 Aug 2025, 10:00 AM",
  location: "Village Hall",
  slug: EXAMPLE_EVENT.slug,
  slug_index: EXAMPLE_EVENT.slug,
  group_id: 0,
  created: "2025-07-01T00:00:00.000Z",
  max_attendees: 20,
  thank_you_url: "",
  unit_price: EXAMPLE_EVENT.unit_price,
  max_quantity: 5,
  webhook_url: "",
  active: true,
  fields: "email",
  closes_at: null,
  event_type: "standard",
  bookable_days: [],
  minimum_days_before: 1,
  maximum_days_after: 30,
  image_url: "",
  non_transferable: false,
  can_pay_more: false,
  max_price: EXAMPLE_EVENT.unit_price,
  hidden: false,
  attendee_count: 3,
};

/** The example PublicEvent, produced by toPublicEvent */
export const API_EXAMPLE_PUBLIC_EVENT: PublicEvent = toPublicEvent(
  API_EXAMPLE_EVENT,
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
    name: "Alice Smith",
    email: "alice@example.com",
    phone: "+44 7700 900000",
    quantity: 2,
    date: "2025-08-20",
    customPrice: 10.00,
  },
  null,
  2,
);
