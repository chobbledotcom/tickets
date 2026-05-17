import type { BuiltSite } from "#shared/db/built-sites.ts";
import type { EventInput } from "#shared/db/events.ts";
import type { EmailEntry, EmailEvent } from "#shared/email.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import type {
  Attendee,
  Event,
  EventWithCount,
  Group,
  Holiday,
} from "#shared/types.ts";
import type { WebhookAttendee } from "#shared/webhook.ts";
import { generateTestEventName } from "#test-utils/internal.ts";

export const testEvent = (overrides: Partial<Event> = {}): Event => ({
  active: true,
  assign_built_site: false,
  attachment_name: "",
  attachment_url: "",
  bookable_days: [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ],
  can_pay_more: false,
  closes_at: null,
  created: "2024-01-01T00:00:00Z",
  date: "",
  description: "",
  event_type: "standard",
  fields: "email",
  group_id: 0,
  hidden: false,
  id: 1,
  image_url: "",
  initial_site_months: 0,
  location: "",
  max_attendees: 100,
  max_price: 0,
  max_quantity: 1,
  maximum_days_after: 0,
  minimum_days_before: 0,
  months_per_unit: 0,
  name: "Test Event",
  non_transferable: false,
  purchase_only: false,
  slug: "ab12c",
  slug_index: "test-event-index",
  thank_you_url: "https://example.com/thanks",
  unit_price: 0,
  webhook_url: "",
  ...overrides,
});

export const testEventWithCount = (
  overrides: Partial<EventWithCount> = {},
): EventWithCount => ({
  ...testEvent(overrides),
  attendee_count: 0,
  ...overrides,
});

export const testAttendee = (overrides: Partial<Attendee> = {}): Attendee => ({
  address: "",
  attachment_downloads: 0,
  checked_in: false,
  created: "2024-01-01T12:00:00Z",
  date: null,
  email: "john@example.com",
  event_id: 1,
  id: 1,
  name: "John Doe",
  payment_id: "",
  phone: "",
  pii_blob: "",
  price_paid: "0",
  quantity: 1,
  refunded: false,
  special_instructions: "",
  ticket_token: "test-token-1",
  ticket_token_index: "test-token-index-1",
  ...overrides,
});

export const testGroup = (overrides: Partial<Group> = {}): Group => ({
  description: "",
  hidden: false,
  id: 1,
  max_attendees: 0,
  name: "Test Group",
  slug: "test-group",
  slug_index: "test-group-index",
  terms_and_conditions: "",
  ...overrides,
});

export const testHoliday = (overrides: Partial<Holiday> = {}): Holiday => ({
  end_date: "2026-12-25",
  id: 1,
  name: "Test Holiday",
  start_date: "2026-12-25",
  ...overrides,
});

export const testBuiltSite = (
  overrides: Partial<BuiltSite> = {},
): BuiltSite => ({
  assignable: false,
  assignedAttendeeId: null,
  assignedEventId: null,
  bunnyScriptId: "",
  bunnyUrl: "https://test.b-cdn.net",
  created: "2026-01-01T00:00:00Z",
  dbToken: "",
  dbUrl: "",
  id: 1,
  name: "Test Site",
  readOnlyFrom: "",
  renewalTierEventId: null,
  renewalTokenIndex: null,
  ...overrides,
});

export const testEventInput = (
  overrides: Partial<Omit<EventInput, "slugIndex" | "slug">> = {},
): Omit<EventInput, "slugIndex" | "slug"> => ({
  maxAttendees: 100,
  maxPrice: 10000,
  name: generateTestEventName(),
  thankYouUrl: "https://example.com/thanks",
  ...overrides,
});

export const baseEventForm: Record<string, string> = {
  max_attendees: "100",
  max_quantity: "1",
  name: "My Event",
  thank_you_url: "https://example.com",
};

export const webhookMeta = (
  metadata: Partial<SessionMetadata> & { name: string },
): SessionMetadata => ({
  _origin: "localhost",
  address: "",
  answer_ids: "",
  date: "",
  email: "",
  items: "",
  phone: "",
  site_token: "",
  special_instructions: "",
  ...metadata,
});

export const singleItem = (
  eventId: number,
  quantity: number,
  price: number,
): string => JSON.stringify([{ e: eventId, p: price, q: quantity }]);

export const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

export const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

export const makeTestEvent = (
  overrides: Partial<EmailEvent> = {},
): EmailEvent => ({
  assign_built_site: false,
  attendee_count: 10,
  can_pay_more: false,
  date: "",
  id: 1,
  initial_site_months: 0,
  location: "",
  max_attendees: 100,
  months_per_unit: 0,
  name: "Test Event",
  purchase_only: false,
  slug: "test-event",
  unit_price: 0,
  webhook_url: "",
  ...overrides,
});

export const makeTestAttendee = (
  overrides: Partial<WebhookAttendee> = {},
): WebhookAttendee => ({
  address: "",
  date: null,
  email: "jane@example.com",
  id: 42,
  name: "Jane Doe",
  payment_id: "",
  phone: "555-1234",
  price_paid: "0",
  quantity: 1,
  special_instructions: "",
  ticket_token: "AABB001122",
  ...overrides,
});

export const makeTestEntry = (
  eventOverrides?: Partial<EmailEvent>,
  attendeeOverrides?: Partial<WebhookAttendee>,
): EmailEntry => ({
  attendee: makeTestAttendee(attendeeOverrides),
  event: makeTestEvent(eventOverrides),
});
