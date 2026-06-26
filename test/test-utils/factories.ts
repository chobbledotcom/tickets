import type { PricedLine, PricedOrder } from "#shared/checkout-pricing.ts";
import type { BuiltSite } from "#shared/db/built-sites.ts";
import type { ListingInput } from "#shared/db/listings.ts";
import type {
  Answer,
  AttendeeQuestionData,
  QuestionDisplayType,
  QuestionWithAnswers,
} from "#shared/db/questions.ts";
import type { EmailEntry, EmailListing } from "#shared/email.ts";
import { signPriceSync } from "#shared/payment-signature.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import type {
  Attendee,
  Group,
  Holiday,
  Listing,
  ListingWithCount,
} from "#shared/types.ts";
import type { WebhookAttendee } from "#shared/webhook.ts";
import { generateTestListingName } from "#test-utils/internal.ts";

export const testListing = (overrides: Partial<Listing> = {}): Listing => ({
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
  customisable_days: false,
  date: "",
  day_prices: {},
  description: "",
  duration_days: 1,
  fields: "email",
  group_id: 0,
  hidden: false,
  id: 1,
  image_url: "",
  initial_site_months: 0,
  listing_type: "standard",
  location: "",
  max_attendees: 100,
  max_price: 0,
  max_quantity: 1,
  maximum_days_after: 0,
  minimum_days_before: 0,
  months_per_unit: 0,
  name: "Test Listing",
  non_transferable: false,
  purchase_only: false,
  slug: "ab12c",
  slug_index: "test-listing-index",
  thank_you_url: "https://example.com/thanks",
  unit_price: 0,
  uses_logistics: false,
  webhook_url: "",
  ...overrides,
});

export const testListingWithCount = (
  overrides: Partial<ListingWithCount> = {},
): ListingWithCount => ({
  ...testListing(overrides),
  attendee_count: 0,
  income: 0,
  tickets_count: 0,
  ...overrides,
});

export const testAttendee = (overrides: Partial<Attendee> = {}): Attendee => ({
  address: "",
  attachment_downloads: 0,
  checked_in: false,
  created: "2024-01-01T12:00:00Z",
  date: null,
  email: "john@example.com",
  end_date: null,
  id: 1,
  listing_id: 1,
  name: "John Doe",
  payment_id: "",
  phone: "",
  pii_blob: "",
  price_paid: "0",
  quantity: 1,
  refunded: false,
  remaining_balance: 0,
  special_instructions: "",
  split_logistics_agents: false,
  status_id: null,
  ticket_token: "test-token-1",
  ticket_token_index: "test-token-index-1",
  ...overrides,
});

/** Build a radio question fixture with answer options. Each `[id, text]` pair
 * becomes an active answer whose sort_order follows the array order. */
export const testRadioQuestion = (
  id: number,
  text: string,
  answers: [number, string][],
): QuestionWithAnswers => ({
  answers: answers.map(([answerId, answerText], sort_order) => ({
    active: true,
    id: answerId,
    question_id: id,
    sort_order,
    text: answerText,
  })),
  display_type: "radio",
  id,
  text,
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

/** Factory for an {@link Answer}: `active` defaults to `true` and the
 *  `question_id`/`sort_order`/`id` defaults mirror the most common test shape
 *  (a single question with id 1 and answers 10, 11, … in sort order). Override
 *  only the fields a given test actually varies. */
export const testAnswer = (overrides: Partial<Answer> = {}): Answer => ({
  active: true,
  id: 10,
  question_id: 1,
  sort_order: 0,
  text: "A",
  ...overrides,
});

/** Factory for a {@link QuestionWithAnswers}: `display_type` defaults to
 *  `"radio"` (the overwhelmingly common case in tests) with no answers, so a
 *  radio/dropdown/free-text question is built by overriding `display_type` and
 *  passing `answers`. The returned type keeps `display_type` as the literal
 *  {@link QuestionDisplayType}, so callers no longer need `… as const` on the
 *  field. */
export const testQuestion = (
  overrides: Partial<QuestionWithAnswers> = {},
): QuestionWithAnswers => ({
  answers: [],
  display_type: "radio",
  id: 1,
  text: "Question?",
  ...overrides,
});

export const testBuiltSite = (
  overrides: Partial<BuiltSite> = {},
): BuiltSite => ({
  assignable: false,
  assignedAttendeeId: null,
  assignedListingId: null,
  bunnyScriptId: "",
  bunnyUrl: "https://test.b-cdn.net",
  created: "2026-01-01T00:00:00Z",
  dbToken: "",
  dbUrl: "",
  id: 1,
  name: "Test Site",
  readOnlyFrom: "",
  renewalToken: null,
  renewalTokenIndex: null,
  updates: "release",
  ...overrides,
});

export const testListingInput = (
  overrides: Partial<Omit<ListingInput, "slugIndex" | "slug">> = {},
): Omit<ListingInput, "slugIndex" | "slug"> => ({
  maxAttendees: 100,
  maxPrice: 10000,
  name: generateTestListingName(),
  thankYouUrl: "https://example.com/thanks",
  ...overrides,
});

export const baseListingForm: Record<string, string> = {
  max_attendees: "100",
  max_quantity: "1",
  name: "My Listing",
  thank_you_url: "https://example.com",
};

export const webhookMeta = (
  metadata: Partial<SessionMetadata> & { name: string },
): SessionMetadata => ({
  _origin: "localhost",
  address: "",
  allocations: "",
  answer_ids: "",
  balance_attendee_id: "",
  date: "",
  day_count: "",
  email: "",
  items: "",
  modifiers: "",
  phone: "",
  price_proof: "",
  reservation_amount: "",
  site_token_index: "",
  special_instructions: "",
  text_answer_ids: "",
  thank_you_url: "",
  ...metadata,
});

/**
 * Add a valid price signature to a metadata record, the way production's
 * buildItemsMetadata does, so a webhook test can exercise the signed-oracle
 * path. agreedTotal is the total the buyer was charged (the session
 * amount_total). Unsigned metadata (plain webhookMeta) takes the webhook's
 * legacy re-derived fallback instead.
 */
export const signMeta = (
  metadata: Record<string, string>,
  agreedTotal: number,
): Record<string, string> => ({
  ...metadata,
  price_proof: `${agreedTotal}.${signPriceSync(metadata, agreedTotal)}`,
});

/**
 * webhookMeta plus a valid price signature in one step — the common shape for a
 * webhook/redirect test whose session should be PROCESSED (a "trusted"
 * session). `agreedTotal` must equal the session's amount_total so the session
 * classifies as trusted; an unsigned (plain webhookMeta) session now classifies
 * as "ignore" and is acknowledged without processing or refunding.
 */
export const signedMeta = (
  metadata: Partial<SessionMetadata> & { name: string },
  agreedTotal: number,
): SessionMetadata =>
  signMeta(webhookMeta(metadata), agreedTotal) as SessionMetadata;

export const singleItem = (
  listingId: number,
  quantity: number,
  price: number,
): string => JSON.stringify([{ e: listingId, p: price, q: quantity }]);

export const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

export const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

export const makeTestListing = (
  overrides: Partial<EmailListing> = {},
): EmailListing => ({
  active: true,
  assign_built_site: false,
  attendee_count: 10,
  can_pay_more: false,
  customisable_days: false,
  date: "",
  day_prices: {},
  duration_days: 1,
  hidden: false,
  id: 1,
  initial_site_months: 0,
  listing_type: "standard",
  location: "",
  max_attendees: 100,
  months_per_unit: 0,
  name: "Test Listing",
  purchase_only: false,
  slug: "test-listing",
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
  end_date: null,
  id: 42,
  name: "Jane Doe",
  payment_id: "",
  phone: "555-1234",
  price_paid: "0",
  quantity: 1,
  remaining_balance: 0,
  special_instructions: "",
  ticket_token: "AABB001122",
  ...overrides,
});

export const makeTestEntry = (
  listingOverrides?: Partial<EmailListing>,
  attendeeOverrides?: Partial<WebhookAttendee>,
): EmailEntry => ({
  attendee: makeTestAttendee(attendeeOverrides),
  listing: makeTestListing(listingOverrides),
});

/** Factory for a {@link PricedLine}: `chargedUnitAmount` defaults to `unitPrice`
 *  but can be overridden to test discount/non-discount pricing paths. */
export const pricedLine = (
  listingId: number,
  unitPrice: number,
  quantity: number,
  chargedUnitAmount = unitPrice,
): PricedLine => ({
  chargedUnitAmount,
  item: {
    listingId,
    name: `L${listingId}`,
    quantity,
    slug: `l${listingId}`,
    unitPrice,
  },
  quantity,
});

/** Factory for a {@link PricedOrder}: all totals default to zero so a test
 *  only spells out the fields it varies (e.g. `lines`, `extras`). */
export const pricedOrder = (
  overrides: Partial<PricedOrder> = {},
): PricedOrder => ({
  extras: [],
  fullSubtotal: 0,
  lines: [],
  modifierApplications: [],
  total: 0,
  ...overrides,
});

/** The canonical "Size?" question answer-data fixture used by both the
 *  detail-rows unit tests and the admin questions template tests: three
 *  attendees (ids 1, 2, 3) answering a single "Size?" question (id 1) with
 *  answers Small (id 10, picked by attendees 1 and 2) and Large (id 11,
 *  picked by attendee 3). Returns the {@link AttendeeQuestionData} shape
 *  `buildAnswerSummaryRows`/`AttendeeTable` consume. */
export const sizeQuestionAnswerData = (): AttendeeQuestionData => ({
  attendeeAnswerMap: new Map([
    [1, [10]],
    [2, [10]],
    [3, [11]],
  ]),
  questions: [
    testQuestion({
      answers: [
        testAnswer({ id: 10, sort_order: 0, text: "Small" }),
        testAnswer({ id: 11, sort_order: 1, text: "Large" }),
      ],
      id: 1,
      text: "Size?",
    }),
  ],
});

export const unselectedAnswerQuestionData = (): AttendeeQuestionData => ({
  attendeeAnswerMap: new Map(),
  questions: [
    testQuestion({
      answers: [testAnswer({ id: 10, text: "A" })],
      id: 1,
      text: "Q?",
    }),
  ],
});
