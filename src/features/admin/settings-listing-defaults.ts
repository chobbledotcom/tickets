/**
 * Listing Defaults settings page — owner only.
 *
 * GET renders the form; POST parses every defaultable field, sets only the ones
 * the operator gave a value to, validates them, and saves the blob. Saving bumps
 * the settings version, so listings inheriting defaults pick up the change on
 * their next read (defaults resolve live — see `resolveListingDefaults`).
 */

import { t } from "#i18n";
import { settingsHandler } from "#routes/admin/settings-helpers.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { invalidateListingsCache } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { isDemoMode } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  LISTING_DEFAULT_FIELDS,
  type ListingDefaultField,
  type ListingDefaults,
  listingDefaultInputName,
  listingDefaultLabelKey,
} from "#shared/listing-defaults.ts";
import { validateSafeServerFetchUrl } from "#shared/url-safety.ts";
import { parseNonNegativeInt } from "#shared/validation/number.ts";
import { adminListingDefaultsPage } from "#templates/admin/listing-defaults.tsx";
import { VALID_DAY_NAMES } from "#templates/fields.ts";

/** One field's parse outcome: a value to set, an error, or neither (unset). */
type FieldParse = { value?: unknown; error?: string };

/** The parsed defaults plus the first validation error, if any. `value` always
 * holds whatever parsed cleanly; `error` non-null means the handler rejects it. */
type ParseResult = { value: ListingDefaults; error: string | null };

/** Read a field's submitted value from the form. */
const submitted = (field: ListingDefaultField, form: FormParams): string =>
  form.getString(listingDefaultInputName(field));

/** Parse one bool field's tri-state select into true/false/undefined. */
const parseBool = (raw: string): boolean | undefined =>
  raw === "1" ? true : raw === "0" ? false : undefined;

/** Parse one number field (a non-negative day count). Blank ⇒ unset; bad ⇒ error. */
const parseNumberField = (
  field: ListingDefaultField,
  raw: string,
): FieldParse => {
  if (raw === "") return {};
  const value = parseNonNegativeInt(raw);
  return value === null
    ? {
        error: t("listing_defaults.error.number", {
          label: t(listingDefaultLabelKey(field)),
        }),
      }
    : { value };
};

/** Parse one URL field. Blank ⇒ unset; unsafe ⇒ error. */
const parseUrlField = (
  field: ListingDefaultField,
  form: FormParams,
): FieldParse => {
  // Demo mode blanks per-listing webhook URLs so demo users can't configure
  // outbound callbacks; refuse the webhook default the same way, or a
  // Use-defaults listing would resolve it and fire registration webhooks.
  if (field.field === "webhook_url" && isDemoMode()) return {};
  const raw = submitted(field, form);
  if (raw === "") return {};
  const error = validateSafeServerFetchUrl(
    raw,
    t("fields.validation.url_https"),
  );
  return error ? { error } : { value: raw };
};

/** Parse the bookable-days default: only set when its enable box is ticked, with
 * at least one valid day (in canonical order). */
const parseDaysField = (form: FormParams): FieldParse => {
  if (form.getString("default_bookable_days_enabled") !== "1") return {};
  const days = VALID_DAY_NAMES.filter((day) =>
    form.getAll("default_bookable_days").includes(day),
  );
  if (days.length === 0) return { error: t("listing_defaults.days_required") };
  return { value: days };
};

/** Dispatch one field to its kind's parser. */
const parseField = (
  field: ListingDefaultField,
  form: FormParams,
): FieldParse => {
  if (field.kind === "bool")
    return { value: parseBool(submitted(field, form)) };
  if (field.kind === "number") {
    return parseNumberField(field, submitted(field, form));
  }
  if (field.kind === "url") return parseUrlField(field, form);
  return parseDaysField(form);
};

/**
 * Parse the form into a {@link ListingDefaults}. The logistics default is only
 * accepted when the feature is enabled. Returns the first validation error
 * encountered, or the assembled defaults.
 */
export const parseListingDefaultsForm = (
  form: FormParams,
  hasLogistics: boolean,
): ParseResult => {
  const value: Record<string, unknown> = {};
  for (const field of LISTING_DEFAULT_FIELDS) {
    if (field.field === "uses_logistics" && !hasLogistics) continue;
    const { value: parsed, error } = parseField(field, form);
    if (error) return { error, value: value as ListingDefaults };
    if (parsed !== undefined) value[field.key] = parsed;
  }
  return { error: null, value: value as ListingDefaults };
};

/** GET /admin/listing-defaults — owner only. */
export const handleListingDefaultsGet: TypedRouteHandler<
  "GET /admin/listing-defaults"
> = (request) =>
  requireOwnerOr(request, (session) => {
    const flash = applyFlash(request);
    return htmlResponse(
      adminListingDefaultsPage(
        session,
        settings.listingDefaults,
        settings.hasLogistics,
        flash.error,
        flash.success,
      ),
    );
  });

/** POST /admin/listing-defaults — owner only. */
export const handleListingDefaultsPost = settingsHandler<ParseResult>({
  extract: (form) => parseListingDefaultsForm(form, settings.hasLogistics),
  label: "Listing defaults",
  log: () => t("listing_defaults.saved"),
  redirectTo: "/admin/listing-defaults",
  // validate() rejects a non-null error before save() runs, so save always has
  // a clean value to persist.
  save: async (result) => {
    await settings.update.listingDefaults(result.value);
    // Listings inherit defaults at the cache layer (`decryptListingWithCount`),
    // which has its own TTL and is not invalidated by settings writes — so drop
    // it here, otherwise warm isolates would serve stale inherited values until
    // the TTL lapsed or an unrelated listing write cleared it.
    invalidateListingsCache();
  },
  validate: (result) => result.error,
});
