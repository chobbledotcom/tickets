/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { decrypt, encrypt } from "#crypto/encryption.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import { col } from "#db/table.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import {
  clampDurationDays,
  type DayPrices,
  DayPricesSchema,
  type ListingFields,
  type ListingType,
} from "#types";
import type { OptionalCatalogFieldValues } from "./definition.ts";

/* jscpd:ignore-end */

const [CATALOG_API, CATALOG_FORM, CATALOG_API_FORM] = [1, 2, 3] as const;
const encryptedTextColumn = col.encryptedText(encrypt, decrypt);
const falseColumn = col.boolean(false);
const zeroColumn = col.withDefault(() => 0);
const oneColumn = col.withDefault(() => 1);

export const listingCatalogFields = {
  active: ["active", col.boolean(true), "boolean", CATALOG_API],
  assignBuiltSite: ["assign_built_site", falseColumn, "boolean"],
  attachmentName: ["attachment_name", encryptedTextColumn],
  attachmentUrl: ["attachment_url", encryptedTextColumn],
  bookableAlone: ["bookable_alone", falseColumn, "boolean", CATALOG_API_FORM],
  bookableDays: [
    "bookable_days",
    col.json(v.array(v.string()), {
      context: "listings.bookable_days",
      default: () => [...VALID_DAY_NAMES],
    }),
    "bookableDays",
    CATALOG_API,
  ],
  canPayMore: ["can_pay_more", falseColumn, "boolean", CATALOG_API_FORM],
  closesAt: ["closes_at", undefined, "nullableDatetime", CATALOG_API],
  customisableDays: [
    "customisable_days",
    falseColumn,
    "boolean",
    CATALOG_API_FORM,
  ],
  date: ["date", undefined, "datetime", CATALOG_API],
  dayPrices: [
    "day_prices",
    col.json(DayPricesSchema, {
      context: "listings.day_prices",
      projected: true,
      whenMissing: () => ({}),
    }),
    "dayPrices",
  ],
  description: ["description", encryptedTextColumn, "string", CATALOG_API_FORM],
  durationDays: [
    "duration_days",
    { default: () => 1, write: clampDurationDays },
    "durationDays",
    CATALOG_API_FORM,
    1,
  ],
  fields: [
    "fields",
    col.withDefault<ListingFields>(() => "email"),
    "fields",
    CATALOG_API_FORM,
  ],
  hidden: ["hidden", falseColumn, "boolean", CATALOG_API_FORM],
  initialSiteMonths: [
    "initial_site_months",
    zeroColumn,
    "nonNegativeInt",
    CATALOG_FORM,
    0,
  ],
  listingType: [
    "listing_type",
    col.withDefault<ListingType>(() => "standard"),
    "listingType",
    CATALOG_API,
  ],
  location: ["location", encryptedTextColumn, "string", CATALOG_API_FORM],
  maxAttendees: [
    "max_attendees",
    col.simple<number>(),
    "requiredPositiveInt",
    CATALOG_API_FORM,
  ],
  maximumDaysAfter: [
    "maximum_days_after",
    col.withDefault(() => 90),
    "nonNegativeInt",
    CATALOG_API_FORM,
    90,
  ],
  maxPrice: ["max_price", zeroColumn, "maxPrice", CATALOG_API],
  maxQuantity: ["max_quantity", oneColumn, "positiveInt", CATALOG_API_FORM],
  minimumDaysBefore: [
    "minimum_days_before",
    oneColumn,
    "nonNegativeInt",
    CATALOG_API_FORM,
    1,
  ],
  monthsPerUnit: [
    "months_per_unit",
    zeroColumn,
    "nonNegativeInt",
    CATALOG_FORM,
    0,
  ],
  name: ["name", undefined, "name", CATALOG_FORM],
  nonTransferable: [
    "non_transferable",
    falseColumn,
    "boolean",
    CATALOG_API_FORM,
  ],
  purchaseOnly: ["purchase_only", falseColumn, "boolean", CATALOG_FORM],
  thankYouUrl: [
    "thank_you_url",
    encryptedTextColumn,
    "string",
    CATALOG_API_FORM,
  ],
  unitPrice: ["unit_price", zeroColumn, "price", CATALOG_API],
  useDefaults: ["use_defaults", falseColumn, "boolean", CATALOG_API],
  usesLogistics: ["uses_logistics", falseColumn, "boolean"],
  webhookUrl: ["webhook_url", encryptedTextColumn, "string", CATALOG_API],
} as const;

interface CatalogInput {
  name: string;
  slug: string;
  slugIndex: BlindIndex;
}

/** Listing input fields for create/update (camelCase). */
export interface ListingInput
  extends CatalogInput,
    Omit<OptionalCatalogFieldValues<typeof listingCatalogFields>, "name"> {
  /** Transient group membership; the group_listings table stores it. */
  groupIds?: number[];
  maxAttendees: number;
  maxPrice: number;
}

export const groupCatalogFields = {
  description: ["description", encryptedTextColumn, "string", CATALOG_API_FORM],
  hidden: ["hidden", falseColumn, "boolean", CATALOG_API_FORM],
  hidePackageListings: [
    "hide_package_listings",
    falseColumn,
    "boolean",
    CATALOG_API_FORM,
  ],
  isPackage: ["is_package", falseColumn, "boolean", CATALOG_API_FORM],
  maxAttendees: [
    "max_attendees",
    col.simple<number>(),
    "nonNegativeInt",
    CATALOG_API_FORM,
    0,
  ],
  name: ["name", undefined, "name", CATALOG_FORM],
  termsAndConditions: [
    "terms_and_conditions",
    encryptedTextColumn,
    "string",
    CATALOG_API_FORM,
  ],
} as const;

/** A package member's price, quantity, and per-day overrides. */
export interface PackageMemberInput {
  dayPrices?: DayPrices | undefined;
  listingId: number;
  /** `null` uses the listing price; `0` makes this member free. */
  price: number | null;
  quantity?: number;
}

/** Group input fields for create/update (camelCase). */
export interface GroupInput
  extends CatalogInput,
    Omit<OptionalCatalogFieldValues<typeof groupCatalogFields>, "name"> {
  /** Absent leaves existing package rows untouched; an empty array clears them. */
  packageMembers?: PackageMemberInput[] | undefined;
}
