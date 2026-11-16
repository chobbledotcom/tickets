// effects: pure
/** Types for the ticket reservation system. */

import * as v from "valibot";
import type { PairBooking } from "#booking/ticket-moves.ts";
import type {
  BlindIndex,
  EnvKeyEncrypted,
  OwnerKeyEncrypted,
  PasswordHash,
  TokenHash,
  WrappedKey,
} from "#crypto/sealed.ts";
import type { DecodedRowOf } from "#db/select/tables.ts";
import { bindFirst } from "#shared/fp-bind.ts";
import { guardFor } from "#shared/validation/guard.ts";
import { clampInteger, integerAtLeast } from "#shared/validation/number.ts";

/** Type guard: a non-null, non-array object (a Record shape). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Ids for the settings nags that prompt required or recommended setup. */
export type NagId =
  | "payment-provider"
  | "business-email"
  | "domain"
  | "superuser";

/** One settings nag item shown to the admin. */
export type NagItem = {
  /** The nag identifier. */
  id: NagId;
  /** Human-readable description of what needs to be configured. */
  label: string;
  /** Deep link to the settings form where the value can be set. */
  href: string;
};

export const SuperuserChoiceSchema = v.picklist([
  "",
  "self-managed",
  "enabled",
]);

export type SuperuserChoice = v.InferOutput<typeof SuperuserChoiceSchema>;

export const isSuperuserChoice = guardFor(SuperuserChoiceSchema);

/** Schema for an individual contact field name */
export const ContactFieldSchema = v.picklist([
  "email",
  "phone",
  "address",
  "special_instructions",
]);

/** Individual contact field name */
export type ContactField = v.InferOutput<typeof ContactFieldSchema>;

/** All valid contact field names (runtime array matching the ContactField union) */
export const CONTACT_FIELDS = ContactFieldSchema.options;

/** Type guard: check if an arbitrary string is a valid ContactField */
export const isContactField = guardFor(ContactFieldSchema);

/** A listing's contact fields: comma-separated ContactField names, or empty
 *  for name only. `parseListingFields` enforces it at runtime. */
export type ListingFields = string;

/** Attendee contact details — the core PII fields collected at registration */
export type ContactInfo = {
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
};

/** Required name+email with optional phone/address/special_instructions from ContactInfo */
export type ContactFields = Pick<ContactInfo, "name" | "email"> &
  Partial<Pick<ContactInfo, "phone" | "address" | "special_instructions">>;

/** UI theme */
export type Theme = "light" | "dark";

/** Schema for supported payment provider identifiers */
export const PaymentProviderSchema = v.picklist(["stripe", "square", "sumup"]);

/** Supported payment provider identifiers */
export type PaymentProviderType = v.InferOutput<typeof PaymentProviderSchema>;

/** Type guard: check if a string is a valid PaymentProviderType */
export const isPaymentProvider = guardFor(PaymentProviderSchema);

/** Persisted payment-provider setting: an explicit provider, "none" (admin saved
 *  payments-disabled), or absent (never saved — drives the settings nag). */
export const PaymentProviderSettingSchema = v.picklist([
  ...PaymentProviderSchema.options,
  "none",
]);

export type PaymentProviderSetting = v.InferOutput<
  typeof PaymentProviderSettingSchema
>;

/** Type guard: check if a string is a valid PaymentProviderSetting */
export const isPaymentProviderSetting = guardFor(PaymentProviderSettingSchema);

/** Schema for a listing type: standard (one-time) or daily (date-based booking) */
export const ListingTypeSchema = v.picklist(["standard", "daily"]);

/** Listing type: standard (one-time) or daily (date-based booking) */
export type ListingType = v.InferOutput<typeof ListingTypeSchema>;

/** Type guard: check if an arbitrary string is a valid ListingType */
export const isListingType = guardFor(ListingTypeSchema);

/** The persisted email template types: the attendee confirmation and the
 *  admin notification. The discriminator the renderer, the settings store,
 *  and the admin forms all key on. A plain union, because nothing validates
 *  a string against it — every value comes from a typed call. */
export type EmailTemplateType = "confirmation" | "admin";

/** One part of an email template: the subject, the html body, or the text. */
export type EmailTemplateFormat = "subject" | "html" | "text";

/** Whether an listing can accept payments: a flat price, pay-what-you-want, or
 * a customisable-days listing with at least one non-zero day-count price. */
export const isPaidListing = (
  listing: Pick<
    Listing,
    "unitPrice" | "canPayMore" | "customisableDays" | "dayPrices"
  >,
): boolean =>
  listing.unitPrice > 0 ||
  listing.canPayMore ||
  (listing.customisableDays &&
    Object.values(listing.dayPrices).some((price) => price > 0));

/** True when an attendee/booking row is a real ticket (quantity ≥ 1) rather
 * than the no-quantity sentinel (quantity 0) — the one "is this a real
 * ticket, not a ghost" test the readers, rosters, and exports share. */
export const hasTicketQuantity = (row: { quantity: number }): boolean =>
  row.quantity > 0;

/** Upper bound on multi-day booking duration. Each day in a booking range
 * adds a per-day clause to the atomic capacity SQL, so the cap keeps that
 * statement bounded regardless of which write path set the value. */
export const MAX_DURATION_DAYS = 90;

/**
 * Booking durations clamp valid whole numbers to one safe-integer range.
 * Fractions, non-finite numbers, and unsafe integers are rejected.
 */
const clampBookingDuration = clampInteger(1, MAX_DURATION_DAYS);

/** Clamp a valid whole-day count to the supported booking range. */
export const clampDurationDays = (value: number): number => {
  try {
    return clampBookingDuration(value);
  } catch (error) {
    throw new Error(`Invalid booking duration: ${String(value)}`, {
      cause: error,
    });
  }
};

/**
 * Per-day-count ticket prices for "customisable days" listings, in minor
 * units, keyed by the number of days booked. e.g. `{ 1: 1000, 2: 1800 }`
 * means a 1-day booking costs 1000 and a 2-day booking 1800. Only counts
 * present here are offered to the visitor.
 */
export type DayPrices = Record<number, number>;

const DayPriceKeySchema = v.pipe(
  v.string(),
  v.regex(/^[1-9]\d*$/),
  v.check((value) => {
    const days = Number(value);
    return days >= 1 && days <= MAX_DURATION_DAYS;
  }),
);
const DayPricesRecordSchema = v.record(DayPriceKeySchema, integerAtLeast(0));

/** Strict stored shape for per-day-count prices. */
export const DayPricesSchema = v.pipe(
  v.intersect([
    v.custom<Record<string, unknown>>(isRecord),
    DayPricesRecordSchema,
  ]),
  v.transform((prices): DayPrices => prices),
);

/**
 * Coerce an arbitrary stored/parsed value into a clean {@link DayPrices} map.
 * Keeps only whole-number day counts in [1, MAX_DURATION_DAYS] mapped to
 * finite, non-negative whole-number minor-unit prices. Everything else is
 * dropped. Used on both the DB read path and form parsing so the rest of the
 * code can treat the map as already-valid.
 */
export const parseDayPrices = (raw: unknown): DayPrices => {
  if (typeof raw !== "object" || raw === null) return {};
  const result: DayPrices = {};
  for (const [key, value] of Object.entries(raw)) {
    const days = Number(key);
    const price = Number(value);
    if (
      Number.isInteger(days) &&
      days >= 1 &&
      days <= MAX_DURATION_DAYS &&
      Number.isSafeInteger(price) &&
      price >= 0
    ) {
      result[days] = price;
    }
  }
  return result;
};

/** The subset of listing fields needed to reason about day-count pricing. */
export type DayPricedListing = Pick<
  Listing,
  "customisableDays" | "dayPrices" | "durationDays"
>;

/**
 * The day counts a customisable listing offers, ascending: the priced counts
 * that fall within [1, duration_days] (duration_days is the maximum when
 * `customisable_days` is on). Empty for non-customisable listings.
 */
export const ascending = (a: number, b: number): number => a - b;

export const availableDayCounts = (listing: DayPricedListing): number[] => {
  if (!listing.customisableDays) return [];
  const max = clampDurationDays(listing.durationDays);
  return Object.keys(listing.dayPrices)
    .map(Number)
    .filter((n) => n >= 1 && n <= max)
    .sort(ascending);
};

/**
 * The per-ticket price (minor units) for booking `days` on a customisable
 * listing, or null when the listing isn't customisable or that count has no
 * configured price (and therefore isn't offered).
 */
export const dayPriceFor = (
  listing: DayPricedListing,
  days: number,
): number | null => {
  if (!listing.customisableDays) return null;
  const max = clampDurationDays(listing.durationDays);
  if (!Number.isInteger(days) || days < 1 || days > max) return null;
  return listing.dayPrices[days] ?? null;
};

export type ItemImageColumns = {
  /** Projected from the first `image_uses` row for this item. Storage ownership
   * lives in the first-class images tables. */
  imageUrl: string;
  /** Projected thumbnail filename for {@link imageUrl}. */
  imageThumbUrl: string;
  /** Projected alt text for {@link imageUrl}. Empty means decorative. */
  imageAltText: string;
};

/** A stored listing: its row, its first image, and its per-day-count prices
 * from `listing_prices`. */
export type Listing = DecodedRowOf<"listings"> &
  ItemImageColumns & { dayPrices: DayPrices };

export type Image = DecodedRowOf<"images">;

/** A logistics agent (typically a van) used for drop-off and collection. */
export type LogisticsAgent = DecodedRowOf<"logistics_agents">;

/** A link between an agent user and a logistics agent (van/crew) they drive.
 * Many-to-many: a user may cover several agents and an agent several users. */
export type UserLogisticsAgent = DecodedRowOf<"user_logistics_agents">;

export interface Attendee extends ContactInfo {
  attachment_downloads: number;
  /** Admitted tickets, 0..quantity. A quantity 0 ghost line stores 0. */
  checked_in: number;
  created: string;
  date: string | null;
  email_owed?: number;
  email_pending?: number;
  /** Exclusive end of the booked range (YYYY-MM-DD, the midnight after the
   * last booked day), from `listing_attendees.end_at`. Null for date-less
   * bookings. Renders each booking's true span, not the listing's default. */
  end_date: string | null;
  id: number;
  kind: string;
  /** Latitude the operator pinned for the address ("" = not pinned). Admin-only. */
  lat: string;
  listing_id: number;
  /** Longitude the operator pinned for the address ("" = not pinned). */
  lng: string;
  /** The package group this booking row belongs to (0 = not a package).
   * Stamped on every row of a package order so tickets/emails group under it. */
  package_group_id: number;
  payment_id: string;
  /** Owner-key-encrypted PII blob; "" on a just-created in-memory echo. */
  pii_blob: OwnerKeyEncrypted | "";
  price_paid: string;
  quantity: number;
  refunded: boolean;
  /** Remaining balance owed in minor units (plaintext); 0 when fully paid. */
  remaining_balance: number;
  /** Whether each delivered listing books its own drop-off/collection agents. */
  split_logistics_agents: boolean;
  /** Owner-defined status id (plaintext); null for legacy/default. */
  status_id: number | null;
  ticket_token: string;
  ticket_token_index: BlindIndex;
  /** Registration webhooks still owed. Same values as `email_pending`. */
  webhooks_pending: number;
}

/** Short keys used in the PII blob JSON to minimize encrypted payload size */
export type PiiBlob = {
  v: number; // schema version (1 = current)
  n: string; // name
  e: string; // email
  p: string; // phone
  a: string; // address
  s: string; // special_instructions
  pi: string; // payment_id
  t: string; // ticket_token
  la?: string | undefined; // latitude (absent = not pinned; set by admins, never at booking)
  lo?: string | undefined; // longitude (absent = not pinned; set by admins, never at booking)
};

export interface Settings {
  key: string;
  value: string;
}

export type Session = Omit<
  DecodedRowOf<"sessions">,
  "token" | "wrappedDataKey"
> & {
  token: TokenHash; // Contains the hashed token for DB storage
  wrappedDataKey: WrappedKey | null;
};

/** Schema for admin role levels.
 * - `owner`/`manager` share full back-office access (gated per-page; managers
 *   are denied a subset).
 * - `agent` is a delivery-driver login for its own run sheet only (`/admin/deliveries`).
 * - `editor` writes listings, groups and site content but holds no DATA_KEY,
 *   so attendee PII stays undecryptable for them (`CONTENT_ADMIN_LEVELS`).
 * - `scanner` works a door: the scanner pages, the scan API, and check-in (`DOOR_ADMIN_LEVELS`). */
export const AdminLevelSchema = v.picklist([
  "owner",
  "manager",
  "agent",
  "editor",
  "scanner",
]);

/** Admin role levels that are back-office staff (not delivery agents). */
export const STAFF_ADMIN_LEVELS = ["owner", "manager"] as const;

/** Admin role levels with owner-only permissions. */
const OWNER_ADMIN_LEVELS = ["owner"] as const;

/** Admin role levels that may create/edit listings & groups: the back-office
 * staff plus the content-only `editor`. Gates the listing/group content
 * routes editors opt into; deliberately excludes `agent`. */
export const CONTENT_ADMIN_LEVELS = ["owner", "manager", "editor"] as const;

/** Admin role levels that may edit the public-facing site content (homepage,
 * contact, order intro). Site editing has always been owner-only; the `editor`
 * role joins it, but `manager` stays excluded — owner+editor, NOT the broader
 * {@link CONTENT_ADMIN_LEVELS}. */
export const SITE_ADMIN_LEVELS = ["owner", "editor"] as const;

/** Admin role levels that may reach the delivery run sheet
 * (`/admin/deliveries`): staff plus delivery `agent`s — the run sheet's
 * long-standing audience, with the content-only `editor` excluded. */
export const DELIVERY_ADMIN_LEVELS = ["owner", "manager", "agent"] as const;

/** Admin role levels that may work a door: the staff plus the door-only
 * `scanner`, gating the scanner pages, the scan API, and the check-in toggle. */
export const DOOR_ADMIN_LEVELS = ["owner", "manager", "scanner"] as const;

/** Every admin role level — for actions every authenticated user must reach
 * (e.g. logout). Derived from {@link AdminLevelSchema} so a new role
 * propagates automatically instead of being hand-listed here. */
export const ALL_ADMIN_LEVELS =
  AdminLevelSchema.options as readonly AdminLevel[];

/** Admin role levels */
export type AdminLevel = v.InferOutput<typeof AdminLevelSchema>;

/** Build a membership predicate over a role set. Typed at `AdminLevel` so the
 * `as const` role-set constants pass without per-call-site casts. */
const hasRole = (levels: readonly AdminLevel[], level: AdminLevel): boolean =>
  levels.includes(level);
const roleIn = bindFirst(hasRole);

/** True for back-office staff (owner/manager). */
export const isStaffRole = roleIn(STAFF_ADMIN_LEVELS);

/** True only for the owner role. */
export const isOwnerRole = roleIn(OWNER_ADMIN_LEVELS);

/** True for roles that may reach the delivery run sheet (owner/manager/agent). */
export const isDeliveryRole = roleIn(DELIVERY_ADMIN_LEVELS);

/** True for roles that may work a door (owner/manager/scanner). */
export const isDoorRole = roleIn(DOOR_ADMIN_LEVELS);

/** True for roles that may create/edit listings & groups (owner/manager/editor). */
export const isContentRole = roleIn(CONTENT_ADMIN_LEVELS);

/** True for roles that may edit public-site content (owner/editor). */
export const isSiteRole = roleIn(SITE_ADMIN_LEVELS);

/** Type guard: check if a string is a valid AdminLevel */
export const isAdminLevel = guardFor(AdminLevelSchema);

/** Session data needed by admin page templates */
export type AdminSession = {
  readonly adminLevel: AdminLevel;
  readonly settingsNagItems?: readonly NagItem[];
};

/** A stored user. `adminLevel` holds an encrypted "owner", "manager",
 * "agent", "editor" or "scanner". `kekVersion` names the KEK scheme for
 * `wrappedDataKey`: 1 = legacy (hash-derived), 2 = password-bound. */
export type User = Omit<
  DecodedRowOf<"users">,
  | "inviteCodeHash"
  | "inviteExpiry"
  | "inviteWrappedDataKey"
  | "passwordHash"
  | "usernameIndex"
  | "wrappedDataKey"
> & {
  // Encrypted SHA-256 of the invite token, null once the password is set.
  inviteCodeHash: EnvKeyEncrypted | null;
  inviteExpiry: EnvKeyEncrypted | null; // encrypted ISO 8601, null after password set
  // DATA_KEY wrapped under the invite code, set at invite time so the user can
  // self-activate at /join. Null once activated (see users.acceptInvite).
  inviteWrappedDataKey: WrappedKey | null;
  // PBKDF2 hash encrypted at rest. "" for an invited user yet to set one.
  passwordHash: EnvKeyEncrypted<PasswordHash> | "";
  usernameIndex: BlindIndex; // HMAC hash for lookups
  wrappedDataKey: WrappedKey | null; // wrapped with user's KEK
};

/** A stored API key. `lastUsed` is ISO 8601 or an empty string, and
 * `wrappedDataKey` holds DATA_KEY wrapped with the API key token. */
export type ApiKey = DecodedRowOf<"api_keys">;

/** A stored group. */
export type Group = DecodedRowOf<"groups">;

/** A group paired with the active member listings used to decide and render it. */
export interface GroupWithMembers {
  group: Group;
  members: ListingWithCount[];
}

/** A membership of `listingId` in `groupId`, hydrated for the package editor
 * and booking flow. A listing may belong to several groups. `packagePrice`
 * (minor units) is the per-listing override when the group is a package, read
 * from the `group` dimension of `listing_prices` (not a column on the join
 * table): `null` means no override (use the listing's own price), `0` means
 * explicitly free in the package, and a positive value overrides the price.
 * `quantity` (≥1, stored on the join row) is how many of this listing one unit of
 * the package includes. Both are ignored for non-package groups. */
export type GroupListing = DecodedRowOf<"group_listings"> & {
  packagePrice: number | null;
};

/** Schema for the kind of item an image can be attached to. */
export const ImageUseItemTypeSchema = v.picklist([
  "listing",
  "group",
  "news",
  "page",
]);

export type ImageUseItemType = v.InferOutput<typeof ImageUseItemTypeSchema>;

export const isImageUseItemType = guardFor(ImageUseItemTypeSchema);

export type ImageUse = DecodedRowOf<"image_uses">;

/** Schema for the kind of thing a {@link SitePageItem} points at. */
export const SitePageItemTypeSchema = v.picklist(["listing", "group", "page"]);

/** The kind of thing a {@link SitePageItem} points at. Exhaustive union — a new
 * member is a compile error at every `Record<SitePageItemType, …>` dispatch. */
export type SitePageItemType = v.InferOutput<typeof SitePageItemTypeSchema>;

/** Type guard: is this string a valid {@link SitePageItemType}? */
export const isSitePageItemType = guardFor(SitePageItemTypeSchema);

/** A user-created content page, ordered by `sortOrder`, hidden by `hidden`.
 * The free-text columns are stored encrypted. `slugIndex` is the plaintext
 * HMAC blind index of the `/slug` permalink. */
export type SitePage = DecodedRowOf<"site_pages">;

/** The narrow projection used to build the public nav: enough to render a link
 * and order it, without decrypting the large `content`/`meta_*` blobs on every
 * public request (cold-start efficiency). */
export type SitePageNavRow = Pick<
  SitePage,
  "hidden" | "id" | "name" | "slug" | "sortOrder"
>;

/** One ordered membership edge: `item` (of `itemType`) sits inside `pageId`
 * at `sortOrder`. Keyed on the composite `(page_id, item_type, item_id)`. */
export type SitePageItem = Omit<DecodedRowOf<"site_page_items">, "itemType"> & {
  itemType: SitePageItemType;
};

/** A news post shown on the public /news page. All free-text columns are
 * stored encrypted. `created` stays plaintext (like listings) so the
 * newest-first ordering and the RSS pubDate never need a scan-and-decrypt.
 * `slug` is the `/news/:slug` permalink (auto-generated from the created date
 * and the name at creation, then immutable). `slugIndex` is its blind index. */
export type NewsPost = DecodedRowOf<"news_posts">;

/** The narrow list projection — id, created, slug, name, snippet — for readers
 * that render no images (the RSS feed, the admin list). Never the large
 * `content`/`meta_*` blobs (cold-start efficiency, like {@link SitePageNavRow}). */
export type NewsPostSummary = Pick<
  NewsPost,
  "id" | "created" | "slug" | "name" | "snippet"
>;

/** The public /news list projection: a summary plus the post's first image
 * (the shared {@link ItemImageColumns} columns). */
export type NewsPostCard = NewsPostSummary & ItemImageColumns;

/** An owner-defined price modifier (surcharge / discount / add-on). `calcValue`
 * is the positive magnitude the owner entered (a fixed amount in major currency
 * units, a percentage, or a multiplier). `direction` chooses charge vs discount.
 * `totalRevenue` is projected from the transfers ledger as
 * `balanceOf(modifier:M)`: the modifier account's net effect on revenue
 * (surcharges in, discounts out), in minor units. */
export type Modifier = DecodedRowOf<"modifiers"> & { totalRevenue: number };

/**
 * The listing values needed to place a listing in the shared sort order: which
 * tier it belongs to (its type and date), its name for the within-tier sort,
 * and — for a daily listing — the values that decide its next bookable date.
 * A read that only lists or picks listings can select these columns alone and
 * skip the whole listing record.
 */
export type SortableListing = Pick<
  Listing,
  | "bookableDays"
  | "customisableDays"
  | "date"
  | "durationDays"
  | "id"
  | "listingType"
  | "maximumDaysAfter"
  | "minimumDaysBefore"
  | "name"
>;

export type ListingWithCount = Listing & {
  attendeeCount: number;
  /** Projected servicing costs posted against this listing, in minor units. */
  cost: number;
  /** Projected recognised income over this listing's ledger rows, in minor units. */
  income: number;
  /** Projected recognised income minus servicing cost, in minor units. */
  profit: number;
  /** Trigger-maintained COUNT of this listing's booking rows. */
  ticketsCount: number;
};

/**
 * Admin listing shape — all listing fields except internal indices.
 * Used by both admin JSON API and admin templates to ensure consistent
 * field exposure.
 */
export type AdminListing = Omit<ListingWithCount, "slugIndex">;

/** One listing shown in an attendee row's Listings cell */
export type AttendeeRowListing = {
  id: number;
  name: string;
};

/**
 * The attendee fields the shared attendee table and its column registry
 * actually read. A full decrypted {@link Attendee} satisfies it, and so does
 * a field-selected read that skipped the money subqueries — so the browsing
 * tables render rows that never computed the money columns
 * (`src/shared/db/attendees/select.ts`).
 */
export type DisplayAttendee = Pick<
  Attendee,
  | "address"
  | "checked_in"
  | "created"
  | "date"
  | "email"
  | "email_owed"
  | "email_pending"
  | "id"
  | "kind"
  | "listing_id"
  | "name"
  | "phone"
  | "quantity"
  | "refunded"
  | "special_instructions"
  | "ticket_token"
  | "webhooks_pending"
>;

/** A single row in the attendee table: an attendee plus the listings the row
 * covers, in display order. Roster/check-in tables render one row per booking
 * line; the browsing tables group an attendee's lines into one row. */
export type AttendeeTableRow = {
  attendee: DisplayAttendee;
  booking?: PairBooking;
  listings: AttendeeRowListing[];
};
