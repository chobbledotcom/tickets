import { settings } from "#db/settings.ts";
import { isNotNullish } from "#fp";
import { toMajorUnits } from "#shared/currency.ts";
import { showUseDefaultsToggle } from "#shared/listing-defaults.ts";
import {
  LISTING_FIELDS,
  type ListingInput,
} from "#shared/records/listing-fields.ts";
import { closedFieldsFor } from "#shared/records/write-access.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import type { AdminLevel, DayPrices, ListingWithCount } from "#types";

const checked = (name: string, value: unknown): TestFormValues =>
  value ? { [name]: "1" } : {};
const flagChoice = (value: unknown): string => (value ? "1" : "");
const optionalNumber = (v: number | null | undefined): string =>
  isNotNullish(v) ? String(v) : "";
const repeated = (value: string): string[] =>
  value ? value.split(",").map((part) => part.trim()) : [];

/** Serialize a DayPrices map into the form's `dayPrice<n>` fields. */
const dayPriceFormFields = (
  dayPrices: DayPrices | undefined,
): TestFormValues => {
  const result: Record<string, string> = {};
  for (const [days, price] of Object.entries(dayPrices ?? {})) {
    result[`dayPrice${days}`] = toMajorUnits(price);
  }
  return result;
};

const splitClosesAt = (
  update: string | null | undefined,
  existing: string | null,
): { date: string; time: string } => {
  const value = update !== undefined ? update : (existing?.slice(0, 16) ?? "");
  if (!value) return { date: "", time: "" };
  const [date = "", time = ""] = value.split("T");
  return { date, time };
};

const pickField = <T>(update: T | undefined, existing: T): T =>
  update !== undefined ? update : existing;

const formatOptional = (update: string | undefined, existing: string): string =>
  update ?? existing;

const formatPrice = (update: number | undefined, existing: number): string =>
  update !== undefined ? toMajorUnits(update) : toMajorUnits(existing);

export const priceFormValue = (minorUnits: number): string =>
  toMajorUnits(minorUnits);

/** True when the writer's listing page shows the "use defaults" switch. */
export const defaultsSwitchShown = (adminLevel: AdminLevel): boolean =>
  showUseDefaultsToggle(
    closedFieldsFor(LISTING_FIELDS, adminLevel),
    settings.listingDefaults,
  );

/** Keep only the boxes the writer's listing page shows: the page hides the
 *  box of each field the writer cannot set, and refuses a form that sends one. */
const pageBoxes = (
  values: TestFormValues,
  adminLevel: AdminLevel,
): TestFormValues => {
  const closed = closedFieldsFor(LISTING_FIELDS, adminLevel);
  const shownDefaults = defaultsSwitchShown(adminLevel);
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key]) => !closed.has(key) && (shownDefaults || key !== "useDefaults"),
    ),
  );
};

/** True when a box holds what an untouched page sends. */
const isUntouched = (value: TestFormValues[string]): boolean =>
  value === "" || value === "0";

/** The create form a writer's page sends. A fixture that asks for a value
 *  in a box the page hides throws, so it must turn the feature on first. */
export const buildCreateListingForm = (
  input: Omit<ListingInput, "slug" | "slugIndex">,
  adminLevel: AdminLevel = "owner",
): TestFormValues => {
  const boxes = createListingBoxes(input);
  const shown = pageBoxes(boxes, adminLevel);
  const hidden = Object.keys(boxes).filter(
    (key) => !(key in shown) && !isUntouched(boxes[key]!),
  );
  if (hidden.length > 0) {
    throw new Error(
      `The listing page hides ${hidden.join(", ")}. Turn its feature on first.`,
    );
  }
  return shown;
};

const createListingBoxes = (
  input: Omit<ListingInput, "slug" | "slugIndex">,
): TestFormValues => {
  const closesAtParts = splitClosesAt(input.closesAt, null);
  const dateParts = splitClosesAt(input.date, null);
  const initialSiteMonths =
    input.initialSiteMonths ?? (input.assignBuiltSite ? 1 : 0);
  return {
    ...checked("assignBuiltSite", input.assignBuiltSite),
    ...checked("bookableAlone", input.bookableAlone),
    bookableDays: input.bookableDays ?? [],
    ...checked("canPayMore", input.canPayMore),
    closesAtDate: closesAtParts.date,
    closesAtTime: closesAtParts.time,
    ...checked("customisableDays", input.customisableDays),
    dateDate: dateParts.date,
    dateTime: dateParts.time,
    description: input.description ?? "",
    durationDays: optionalNumber(input.durationDays),
    ...checked("usesLogistics", input.usesLogistics),
    ...dayPriceFormFields(input.dayPrices),
    fields: repeated(input.fields ?? "email"),
    ...checked("hidden", input.hidden),
    initialSiteMonths: String(initialSiteMonths),
    listingType: input.listingType ?? "",
    location: input.location ?? "",
    maxAttendees: String(input.maxAttendees),
    maxPrice: toMajorUnits(input.maxPrice),
    maxQuantity: String(input.maxQuantity ?? 1),
    maximumDaysAfter: optionalNumber(input.maximumDaysAfter),
    minQuantity: String(input.minQuantity ?? 1),
    minimumDaysBefore: optionalNumber(input.minimumDaysBefore),
    monthsPerUnit: String(input.monthsPerUnit ?? 0),
    name: input.name,
    nonTransferable: flagChoice(input.nonTransferable),
    ...checked("purchaseOnly", input.purchaseOnly),
    thankYouUrl: input.thankYouUrl ?? "",
    unitPrice: toMajorUnits(input.unitPrice ?? 0),
    ...checked("useDefaults", input.useDefaults),
    webhookUrl: input.webhookUrl ?? "",
  };
};

const buildUpdateBoolFields = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): TestFormValues => ({
  ...checked(
    "assignBuiltSite",
    pickField(updates.assignBuiltSite, existing.assignBuiltSite),
  ),
  ...checked(
    "bookableAlone",
    pickField(updates.bookableAlone, existing.bookableAlone),
  ),
  ...checked(
    "canPayMore",
    pickField(updates.canPayMore, existing.canPayMore),
  ),
  ...checked("hidden", pickField(updates.hidden, existing.hidden)),
  nonTransferable: flagChoice(
    pickField(updates.nonTransferable, existing.nonTransferable),
  ),
  ...checked(
    "purchaseOnly",
    pickField(updates.purchaseOnly, existing.purchaseOnly),
  ),
  ...checked(
    "useDefaults",
    pickField(updates.useDefaults, existing.useDefaults),
  ),
  ...checked(
    "usesLogistics",
    pickField(updates.usesLogistics, existing.usesLogistics),
  ),
});

const buildUpdateNumericFields = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): TestFormValues => {
  const assignsBuiltSite = pickField(
    updates.assignBuiltSite,
    existing.assignBuiltSite,
  );
  const initialSiteMonths = assignsBuiltSite
    ? pickField(updates.initialSiteMonths, existing.initialSiteMonths || 1)
    : pickField(updates.initialSiteMonths, existing.initialSiteMonths);
  return {
    durationDays: String(
      pickField(updates.durationDays, existing.durationDays),
    ),
    initialSiteMonths: String(initialSiteMonths),
    maxAttendees: String(
      pickField(updates.maxAttendees, existing.maxAttendees),
    ),
    maxPrice: toMajorUnits(pickField(updates.maxPrice, existing.maxPrice)),
    maxQuantity: String(pickField(updates.maxQuantity, existing.maxQuantity)),
    maximumDaysAfter: String(
      pickField(updates.maximumDaysAfter, existing.maximumDaysAfter),
    ),
    minQuantity: String(pickField(updates.minQuantity, existing.minQuantity)),
    minimumDaysBefore: String(
      pickField(updates.minimumDaysBefore, existing.minimumDaysBefore),
    ),
    monthsPerUnit: String(
      pickField(updates.monthsPerUnit, existing.monthsPerUnit),
    ),
    unitPrice: formatPrice(updates.unitPrice, existing.unitPrice),
  };
};

const buildUpdateStringFields = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): TestFormValues => ({
  bookableDays: pickField(updates.bookableDays, existing.bookableDays),
  description: pickField(updates.description, existing.description),
  fields: repeated(pickField(updates.fields, existing.fields)),
  listingType: pickField(updates.listingType, existing.listingType),
  location: pickField(updates.location, existing.location),
  name: pickField(updates.name, existing.name),
  slug: pickField(updates.slug, existing.slug),
  thankYouUrl: formatOptional(updates.thankYouUrl, existing.thankYouUrl),
  webhookUrl: formatOptional(updates.webhookUrl, existing.webhookUrl),
});

export const buildUpdateListingForm = (
  updates: Partial<ListingInput> & { assignUndatedTo?: string },
  existing: ListingWithCount,
  adminLevel: AdminLevel = "owner",
): TestFormValues => {
  const closesAtParts = splitClosesAt(updates.closesAt, existing.closesAt);
  const dateParts = splitClosesAt(updates.date, existing.date);
  return pageBoxes(
    {
      ...buildUpdateBoolFields(updates, existing),
      ...buildUpdateNumericFields(updates, existing),
      ...buildUpdateStringFields(updates, existing),
      ...dayPriceFormFields(updates.dayPrices ?? existing.dayPrices),
      closesAtDate: closesAtParts.date,
      closesAtTime: closesAtParts.time,
      ...checked(
        "customisableDays",
        updates.customisableDays ?? existing.customisableDays,
      ),
      dateDate: dateParts.date,
      dateTime: dateParts.time,
      // A switch that must date undated bookings first carries the organiser's
      // chosen day under this field; the save then moves them and flips.
      ...(updates.assignUndatedTo === undefined
        ? {}
        : { assignUndatedTo: updates.assignUndatedTo }),
    },
    adminLevel,
  );
};
