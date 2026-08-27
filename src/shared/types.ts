/**
 * Types for the ticket reservation system
 */

import * as v from "valibot";
import type {
  BlindIndex,
  EnvKeyEncrypted,
  OwnerKeyEncrypted,
  PasswordHash,
  TokenHash,
  WrappedKey,
} from "#crypto/sealed.ts";
import type {
  CalcKind,
  ModifierDirection,
  ModifierScope,
  ModifierTrigger,
} from "#shared/price-modifier.ts";
import { guardFor } from "#shared/validation/guard.ts";
import { clampInteger, integerAtLeast } from "#shared/validation/number.ts";
import type { NonEmptyString } from "#shared/validation/string.ts";

/** Type guard: a non-null, non-array object (a Record shape). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Unique identifiers for settings nags that prompt the admin to complete
 * required or recommended configuration.
 */
export type NagId =
  | "payment-provider"
  | "business-email"
  | "domain"
  | "superuser";

/**
 * A single settings nag item presented to the admin.
 */
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

/**
 * A listing's contact fields, as comma-separated ContactField names, or empty
 * for name only. `parseListingFields` is what enforces it at runtime.
 */
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

/** The persisted email template types: the attendee confirmation and the admin
 *  notification. The discriminator the renderer, the settings store, and the
 *  admin forms all key on. A plain union rather than a picklist schema,
 *  because nothing validates a string against it — every value comes from a
 *  typed call, never from a form or a stored row. */
export type EmailTemplateType = "confirmation" | "admin";

/** A single part of an email template: the subject line, the html body, or the
 *  plain-text body. A plain union for the same reason. */
export type EmailTemplateFormat = "subject" | "html" | "text";

/** Whether an listing can accept payments: a flat price, pay-what-you-want, or
 * a customisable-days listing with at least one non-zero day-count price. */
export const isPaidListing = (
  listing: Pick<
    Listing,
    "unit_price" | "can_pay_more" | "customisable_days" | "day_prices"
  >,
): boolean =>
  listing.unit_price > 0 ||
  listing.can_pay_more ||
  (listing.customisable_days &&
    Object.values(listing.day_prices).some((price) => price > 0));

/** True when an attendee/booking row is a real ticket (quantity ≥ 1) rather than
 * the no-quantity sentinel (quantity 0). The shared "is this a real ticket, not a
 * ghost" test for the readers, rosters, and exports that must skip sentinel rows —
 * one home for the rule instead of a bare `quantity > 0` plus an explanatory
 * comment at each call site. */
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
 * Build a {@link DayPrices} map from raw entries. `checkEntry` reads one raw
 * key/value pair and returns the day count and price to keep, `null` to skip
 * that entry, or a problem message — which stops the walk and is returned in
 * place of the map. Shared by the lenient stored-value reader
 * ({@link parseDayPrices}) and the fail-closed admin API body parser.
 */
export const buildDayPrices = <Problem extends string = never>(
  raw: object,
  checkEntry: (
    key: string,
    value: unknown,
  ) => { days: number; price: number } | Problem | null,
): DayPrices | Problem => {
  const result: DayPrices = {};
  for (const [key, value] of Object.entries(raw)) {
    const entry = checkEntry(key, value);
    if (typeof entry === "string") return entry;
    if (entry !== null) result[entry.days] = entry.price;
  }
  return result;
};

/**
 * Coerce an arbitrary stored/parsed value into a clean {@link DayPrices} map.
 * Keeps only whole-number day counts in [1, MAX_DURATION_DAYS] mapped to
 * finite, non-negative whole-number minor-unit prices; everything else is
 * dropped. Used on both the DB read path and form parsing so the rest of the
 * code can treat the map as already-valid.
 */
export const parseDayPrices = (raw: unknown): DayPrices => {
  if (typeof raw !== "object" || raw === null) return {};
  // No problem messages here: bad entries are skipped, never reported.
  return buildDayPrices<never>(raw, (key, value) => {
    const days = Number(key);
    const price = Number(value);
    return Number.isInteger(days) &&
      days >= 1 &&
      days <= MAX_DURATION_DAYS &&
      Number.isSafeInteger(price) &&
      price >= 0
      ? { days, price }
      : null;
  });
};

/** The subset of listing fields needed to reason about day-count pricing. */
export type DayPricedListing = Pick<
  Listing,
  "customisable_days" | "day_prices" | "duration_days"
>;

/**
 * The day counts a customisable listing offers, ascending: the priced counts
 * that fall within [1, duration_days] (duration_days is the maximum when
 * `customisable_days` is on). Empty for non-customisable listings.
 */
export const ascending = (a: number, b: number): number => a - b;

export const availableDayCounts = (listing: DayPricedListing): number[] => {
  if (!listing.customisable_days) return [];
  const max = clampDurationDays(listing.duration_days);
  return Object.keys(listing.day_prices)
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
  if (!listing.customisable_days) return null;
  const max = clampDurationDays(listing.duration_days);
  if (!Number.isInteger(days) || days < 1 || days > max) return null;
  return listing.day_prices[days] ?? null;
};

/**
 * Units of a shared capped group consumed by one parent+child order: the parent
 * line plus its single required child line each take one spot in the group they
 * share (invariants I1, I7). Used to convert a shared group's remaining spots
 * into how many whole parent+child orders still fit.
 */
export const PARENT_CHILD_GROUP_UNITS = 2;

/**
 * The capped groups a parent and one of its children BOTH belong to — the pool(s)
 * the combined parent+child demand actually contends for. A capped
 * group is one present in `byGroup` (uncapped groups are omitted from that map).
 * Empty when they share no capped group.
 */
const sharedCappedGroupIds = (
  parentGroupIds: readonly number[],
  childGroupIds: readonly number[],
  byGroup: ReadonlyMap<number, number>,
): number[] =>
  parentGroupIds.filter((g) => childGroupIds.includes(g) && byGroup.has(g));

/**
 * The remaining spots of the capped group a parent and one of its children
 * share, or `undefined` when they share no capped group. Such a parent and
 * child take two group spots per order, so a caller must reason about the
 * combined demand, not each row alone.
 *
 * The value is the tightest SHARED group's remaining, never the child's
 * tightest group overall — a child that is also in a tighter unshared group
 * must not drag this down to an unrelated cap. Discovery and the booking-page
 * quantity ceiling both read it, so the two surfaces cannot disagree.
 */
export const sharedGroupRemaining = (
  parentGroupIds: readonly number[],
  childGroupIds: readonly number[],
  remainingByGroupId: ReadonlyMap<number, number>,
): number | undefined => {
  const shared = sharedCappedGroupIds(
    parentGroupIds,
    childGroupIds,
    remainingByGroupId,
  );
  if (shared.length === 0) return;
  return Math.min(...shared.map((g) => remainingByGroupId.get(g)!));
};

/**
 * The capacity a parent and one of its children share, as two separate facts:
 * - `staticCap` — `groups.max_attendees`, date-INDEPENDENT. Below
 *   {@link PARENT_CHILD_GROUP_UNITS} a parent+child order can never fit on any
 *   date, so a date-less surface can mark it sold out.
 * - `remaining` — free spots in the caller's context, `undefined` when it is
 *   not computable, such as a daily child with no submitted date.
 *
 * Both are `undefined` when the two share no capped group.
 */
export type SharedGroupCapacity = {
  staticCap: number | undefined;
  remaining: number | undefined;
};

/** The group ids each listing belongs to (listing id → group ids). A listing
 * absent from the map belongs to no group. */
export type GroupIdsByListingId = ReadonlyMap<number, number[]>;

/**
 * Build the {@link SharedGroupCapacity} for a parent/child pair. The two are
 * co-grouped when their group sets meet in at least one capped group.
 *
 * Both facts come from the SAME shared groups, and are the tightest value over
 * those — never the child's tightest group overall. That is what lets a
 * date-less surface reject a share too small to hold both, even when a daily
 * child's per-date remaining is unknown.
 */
export const sharedGroupCapacity = (
  parentGroupIds: readonly number[],
  childGroupIds: readonly number[],
  staticCapByGroupId: ReadonlyMap<number, number>,
  remainingByGroupId: ReadonlyMap<number, number>,
): SharedGroupCapacity => {
  const sharedForCap = sharedCappedGroupIds(
    parentGroupIds,
    childGroupIds,
    staticCapByGroupId,
  );
  const sharedForRemaining = sharedCappedGroupIds(
    parentGroupIds,
    childGroupIds,
    remainingByGroupId,
  );
  const minOver = (
    ids: number[],
    byGroup: ReadonlyMap<number, number>,
  ): number | undefined =>
    ids.length === 0 ? undefined : Math.min(...ids.map((g) => byGroup.get(g)!));
  return {
    remaining: minOver(sharedForRemaining, remainingByGroupId),
    staticCap: minOver(sharedForCap, staticCapByGroupId),
  };
};

export type ItemImageColumns = {
  /** Projected from the first `image_uses` row for this item. Storage ownership
   * lives in the first-class images tables. */
  image_url: string;
  /** Projected thumbnail filename for {@link image_url}. */
  image_thumb_url: string;
  /** Projected alt text for {@link image_url}. Empty means decorative. */
  image_alt_text: string;
};

export interface Listing extends ItemImageColumns {
  active: boolean;
  assign_built_site: boolean;
  attachment_name: string;
  attachment_url: string;
  /** When true, a listing that is also a child (offered under one or more
   * parents) keeps its OWN standalone booking page, catalog entry and API
   * eligibility, instead of existing only as a foldable add-on. Default false
   * ⇒ being a child strips standalone existence, the historic behaviour. The
   * hidden-package-member arm of the gate still outranks this flag. */
  bookable_alone: boolean;
  bookable_days: string[];
  can_pay_more: boolean;
  closes_at: string | null;
  created: string;
  customisable_days: boolean;
  date: string; // encrypted UTC ISO datetime or empty string
  day_prices: DayPrices;
  description: string;
  duration_days: number;
  fields: ListingFields;
  hidden: boolean;
  id: number;
  initial_site_months: number;
  listing_type: ListingType;
  location: string; // encrypted or empty string
  max_attendees: number;
  max_price: number;
  max_quantity: number;
  maximum_days_after: number;
  minimum_days_before: number;
  months_per_unit: number;
  name: string;
  non_transferable: boolean;
  purchase_only: boolean;
  slug: string;
  slug_index: BlindIndex;
  thank_you_url: string;
  unit_price: number;
  /** When true, the fields covered by the operator's listing defaults are
   * inherited live from settings rather than this row's own stored values
   * (see {@link resolveListingDefaults}). A single per-listing flag, never a
   * per-field one, so a stored `false` is never ambiguous. */
  use_defaults: boolean;
  /** When true (and logistics is enabled) this listing is dropped off and
   * collected from the customer, so its attendees carry logistics agents. */
  uses_logistics: boolean;
  webhook_url: string;
}

export interface Image {
  alt_text: string;
  filename: NonEmptyString;
  filename_thumb: NonEmptyString;
  id: number;
  name: string;
}

/** A logistics agent (typically a van) used for drop-off and collection. */
export interface LogisticsAgent {
  id: number;
  name: string;
}

/** A link between an agent user and a logistics agent (van/crew) they drive.
 * Many-to-many: a user may cover several agents and an agent may have several
 * users. */
export interface UserLogisticsAgent {
  agent_id: number;
  id: number;
  user_id: number;
}

export interface Attendee extends ContactInfo {
  attachment_downloads: number;
  checked_in: boolean;
  created: string;
  date: string | null;
  /** Exclusive end of the booked range (YYYY-MM-DD, the midnight after the last
   * booked day), derived from `listing_attendees.end_at`. Null for date-less
   * (standard) bookings. Lets render paths show each booking's true span — which
   * varies per booking on customisable-days listings — instead of assuming the
   * listing's duration. */
  end_date: string | null;
  id: number;
  kind: string;
  /** Latitude the operator pinned for the address ("" = not pinned). Lives in
   * the encrypted pii_blob and is only ever written from the admin side. */
  lat: string;
  listing_id: number;
  /** Longitude the operator pinned for the address ("" = not pinned). */
  lng: string;
  /** The package group this booking row belongs to (0 = not a package). Stamped
   * on every row of a package order so tickets/emails group the order under the
   * package by this persisted id. */
  package_group_id: number;
  payment_id: string;
  /** Owner-key-encrypted PII blob as stored; "" only on a just-created
   * in-memory echo (see buildAttendeeResult), never in the database. */
  pii_blob: OwnerKeyEncrypted | "";
  price_paid: string;
  quantity: number;
  refunded: boolean;
  /** Remaining balance owed in minor units (plaintext); 0 when fully paid. */
  remaining_balance: number;
  /** When true, each delivered listing this attendee books carries its own
   * drop-off/collection agents; when false a single pair applies to them all. */
  split_logistics_agents: boolean;
  /** Owner-defined status id (plaintext); null for legacy/default. */
  status_id: number | null;
  ticket_token: string;
  ticket_token_index: BlindIndex;
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

export interface Session {
  csrf_token: string;
  expires: number;
  token: TokenHash; // Contains the hashed token for DB storage
  user_id: number;
  wrapped_data_key: WrappedKey | null;
}

/** Schema for admin role levels.
 *
 * - `owner`/`manager` are staff who share full back-office access (gated
 *   per-page; managers are denied a subset).
 * - `agent` is a restricted delivery-driver login that can only ever reach its
 *   own logistics run sheet (`/admin/deliveries`). Auth gates exclude agents
 *   from every staff page by default — see `sessionRoleAllowed` in auth.ts.
 * - `editor` is a content-only collaborator: they can create/edit listings and
 *   groups and edit the public-site content, but hold no DATA_KEY (so attendee
 *   PII is undecryptable for them) and have no ledger/settings/API access. Like
 *   `agent`, they are excluded from every staff page by default and opted in to
 *   only the content routes (see `CONTENT_ADMIN_LEVELS`). */
export const AdminLevelSchema = v.picklist([
  "owner",
  "manager",
  "agent",
  "editor",
]);

/** Admin role levels that are back-office staff (not delivery agents). */
export const STAFF_ADMIN_LEVELS = ["owner", "manager"] as const;

/** Admin role levels with owner-only permissions. */
const OWNER_ADMIN_LEVELS = ["owner"] as const;

/** Admin role levels that may create/edit listings & groups: the back-office
 * staff plus the content-only `editor`. Used to gate the listing/group content
 * routes editors are explicitly opted into; deliberately excludes `agent`. */
export const CONTENT_ADMIN_LEVELS = ["owner", "manager", "editor"] as const;

/** Admin role levels that may edit the public-facing site content (homepage,
 * contact, order intro). Site editing has always been owner-only; the `editor`
 * role is added to it, but `manager` stays excluded — so this is owner+editor,
 * NOT the broader {@link CONTENT_ADMIN_LEVELS}. */
export const SITE_ADMIN_LEVELS = ["owner", "editor"] as const;

/** Admin role levels that may reach the delivery run sheet
 * (`/admin/deliveries`): staff plus delivery `agent`s. This is the audience the
 * run sheet has always had; the content-only `editor` is excluded. */
export const DELIVERY_ADMIN_LEVELS = ["owner", "manager", "agent"] as const;

/** Every admin role level — used to gate actions every authenticated user must
 *  reach (e.g. logout). Derived from {@link AdminLevelSchema} so adding a new
 *  role propagates automatically instead of being hand-listed here. */
export const ALL_ADMIN_LEVELS =
  AdminLevelSchema.options as readonly AdminLevel[];

/** Admin role levels */
export type AdminLevel = v.InferOutput<typeof AdminLevelSchema>;

/** Build a membership predicate over a role set. Typed at `AdminLevel` so the
 * `as const` role-set constants pass without per-call-site casts. */
const roleIn =
  (levels: readonly AdminLevel[]) =>
  (level: AdminLevel): boolean =>
    levels.includes(level);

/** True for back-office staff (owner/manager). */
export const isStaffRole = roleIn(STAFF_ADMIN_LEVELS);

/** True only for the owner role. */
export const isOwnerRole = roleIn(OWNER_ADMIN_LEVELS);

/** True for roles that may reach the delivery run sheet (owner/manager/agent). */
export const isDeliveryRole = roleIn(DELIVERY_ADMIN_LEVELS);

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

export interface User {
  admin_level: EnvKeyEncrypted; // encrypted "owner", "manager", "agent" or "editor"
  id: number;
  // Encrypted SHA-256 of the invite token, null once the password is set.
  invite_code_hash: EnvKeyEncrypted | null;
  invite_expiry: EnvKeyEncrypted | null; // encrypted ISO 8601, null after password set
  // DATA_KEY wrapped under the invite code, set at invite time so the user can
  // self-activate at /join; null once activated (see users.acceptInvite).
  invite_wrapped_data_key: WrappedKey | null;
  // KEK scheme for wrapped_data_key: 1 = legacy (hash-derived), 2 = password-
  // bound. Legacy rows upgrade to 2 on their owner's next login.
  kek_version: number;
  // PBKDF2 hash encrypted at rest; "" for an invited user yet to set one.
  password_hash: EnvKeyEncrypted<PasswordHash> | "";
  username_hash: EnvKeyEncrypted; // encrypted at rest, decrypted to display
  username_index: BlindIndex; // HMAC hash for lookups
  wrapped_data_key: WrappedKey | null; // wrapped with user's KEK
}

export interface ApiKey {
  created: string;
  id: number;
  key_index: BlindIndex; // HMAC hash for lookup
  last_used: string; // ISO 8601 or empty string
  name: EnvKeyEncrypted; // encrypted label
  user_id: number;
  wrapped_data_key: WrappedKey; // DATA_KEY wrapped with the API key token
}

export interface Holiday {
  end_date: string;
  id: number;
  name: string;
  start_date: string;
}

export interface Group {
  description: string;
  hidden: boolean;
  /** When true (and the group is a package) the package's member listings are
   * hidden from buyers, tickets, and confirmation emails — only admins see the
   * breakdown. */
  hide_package_listings: boolean;
  id: number;
  /** When true the group is a bookable "package": its member listings can carry
   * per-listing price overrides (the `group` dimension of listing_prices) and
   * fixed per-package quantities (group_listings.quantity). */
  is_package: boolean;
  max_attendees: number;
  name: string;
  slug: string;
  slug_index: BlindIndex;
  terms_and_conditions: string;
}

/** A group paired with the active member listings used to decide and render it. */
export interface GroupWithMembers {
  group: Group;
  members: ListingWithCount[];
}

/** A membership of `listing_id` in `group_id`, hydrated for the package editor
 * and booking flow. A listing may belong to several groups. `package_price`
 * (minor units) is the per-listing override when the group is a package, read
 * from the `group` dimension of `listing_prices` (not a column on the join
 * table): `null` means no override (use the listing's own price), `0` means
 * explicitly free in the package, and a positive value overrides the price.
 * `quantity` (≥1, stored on the join row) is how many of this listing one unit of
 * the package includes. Both are ignored for non-package groups. */
export interface GroupListing {
  group_id: number;
  listing_id: number;
  package_price: number | null;
  quantity: number;
}

/** Schema for the kind of item an image can be attached to. */
export const ImageUseItemTypeSchema = v.picklist([
  "listing",
  "group",
  "news",
  "page",
]);

export type ImageUseItemType = v.InferOutput<typeof ImageUseItemTypeSchema>;

export const isImageUseItemType = guardFor(ImageUseItemTypeSchema);

export interface ImageUse {
  image_id: number;
  item_id: number;
  item_type: ImageUseItemType;
  sort_order: number;
}

/** Schema for the kind of thing a {@link SitePageItem} points at. */
export const SitePageItemTypeSchema = v.picklist(["listing", "group", "page"]);

/** The kind of thing a {@link SitePageItem} points at. Exhaustive union — a new
 * member is a compile error at every `Record<SitePageItemType, …>` dispatch. */
export type SitePageItemType = v.InferOutput<typeof SitePageItemTypeSchema>;

/** Type guard: is this string a valid {@link SitePageItemType}? */
export const isSitePageItemType = guardFor(SitePageItemTypeSchema);

/** The fields shared by every named, slugged content record whose free-text
 * columns are stored encrypted: the body/meta blobs, the display name, and the
 * `/slug` permalink paired with its plaintext HMAC blind index (`slug_index`).
 * Both site pages and news posts build on this. */
export interface EncryptedContentRecord {
  content: string;
  id: number;
  meta_description: string;
  meta_title: string;
  name: string;
  slug: string;
  slug_index: BlindIndex;
}

/** A user-created content page. Adds `sort_order`, which positions the page
 * among root-level pages. */
export interface SitePage extends EncryptedContentRecord {
  sort_order: number;
}

/** The narrow projection used to build the public nav: enough to render a link
 * and order it, without decrypting the large `content`/`meta_*` blobs on every
 * public request (cold-start efficiency). */
export type SitePageNavRow = Pick<
  SitePage,
  "id" | "slug" | "name" | "sort_order"
>;

/** One ordered membership edge: `item` (of `item_type`) sits inside `page_id`
 * at `sort_order`. Keyed on the composite `(page_id, item_type, item_id)`. */
export interface SitePageItem {
  item_id: number;
  item_type: SitePageItemType;
  page_id: number;
  sort_order: number;
}

/** A news post shown on the public /news page. All free-text columns are
 * stored encrypted; `created` stays plaintext (like listings) so the
 * newest-first ordering and the RSS pubDate never need a scan-and-decrypt.
 * `slug` is the `/news/:slug` permalink (auto-generated from the created date
 * and the name at creation, then immutable); `slug_index` is its blind index. */
export interface NewsPost extends EncryptedContentRecord {
  created: string;
  snippet: string;
}

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

/** An owner-defined price modifier (surcharge / discount / add-on). `calc_value`
 * is the positive magnitude the owner entered (a fixed amount in major currency
 * units, a percentage, or a multiplier); `direction` chooses charge vs discount. */
export interface Modifier {
  active: boolean;
  calc_kind: CalcKind;
  calc_value: number;
  /** Promo code (trigger = "code"), shown to the owner; "" for other triggers. */
  code: string;
  /** Blind index (HMAC) of the normalised code, for public code lookup; null
   * when the modifier has no code. */
  code_index: string | null;
  direction: ModifierDirection;
  id: number;
  /** Cap on how many times this modifier may apply within one order, or null
   * for no cap. Set to 1 ("charge once per order") so a question-answer
   * surcharge such as a delivery fee is charged per booking, not per ticket.
   * Stock for such a modifier then counts orders. Answer triggers only. */
  max_per_order: number | null;
  /** Minimum in-scope subtotal (minor units) for the modifier to apply. */
  min_subtotal: number;
  /** Minimum prior bookings required for the modifier to apply. */
  min_visits: number;
  name: string;
  scope: ModifierScope;
  /** Remaining-stock cap, or null for unlimited. Consumed monotonically. */
  stock: number | null;
  /** Projected from the transfers ledger as `balanceOf(modifier:M)` — the
   * modifier account's net effect on revenue (surcharges in, discounts out),
   * read directly, in minor units. */
  total_revenue: number;
  /** Trigger-maintained SUM(quantity) over this modifier's usage rows. */
  total_uses: number;
  trigger: ModifierTrigger;
  /** Trigger-maintained COUNT of this modifier's usage rows. */
  usage_count: number;
}

/**
 * The listing values needed to place a listing in the shared sort order: which
 * tier it belongs to (its type and date), its name for the within-tier sort,
 * and — for a daily listing — the values that decide its next bookable date.
 * A read that only lists or picks listings can select these columns alone and
 * skip the whole listing record.
 */
export type SortableListing = Pick<
  Listing,
  | "bookable_days"
  | "date"
  | "duration_days"
  | "id"
  | "listing_type"
  | "maximum_days_after"
  | "minimum_days_before"
  | "name"
>;

export interface ListingWithCount extends Listing {
  attendee_count: number;
  /** Projected servicing costs posted against this listing, in minor units. */
  cost: number;
  /** Projected recognised income over this listing's ledger rows, in minor units. */
  income: number;
  /** Projected recognised income minus servicing cost, in minor units. */
  profit: number;
  /** Trigger-maintained COUNT of this listing's booking rows. */
  tickets_count: number;
}

/**
 * Admin API listing shape — all listing fields except internal indices.
 * Used by both admin JSON API and admin templates to ensure consistent
 * field exposure. Snake_case keys match the DB schema.
 */
export type AdminListing = Omit<ListingWithCount, "slug_index">;

/** One listing shown in an attendee row's Listings cell */
export type AttendeeRowListing = {
  id: number;
  name: string;
};

/**
 * The attendee fields the shared attendee table and its column registry
 * actually read. A full decrypted {@link Attendee} satisfies it, and so does a
 * field-selected read that skipped the money subqueries — which is exactly why
 * the browsing tables can render rows that never computed `price_paid` or
 * `remaining_balance` (see `src/shared/db/attendees/select.ts`).
 */
export type DisplayAttendee = Pick<
  Attendee,
  | "address"
  | "checked_in"
  | "created"
  | "date"
  | "email"
  | "id"
  | "kind"
  | "listing_id"
  | "name"
  | "phone"
  | "quantity"
  | "refunded"
  | "special_instructions"
  | "ticket_token"
>;

/**
 * A single row in the attendee table: an attendee plus the listings the row
 * covers, in display order. Roster/check-in tables render one row per booking
 * line (a one-listing array); the browsing tables (attendees list, dashboard)
 * group an attendee's lines into one row carrying every listing.
 */
export type AttendeeTableRow = {
  attendee: DisplayAttendee;
  listings: AttendeeRowListing[];
};
