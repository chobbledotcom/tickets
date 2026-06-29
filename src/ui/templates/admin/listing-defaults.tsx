/**
 * Listing Defaults settings page.
 *
 * One control per defaultable field, driven by {@link LISTING_DEFAULT_FIELDS}.
 * A field left at "No default" is omitted from the saved blob, so listings keep
 * deciding it themselves; any other value becomes the inherited default.
 */

import { t } from "#i18n";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import {
  listingDefaultInputName as inputName,
  LISTING_DEFAULT_FIELDS,
  type ListingDefaultField,
  type ListingDefaultKind,
  type ListingDefaults,
  listingDefaultHintKey,
  listingDefaultLabelKey,
} from "#shared/listing-defaults.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { VALID_DAY_NAMES } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

const labelFor = (field: ListingDefaultField): string =>
  t(listingDefaultLabelKey(field));

const hintFor = (field: ListingDefaultField): string =>
  t(listingDefaultHintKey(field));

/** Tri-state select: no default / yes / no. */
const BoolControl = ({
  field,
  value,
}: {
  field: ListingDefaultField;
  value: boolean | undefined;
}): JSX.Element => (
  <label>
    {labelFor(field)}
    <select name={inputName(field)}>
      <option selected={value === undefined} value="">
        {t("listing_defaults.no_default")}
      </option>
      <option selected={value === true} value="1">
        {t("listing_defaults.bool_yes")}
      </option>
      <option selected={value === false} value="0">
        {t("listing_defaults.bool_no")}
      </option>
    </select>
    <small>{hintFor(field)}</small>
  </label>
);

/** Number input; blank means no default. */
const NumberControl = ({
  field,
  value,
}: {
  field: ListingDefaultField;
  value: number | undefined;
}): JSX.Element => (
  <label>
    {labelFor(field)}
    <input
      min={0}
      name={inputName(field)}
      type="number"
      value={value === undefined ? "" : String(value)}
    />
    <small>{hintFor(field)}</small>
  </label>
);

/** URL input; blank means no default. */
const UrlControl = ({
  field,
  value,
}: {
  field: ListingDefaultField;
  value: string | undefined;
}): JSX.Element => (
  <label>
    {labelFor(field)}
    <input
      name={inputName(field)}
      placeholder={t("listing_defaults.url_placeholder")}
      type="url"
      value={value ?? ""}
    />
    <small>{hintFor(field)}</small>
  </label>
);

/** Enable toggle plus the day checkboxes. */
const DaysControl = ({
  field,
  value,
}: {
  field: ListingDefaultField;
  value: string[] | undefined;
}): JSX.Element => (
  <fieldset class="listing-section">
    <legend>{labelFor(field)}</legend>
    <label>
      <input
        checked={value !== undefined}
        name="default_bookable_days_enabled"
        type="checkbox"
        value="1"
      />
      {t("listing_defaults.days_enable")}
    </label>
    <div class="stack">
      {VALID_DAY_NAMES.map((day) => (
        <label>
          <input
            checked={value?.includes(day) ?? false}
            name={inputName(field)}
            type="checkbox"
            value={day}
          />
          {day}
        </label>
      ))}
    </div>
    <small>{hintFor(field)}</small>
  </fieldset>
);

/** Per-kind control. Keyed by {@link ListingDefaultKind} so a new kind is a
 * compile error here, matching the parser and listing-form formatter. */
const KIND_CONTROLS: Record<
  ListingDefaultKind,
  (
    field: ListingDefaultField,
    value: ListingDefaults[keyof ListingDefaults],
  ) => JSX.Element
> = {
  bool: (field, value) => (
    <BoolControl field={field} value={value as boolean | undefined} />
  ),
  days: (field, value) => (
    <DaysControl field={field} value={value as string[] | undefined} />
  ),
  number: (field, value) => (
    <NumberControl field={field} value={value as number | undefined} />
  ),
  url: (field, value) => (
    <UrlControl field={field} value={value as string | undefined} />
  ),
};

const DefaultControl = ({
  field,
  defaults,
}: {
  field: ListingDefaultField;
  defaults: ListingDefaults;
}): JSX.Element => KIND_CONTROLS[field.kind](field, defaults[field.key]);

/**
 * Render the Listing Defaults page. The logistics default is only offered when
 * the logistics feature is enabled — a default that can never take effect would
 * just be confusing.
 */
export const adminListingDefaultsPage = (
  session: AdminSession,
  defaults: ListingDefaults,
  hasLogistics: boolean,
  error?: string,
  success?: string,
): string => {
  const fields = LISTING_DEFAULT_FIELDS.filter(
    (field) => field.field !== "uses_logistics" || hasLogistics,
  );
  return String(
    <Layout title={t("listing_defaults.title")}>
      <AdminNav active="/admin/settings" session={session} />
      <Flash error={error} success={success} />
      <CsrfForm action="/admin/listing-defaults" id="listing-defaults">
        <div class="prose">
          <h2>{t("listing_defaults.title")}</h2>
          <p>{t("listing_defaults.intro")}</p>
        </div>
        <div class="stack">
          {fields.map((field) => (
            <DefaultControl defaults={defaults} field={field} />
          ))}
        </div>
        <SubmitButton icon="save">{t("listing_defaults.save")}</SubmitButton>
      </CsrfForm>
    </Layout>,
  );
};
