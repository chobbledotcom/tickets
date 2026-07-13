/** Listing table schema and stored-value transforms. */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { BlindIndex, EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { VALID_DAY_NAMES } from "#shared/dates.ts";
import {
  defineIdTable,
  encryptedNameSchema,
  idAndEncryptedSlugSchema,
} from "#shared/db/common-schema.ts";
import { decryptTextOrEmpty } from "#shared/db/encrypted-text.ts";
import { col } from "#shared/db/table.ts";
import { decryptImageFilenameOrEmpty } from "#shared/images/broken.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import {
  type DayPrices,
  type Listing,
  type ListingFields,
  type ListingType,
  normalizeDurationDays,
  parseDayPrices,
} from "#shared/types.ts";

const DEFAULT_BOOKABLE_DAYS: string[] = [...VALID_DAY_NAMES];

/** Listing input fields for create/update (camelCase). */
export type ListingInput = {
  name: string;
  description?: string;
  date?: string;
  location?: string;
  slug: string;
  slugIndex: BlindIndex;
  /** Transient group membership; the group_listings table stores it. */
  groupIds?: number[];
  maxAttendees: number;
  thankYouUrl?: string | undefined;
  unitPrice?: number | undefined;
  maxQuantity?: number;
  webhookUrl?: string;
  active?: boolean;
  fields?: ListingFields;
  closesAt?: string | undefined;
  listingType?: ListingType;
  bookableDays?: string[] | undefined;
  minimumDaysBefore?: number;
  maximumDaysAfter?: number;
  attachmentUrl?: string;
  attachmentName?: string;
  nonTransferable?: boolean;
  canPayMore?: boolean;
  maxPrice: number;
  hidden?: boolean;
  purchaseOnly?: boolean;
  assignBuiltSite?: boolean;
  monthsPerUnit?: number;
  initialSiteMonths?: number;
  durationDays?: number;
  customisableDays?: boolean;
  dayPrices?: DayPrices;
  usesLogistics?: boolean;
  useDefaults?: boolean;
  bookableAlone?: boolean;
};

/** Compute the blind index used for listing slug lookups. */
export const computeSlugIndex = (slug: string): Promise<BlindIndex> =>
  hmacHash(slug);

const TZ_SUFFIX_REGEX = /(?:Z|[+-]\d{2}:\d{2})$/i;

const normalizeUtcDatetime = (value: string, label: string): string => {
  if (value === "") return "";
  let normalized = value;
  if (!TZ_SUFFIX_REGEX.test(value)) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `${label} missing timezone offset (${value})`,
    });
    normalized = `${value}Z`;
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `${label} invalid datetime (${value})`,
    });
    return "";
  }
  return date.toISOString();
};

const encryptDatetime = (
  value: string,
  label: string,
): Promise<EnvKeyEncrypted> => encrypt(normalizeUtcDatetime(value, label));

const decryptDatetime = async (value: EnvKeyEncrypted): Promise<string> => {
  const decrypted = await decrypt(value);
  return decrypted === ""
    ? ""
    : normalizeUtcDatetime(decrypted, "stored datetime");
};

const writeClosesAt = (value: string | null): Promise<EnvKeyEncrypted> =>
  // defineTable skips write transforms for null values.
  encryptDatetime(value as string, "closes_at");

const readClosesAt = async (value: string | null): Promise<string | null> => {
  // closes_at is NOT NULL and always stores env-key ciphertext.
  const result = await decryptDatetime(value as EnvKeyEncrypted);
  return result === "" ? null : result;
};

const writeListingDate = (value: string): Promise<EnvKeyEncrypted> =>
  encryptDatetime(value, "date");

// The `as` cast is the sanctioned read boundary for a projected encrypted
// column — the raw SELECT value re-enters the typed world here.
const readProjectedAltText = (value: unknown): string | Promise<string> =>
  decryptTextOrEmpty(value as EnvKeyEncrypted | "" | undefined);

/** Read one of the projected first-image filename columns. A filename that
 * will not read back becomes the broken-image marker (reported, not thrown)
 * so a listing page still renders — see #shared/images/broken.ts. */
const readProjectedImageFilename =
  (label: string) =>
  (value: unknown, rowId?: unknown): string | Promise<string> =>
    decryptImageFilenameOrEmpty(
      value as string | undefined,
      `listing ${String(rowId)} ${label}`,
    );

/** Raw listings table. Records adds cache-aware CRUD and price syncing. */
export const rawListingsTable = defineIdTable<Listing, ListingInput>(
  "listings",
  {
    ...idAndEncryptedSlugSchema(encrypt, decrypt),
    ...encryptedNameSchema(encrypt, decrypt),
    active: col.boolean(true),
    assign_built_site: col.boolean(false),
    attachment_name: col.encryptedText(encrypt, decrypt),
    attachment_url: col.encryptedText(encrypt, decrypt),
    bookable_alone: col.boolean(false),
    bookable_days: col.converted<string[]>({
      default: () => [...DEFAULT_BOOKABLE_DAYS],
      read: (value) => {
        const parsed: unknown = JSON.parse(value as string);
        return Array.isArray(parsed) ? parsed : [];
      },
      write: (value) => JSON.stringify(value),
    }),
    can_pay_more: col.boolean(false),
    closes_at: col.transform<string | null>(writeClosesAt, readClosesAt),
    created: col.withDefault(() => nowIso()),
    customisable_days: col.boolean(false),
    date: {
      default: () => "",
      ...col.encrypted(writeListingDate, decryptDatetime),
    },
    day_prices: col.projected<DayPrices>((value) =>
      parseDayPrices(JSON.parse((value as string) ?? "{}")),
    ),
    description: col.encryptedText(encrypt, decrypt),
    duration_days: { default: () => 1, write: normalizeDurationDays },
    fields: col.withDefault<ListingFields>(() => "email"),
    hidden: col.boolean(false),
    image_alt_text: col.projected<string>(readProjectedAltText),
    image_thumb_url: col.projected<string>(
      readProjectedImageFilename("thumbnail image"),
    ),
    image_url: col.projected<string>(readProjectedImageFilename("image")),
    initial_site_months: col.withDefault(() => 0),
    listing_type: col.withDefault<ListingType>(() => "standard"),
    location: col.encryptedText(encrypt, decrypt),
    max_attendees: col.simple<number>(),
    max_price: col.withDefault(() => 0),
    max_quantity: col.withDefault(() => 1),
    maximum_days_after: col.withDefault(() => 90),
    minimum_days_before: col.withDefault(() => 1),
    months_per_unit: col.withDefault(() => 0),
    non_transferable: col.boolean(false),
    purchase_only: col.boolean(false),
    thank_you_url: col.encryptedText(encrypt, decrypt),
    unit_price: col.withDefault(() => 0),
    use_defaults: col.boolean(false),
    uses_logistics: col.boolean(false),
    webhook_url: col.encryptedText(encrypt, decrypt),
  },
);
