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
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  LISTING_DEFAULT_FIELDS,
  type ListingDefaultField,
  type ListingDefaults,
} from "#shared/listing-defaults.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import { validateSafeServerFetchUrl } from "#shared/url-safety.ts";
import {
  parseNonNegativeInt,
  parsePositiveInt,
} from "#shared/validation/number.ts";
import { adminListingDefaultsPage } from "#templates/admin/listing-defaults.tsx";
import { VALID_DAY_NAMES } from "#templates/fields.ts";

type ParseResult =
  | { ok: true; value: ListingDefaults }
  | { ok: false; error: string };

const inputName = (field: ListingDefaultField): string =>
  `default_${field.field}`;

const labelFor = (field: ListingDefaultField): string =>
  t(`listing_defaults.field.${field.field}.label`);

/** Parse one bool field's tri-state select into true/false/undefined. */
const parseBool = (raw: string): boolean | undefined =>
  raw === "1" ? true : raw === "0" ? false : undefined;

/** Parse one number field, enforcing its range. Blank ⇒ unset; bad ⇒ error. */
const parseNumberField = (
  field: ListingDefaultField,
  raw: string,
): { value?: number; error?: string } => {
  if (raw === "") return {};
  if (field.field === "duration_days") {
    const parsed = parsePositiveInt(raw);
    if (parsed === null || parsed > MAX_DURATION_DAYS) {
      return {
        error: t("listing_defaults.error.duration", {
          max: MAX_DURATION_DAYS,
        }),
      };
    }
    return { value: parsed };
  }
  const parsed = parseNonNegativeInt(raw);
  if (parsed === null) {
    return {
      error: t("listing_defaults.error.number", { label: labelFor(field) }),
    };
  }
  return { value: parsed };
};

/** Parse one URL field. Blank ⇒ unset; unsafe ⇒ error. */
const parseUrlField = (
  field: ListingDefaultField,
  form: FormParams,
): FieldParse => {
  const raw = form.getString(inputName(field));
  if (raw === "") return {};
  const error = validateSafeServerFetchUrl(
    raw,
    t("fields.validation.url_https"),
  );
  return error ? { error } : { value: raw };
};

/** Parse the bookable-days default: only set when its enable box is ticked, and
 * at least one valid day (in canonical order) must be chosen. */
const parseDaysField = (form: FormParams): FieldParse => {
  if (form.getString("default_bookable_days_enabled") !== "1") return {};
  const days = VALID_DAY_NAMES.filter((day) =>
    form.getAll("default_bookable_days").includes(day),
  );
  if (days.length === 0) return { error: t("listing_defaults.days_required") };
  return { value: days };
};

/** One field's parse outcome: a value to set, an error, or neither (unset). */
type FieldParse = { value?: unknown; error?: string };

/** Dispatch one field to its kind's parser. */
const parseField = (
  field: ListingDefaultField,
  form: FormParams,
): FieldParse => {
  if (field.kind === "bool") {
    return { value: parseBool(form.getString(inputName(field))) };
  }
  if (field.kind === "number") {
    return parseNumberField(field, form.getString(inputName(field)));
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
    if (error) return { error, ok: false };
    if (parsed !== undefined) value[field.key] = parsed;
  }
  return { ok: true, value: value as ListingDefaults };
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
  save: async (result) => {
    if (result.ok) await settings.update.listingDefaults(result.value);
  },
  validate: (result) => (result.ok ? null : result.error),
});
