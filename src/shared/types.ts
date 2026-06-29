/**
 * Types for the ticket reservation system
 */

import * as v from "valibot";
import type {
  CalcKind,
  ModifierDirection,
  ModifierScope,
  ModifierTrigger,
} from "#shared/price-modifier.ts";

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

export const isSuperuserChoice = (s: string): s is SuperuserChoice =>
  v.is(SuperuserChoiceSchema, s);

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
export const isContactField = (s: string): s is ContactField =>
  v.is(ContactFieldSchema, s);

/**
 * Contact fields setting for an listing (comma-separated ContactField names, or empty for name-only).
 * Alias kept for documentation; runtime enforcement happens in parseListingFields.
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
export const isPaymentProvider = (s: string): s is PaymentProviderType =>
  v.is(PaymentProviderSchema, s);

/** Persisted payment-provider setting: an explicit provider, "none" (admin saved
 *  payments-disabled), or absent (never saved — drives the settings nag). */
export const PaymentProviderSettingSchema = v.picklist([
  "stripe",
  "square",
  "sumup",
  "none",
]);

export type PaymentProviderSetting = v.InferOutput<
  typeof PaymentProviderSettingSchema
>;

/** Type guard: check if a string is a valid PaymentProviderSetting */
export const isPaymentProviderSetting = (
  s: string,
): s is PaymentProviderSetting => v.is(PaymentProviderSettingSchema, s);

/** Schema for a listing type: standard (one-time) or daily (date-based booking) */
export const ListingTypeSchema = v.picklist(["standard", "daily"]);

/** Listing type: standard (one-time) or daily (date-based booking) */
export type ListingType = v.InferOutput<typeof ListingTypeSchema>;

/** Type guard: check if an arbitrary string is a valid ListingType */
export const isListingType = (s: string): s is ListingType =>
  v.is(ListingTypeSchema, s);

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
 * The single definition of "a valid booking duration": a whole number of
 * days in [1, MAX_DURATION_DAYS], with non-finite input degrading to 1.
 *
 * Every read of `duration_days` and every `durationDays` parameter funnels
 * through here so the clamping policy lives in exactly one place — the column
 * write, the per-day capacity expansion (JS + SQL), and all display paths
 * agree by construction. Idempotent, so applying it to an already-normalized
 * value (e.g. a column-clamped `listing.duration_days`) is a safe no-op.
 */
export const normalizeDurationDays = (value: number): number =>
  Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_DURATION_DAYS, Math.floor(value)))
    : 1;

/**
 * Per-day-count ticket prices for "customisable days" listings, in minor
 * units, keyed by the number of days booked. e.g. `{ 1: 1000, 2: 1800 }`
 * means a 1-day booking costs 1000 and a 2-day booking 1800. Only counts
 * present here are offered to the visitor.
 */
export type DayPrices = Record<number, number>;

/**
 * Coerce an arbitrary stored/parsed value into a clean {@link DayPrices} map.
 * Keeps only whole-number day counts in [1, MAX_DURATION_DAYS] mapped to
 * finite, non-negative whole-number minor-unit prices; everything else is
 * dropped. Used on both the DB read path and form parsing so the rest of the
 * code can treat the map as already-valid.
 */
export const parseDayPrices = (raw: unknown): DayPrices => {
  if (typeof raw !== "object" || raw === null) return {};
  const result: DayPrices = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const days = Number(key);
    const price = Number(value);
    if (
      Number.isInteger(days) &&
      days >= 1 &&
      days <= MAX_DURATION_DAYS &&
      Number.isInteger(price) &&
      price >= 0
    ) {
      result[days] = price;
    }
  }
  return result;
};

/** The subset of listing fields needed to reason about day-count pricing. */
type DayPricedListing = Pick<
  Listing,
  "customisable_days" | "day_prices" | "duration_days"
>;

/**
 * The day counts a customisable listing offers, ascending: the priced counts
 * that fall within [1, duration_days] (duration_days is the maximum when
 * `customisable_days` is on). Empty for non-customisable listings.
 */
export const availableDayCounts = (listing: DayPricedListing): number[] => {
  if (!listing.customisable_days) return [];
  const max = normalizeDurationDays(listing.duration_days);
  return Object.keys(listing.day_prices)
    .map(Number)
    .filter((n) => n >= 1 && n <= max)
    .sort((a, b) => a - b);
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
  const max = normalizeDurationDays(listing.duration_days);
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
 * the combined parent+child demand actually contends for (invariant I7). A capped
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
 * The remaining spots of the **capped group a parent and one of its children
 * share**, or `undefined` when they don't share a capped group. A parent and its
 * required child in the same capped group consume two group spots per order
 * (invariant I7), so callers must reason about combined demand, not each row in
 * isolation.
 *
 * `remainingByGroupId` is the PER-GROUP remaining (groupId → free spots; uncapped
 * groups omitted), so the result is the tightest SHARED group's remaining — the
 * group the parent and child actually contend over — NOT the child's tightest
 * group overall. A child also in a tighter NON-shared group must not drag the
 * shared-pool calc down to that unrelated cap (Codex #3).
 *
 * The single source of truth for both discovery (does the minimum order fit?) and
 * the booking-page quantity ceiling (how many orders fit?), so the two surfaces
 * can never disagree about a shared-group parent's availability.
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
  if (shared.length === 0) return undefined;
  return Math.min(...shared.map((g) => remainingByGroupId.get(g)!));
};

/**
 * The capacity a parent and one of its children share, as two orthogonal facts:
 * - `staticCap` — the group's structural ceiling (`groups.max_attendees`),
 *   date-INDEPENDENT. A share whose static cap is below
 *   {@link PARENT_CHILD_GROUP_UNITS} can NEVER fit a parent+child order, on any
 *   date — so date-less surfaces can mark it sold out without a date.
 * - `remaining` — the group's currently-free spots in the caller's context
 *   (date-less cumulative for standard listings; per-date when a date is known;
 *   `undefined` when not computable, e.g. a daily child with no submitted date).
 *
 * Both are `undefined` when the parent and child do not share a capped group.
 * This is the single capacity vocabulary the bookability evaluator reasons over,
 * so every surface answers "does the combined demand fit?" the same way.
 */
export type SharedGroupCapacity = {
  staticCap: number | undefined;
  remaining: number | undefined;
};

/**
 * Build the {@link SharedGroupCapacity} for a parent/child pair from the PER-GROUP
 * capacity maps (groupId → spots; uncapped groups omitted). They are co-grouped
 * when their group sets intersect in at least one CAPPED group; when they are not,
 * there is no shared cap (both facts `undefined`).
 *
 * Both facts are the tightest value over the groups they SHARE — the pool(s) the
 * combined demand actually contends for — NOT the child's tightest group overall.
 * A child also in a tighter non-shared group must not pull the shared cap down to
 * an unrelated group's value (Codex #3); the static cap and remaining are taken
 * from the SAME shared groups so date-less surfaces reject a share too small to
 * ever hold both even when a daily child's per-date remaining is unknown.
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

export interface Listing {
  active: boolean;
  assign_built_site: boolean;
  attachment_name: string;
  attachment_url: string;
  bookable_days: string[];
  can_pay_more: boolean;
  closes_at: string | null;
  created: string;
  customisable_days: boolean;
  date: string; // encrypted UTC ISO datetime or empty string
  day_prices: DayPrices;
  description: string;
  listing_type: ListingType;
  fields: ListingFields;
  hidden: boolean;
  id: number;
  image_url: string;
  location: string; // encrypted or empty string
  max_attendees: number;
  max_price: number;
  max_quantity: number;
  maximum_days_after: number;
  minimum_days_before: number;
  name: string;
  non_transferable: boolean;
  purchase_only: boolean;
  slug: string;
  slug_index: string;
  thank_you_url: string;
  unit_price: number;
  webhook_url: string;
  months_per_unit: number;
  initial_site_months: number;
  duration_days: number;
  /** When true (and logistics is enabled) this listing is dropped off and
   * collected from the customer, so its attendees carry logistics agents. */
  uses_logistics: boolean;
  /** When true, the fields covered by the operator's listing defaults are
   * inherited live from settings rather than this row's own stored values
   * (see {@link resolveListingDefaults}). A single per-listing flag, never a
   * per-field one, so a stored `false` is never ambiguous. */
  use_defaults: boolean;
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
  id: number;
  user_id: number;
  agent_id: number;
}

export interface Attendee extends ContactInfo {
  attachment_downloads: number;
  checked_in: boolean;
  created: string;
  date: string | null;
  kind: string;
  /** Exclusive end of the booked range (YYYY-MM-DD, the midnight after the last
   * booked day), derived from `listing_attendees.end_at`. Null for date-less
   * (standard) bookings. Lets render paths show each booking's true span — which
   * varies per booking on customisable-days listings — instead of assuming the
   * listing's duration. */
  end_date: string | null;
  listing_id: number;
  id: number;
  payment_id: string;
  pii_blob: string;
  price_paid: string;
  quantity: number;
  refunded: boolean;
  /** Remaining balance owed in minor units (plaintext); 0 when fully paid. */
  remaining_balance: number;
  /** Owner-defined status id (plaintext); null for legacy/default. */
  status_id: number | null;
  /** When true, each delivered listing this attendee books carries its own
   * drop-off/collection agents; when false a single pair applies to them all. */
  split_logistics_agents: boolean;
  ticket_token: string;
  ticket_token_index: string;
  /** The package group this booking row belongs to (0 = not a package). Stamped
   * on every row of a package order so tickets/emails group the order under the
   * package by this persisted id. */
  package_group_id: number;
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
};

export interface Settings {
  key: string;
  value: string;
}

export interface Session {
  csrf_token: string;
  expires: number;
  token: string; // Contains the hashed token for DB storage
  user_id: number;
  wrapped_data_key: string | null;
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

/** True for roles that may reach the delivery run sheet (owner/manager/agent). */
export const isDeliveryRole = roleIn(DELIVERY_ADMIN_LEVELS);

/** Type guard: check if a string is a valid AdminLevel */
export const isAdminLevel = (s: string): s is AdminLevel =>
  v.is(AdminLevelSchema, s);

/** Session data needed by admin page templates */
export type AdminSession = {
  readonly adminLevel: AdminLevel;
  readonly settingsNagItems?: readonly NagItem[];
};

export interface User {
  admin_level: string; // encrypted "owner", "manager", "agent" or "editor"
  id: number;
  invite_code_hash: string | null; // encrypted SHA-256 of invite token, null after password set
  invite_expiry: string | null; // encrypted ISO 8601, null after password set
  // DATA_KEY wrapped under the invite code, set at invite time so the user can
  // self-activate at /join; null once activated (see users.acceptInvite).
  invite_wrapped_data_key: string | null;
  // KEK scheme for wrapped_data_key: 1 = legacy (hash-derived), 2 = password-
  // bound. Legacy rows upgrade to 2 on their owner's next login.
  kek_version: number;
  password_hash: string; // PBKDF2 hash encrypted at rest
  username_hash: string; // encrypted at rest, decrypted to display
  username_index: string; // HMAC hash for lookups
  wrapped_data_key: string | null; // wrapped with user's KEK
}

export interface ApiKey {
  created: string;
  id: number;
  key_index: string; // HMAC hash for lookup
  last_used: string; // ISO 8601 or empty string
  name: string; // encrypted label
  user_id: number;
  wrapped_data_key: string; // DATA_KEY wrapped with the API key token
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
   * per-listing price overrides (group_listings.package_price) and fixed
   * per-package quantities (group_listings.quantity). */
  is_package: boolean;
  max_attendees: number;
  name: string;
  slug: string;
  slug_index: string;
  terms_and_conditions: string;
}

/** A row in the group_listings join table: listing_id belongs to group_id. A
 * listing may have many such rows (membership in several groups). `package_price`
 * (minor units, 0 = no override) is the per-listing price when the group is a
 * package; `quantity` (≥1) is how many of this listing one unit of the package
 * includes. Both are ignored for non-package groups. */
export interface GroupListing {
  group_id: number;
  listing_id: number;
  package_price: number;
  quantity: number;
}

/** An owner-defined price modifier (surcharge / discount / add-on). `calc_value`
 * is the positive magnitude the owner entered (a fixed amount in major currency
 * units, a percentage, or a multiplier); `direction` chooses charge vs discount. */
export interface Modifier {
  id: number;
  name: string;
  calc_kind: CalcKind;
  calc_value: number;
  direction: ModifierDirection;
  active: boolean;
  trigger: ModifierTrigger;
  /** Promo code (trigger = "code"), shown to the owner; "" for other triggers. */
  code: string;
  /** Blind index (HMAC) of the normalised code, for public code lookup; null
   * when the modifier has no code. */
  code_index: string | null;
  scope: ModifierScope;
  /** Minimum in-scope subtotal (minor units) for the modifier to apply. */
  min_subtotal: number;
  /** Minimum prior bookings required for the modifier to apply. */
  min_visits: number;
  /** Remaining-stock cap, or null for unlimited. Consumed monotonically. */
  stock: number | null;
  /** Trigger-maintained SUM(quantity) over this modifier's usage rows. */
  total_uses: number;
  /** Trigger-maintained COUNT of this modifier's usage rows. */
  usage_count: number;
  /** Projected from the transfers ledger as `balanceOf(modifier:M)` — the
   * modifier account's net effect on revenue (surcharges in, discounts out),
   * read directly, in minor units. */
  total_revenue: number;
}

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

/** A single row in the attendee table (attendee + parent listing context) */
export type AttendeeTableRow = {
  attendee: Attendee;
  listingId: number;
  listingName: string;
};
