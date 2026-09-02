/**
 * Listing Defaults settings page.
 *
 * One control per defaultable field, driven by {@link LISTING_DEFAULT_FIELDS}.
 * A field left at "No default" is omitted from the saved blob, so listings keep
 * deciding it themselves; any other value becomes the inherited default.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import {
  listingDefaultInputName as inputName,
  LISTING_DEFAULT_FIELDS,
  type ListingDefaultField,
  type ListingDefaultKind,
  type ListingDefaults,
  listingDefaultHintKey,
  listingDefaultLabelKey,
} from "#shared/listing-defaults.ts";
import { flashAdminPage } from "#templates/admin/admin-page.tsx";
import { ListingSectionFieldset } from "#templates/admin/money-summary.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { CheckboxLabel } from "#templates/components/aggregate-sections.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { SelectField } from "#templates/components/select-field.tsx";
import type { AdminSession } from "#types";

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

/** Number input; blank means no default. */
/** A single `<input>` control wrapped in a {@link LabeledInput}: the shared
 *  shape of the number and URL default fields. */
const InputControl = ({
  field,
  type,
  value,
  min,
  placeholder,
}: {
  field: ListingDefaultField;
  type: string;
  value: string;
  min?: number;
  placeholder?: string;
}): JSX.Element => (
  <LabeledInput field={field}>
    <input
      name={inputName(field)}
      type={type}
      value={value}
      {...(min !== undefined ? { min } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
    />
  </LabeledInput>
);

const NumberControl = ({
  field,
  value,
}: {
  field: ListingDefaultField;
  value: number | undefined;
}): JSX.Element =>
  InputControl({
    field,
    min: 0,
    type: "number",
    value: value === undefined ? "" : String(value),
  });

/** URL input; blank means no default. */
const UrlControl = ({
  field,
  value,
}: {
  field: ListingDefaultField;
  value: string | undefined;
}): JSX.Element =>
  InputControl({
    field,
    placeholder: t("listing_defaults.url_placeholder"),
    type: "url",
    value: value ?? "",
  });

/** Enable toggle plus the day checkboxes. */
const DaysControl = ({
  field,
  value,
}: {
  field: ListingDefaultField;
  value: string[] | undefined;
}): JSX.Element => (
  <ListingSectionFieldset legend={labelFor(field)}>
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
  </ListingSectionFieldset>
);

/**
 * Hands one kind's stored value to the control that draws it. The map below
 * holds every kind at once, so its value type is every kind's value at once;
 * each control says which one it reads.
 */
const controlFor =
  <TValue,>(
    Control: (props: {
      field: ListingDefaultField;
      value: TValue;
    }) => JSX.Element,
  ) =>
  (
    field: ListingDefaultField,
    value: ListingDefaults[keyof ListingDefaults],
  ): JSX.Element =>
    Control({ field, value: value as TValue });

/** Per-kind control. Keyed by {@link ListingDefaultKind} so a new kind is a
 * compile error here, matching the parser and listing-form formatter. */
const KIND_CONTROLS: Record<
  ListingDefaultKind,
  (
    field: ListingDefaultField,
    value: ListingDefaults[keyof ListingDefaults],
  ) => JSX.Element
> = {
  // Tri-state select: no default / yes / no.
  bool: (field, value) => (
    <LabeledInput field={field}>
      <SelectField
        name={inputName(field)}
        options={[
          { label: t("listing_defaults.no_default"), value: "" },
          { label: t("listing_defaults.bool_yes"), value: "1" },
          { label: t("listing_defaults.bool_no"), value: "0" },
        ]}
        value={value === true ? "1" : value === false ? "0" : ""}
      />
    </LabeledInput>
  ),
  days: controlFor(DaysControl),
  number: controlFor(NumberControl),
  url: controlFor(UrlControl),
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
      <SaveForm
        action="/admin/listing-defaults"
        id="listing-defaults"
        submitLabel={t("listing_defaults.save")}
      >
        <div class="prose">
          <h2>{t("listing_defaults.title")}</h2>
          <p>{t("listing_defaults.intro")}</p>
        </div>
        {fields.map((field) => (
          <DefaultControl defaults={defaults} field={field} />
        ))}
      </SaveForm>

      <GuideFooter href="/admin/guide#listings">
        {t("listing_defaults.guide_link")}
      </GuideFooter>
    </>,
  );
};
