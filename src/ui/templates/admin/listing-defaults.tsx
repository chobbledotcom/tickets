/**
 * Listing Defaults settings page.
 *
 * One control per defaultable field, driven by {@link LISTING_DEFAULT_FIELDS}.
 * A field left at "No default" is omitted from the saved blob, so listings keep
 * deciding it themselves; any other value becomes the inherited default.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { CsrfForm } from "#shared/forms.tsx";
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
import { flashAdminPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter, SubmitButton } from "#templates/components/actions.tsx";
import { CheckboxLabel } from "#templates/components/aggregate-sections.tsx";
import { SelectField } from "#templates/components/select-field.tsx";
import { VALID_DAY_NAMES } from "#templates/fields/validators.ts";

/* jscpd:ignore-end */

const labelFor = (field: ListingDefaultField): string =>
  t(listingDefaultLabelKey(field));

const hintFor = (field: ListingDefaultField): string =>
  t(listingDefaultHintKey(field));

/** Label + control + hint wrapper shared by the single-input controls. */
const LabeledInput = ({
  children,
  field,
}: {
  children: JSX.Element;
  field: ListingDefaultField;
}): JSX.Element => (
  <label>
    {labelFor(field)}
    {children}
    <small>{hintFor(field)}</small>
  </label>
);

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
    <SelectField
      name={inputName(field)}
      options={[
        { label: t("listing_defaults.no_default"), value: "" },
        { label: t("listing_defaults.bool_yes"), value: "1" },
        { label: t("listing_defaults.bool_no"), value: "0" },
      ]}
      value={value === undefined ? "" : value === true ? "1" : "0"}
    />
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
  <LabeledInput field={field}>
    <input
      min={0}
      name={inputName(field)}
      type="number"
      value={value === undefined ? "" : String(value)}
    />
  </LabeledInput>
);

/** URL input; blank means no default. */
const UrlControl = ({
  field,
  value,
}: {
  field: ListingDefaultField;
  value: string | undefined;
}): JSX.Element => (
  <LabeledInput field={field}>
    <input
      name={inputName(field)}
      placeholder={t("listing_defaults.url_placeholder")}
      type="url"
      value={value ?? ""}
    />
  </LabeledInput>
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
    {VALID_DAY_NAMES.map((day) => (
      <CheckboxLabel
        checked={value?.includes(day) ?? false}
        label={day}
        name={inputName(field)}
        value={day}
      />
    ))}
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
  return flashAdminPage(t("listing_defaults.title"), "/admin/listing-defaults")(
    session,
    error,
    success,
  )(
    <>
      <CsrfForm action="/admin/listing-defaults" id="listing-defaults">
        <div class="prose">
          <h2>{t("listing_defaults.title")}</h2>
          <p>{t("listing_defaults.intro")}</p>
        </div>
        {fields.map((field) => (
          <DefaultControl defaults={defaults} field={field} />
        ))}
        <SubmitButton icon="save">{t("listing_defaults.save")}</SubmitButton>
      </CsrfForm>

      <GuideFooter href="/admin/guide#listings">
        {t("listing_defaults.guide_link")}
      </GuideFooter>
    </>,
  );
};
