/* jscpd:ignore-start */
import { map, mapNotNullish, pipe } from "#fp";
import { t } from "#i18n";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { settings } from "#shared/db/settings.ts";
import { type Field, type FieldValues, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import type { AdminSession, Group, ListingWithCount } from "#shared/types.ts";
import { ListingGroupSelect } from "#templates/admin/group-select.tsx";
import {
  StackDetails,
  StackFieldset,
} from "#templates/components/aggregate-sections.tsx";
import {
  getAssignBuiltSiteField,
  getAttachmentField,
  getInitialSiteMonthsField,
  getListingFields,
  getMonthsPerUnitField,
  getSlugField,
  logisticsField,
  VALID_DAY_NAMES,
} from "#templates/fields.ts";
import {
  renderDayPricesFieldset,
  showUseDefaultsToggle,
} from "./form-values.tsx";

/* jscpd:ignore-end */

const fieldsWithNameFocus = (): Field[] =>
  pipe(
    map(
      (field: Field): Field =>
        field.name === "name" ? { ...field, autofocus: true } : field,
    ),
  )(getListingFields());

const fieldsForRole = (session: AdminSession, fields: Field[]): Field[] =>
  session.adminLevel === "editor"
    ? fields.filter((field) => field.name !== "webhook_url")
    : fields;

type ListingFieldsOptions = { includeSlug?: boolean; nameAutofocus?: boolean };

export const listingFieldsFor = (
  session: AdminSession,
  opts: ListingFieldsOptions = {},
): Field[] => [
  ...fieldsForRole(
    session,
    opts.nameAutofocus ? fieldsWithNameFocus() : getListingFields(),
  ),
  ...(settings.hasLogistics ? [logisticsField] : []),
  ...(isBuilderEnabled()
    ? [
        getMonthsPerUnitField(),
        getInitialSiteMonthsField(),
        getAssignBuiltSiteField(),
      ]
    : []),
  ...(isStorageEnabled() ? [getAttachmentField()] : []),
  ...(opts.includeSlug ? [getSlugField()] : []),
];

const ALL_BOOKABLE_DAYS = VALID_DAY_NAMES.join(",");

export const TEMPLATE_SEEDS: Record<string, FieldValues> = {
  "hireable-item": {
    bookable_days: ALL_BOOKABLE_DAYS,
    duration_days: "1",
    fields: "email,phone,address",
    listing_type: "daily",
    maximum_days_after: "90",
    minimum_days_before: "1",
    purchase_only: "1",
    uses_logistics: "1",
  },
  "one-off-event": {
    fields: "email",
    listing_type: "standard",
    purchase_only: "",
    uses_logistics: "",
  },
  "online-digital": {
    fields: "email",
    listing_type: "standard",
    purchase_only: "1",
    uses_logistics: "",
  },
  "weekly-event": {
    bookable_days: ALL_BOOKABLE_DAYS,
    duration_days: "1",
    fields: "email",
    listing_type: "daily",
    maximum_days_after: "90",
    minimum_days_before: "1",
    purchase_only: "",
    uses_logistics: "",
  },
};

const BASICS_FIELDS = [
  "name",
  "listing_type",
  "description",
  "date",
  "location",
  "attachment",
] as const;

const TICKET_FIELDS = [
  "max_attendees",
  "max_quantity",
  "closes_at",
  "unit_price",
  "can_pay_more",
  "max_price",
] as const;

const DAILY_FIELDS = [
  "bookable_days",
  "minimum_days_before",
  "maximum_days_after",
] as const;

const OPTION_FIELDS = [
  "fields",
  "non_transferable",
  "purchase_only",
  "bookable_alone",
  "uses_logistics",
  "hidden",
] as const;

const ADVANCED_FIELDS = [
  "thank_you_url",
  "webhook_url",
  "months_per_unit",
  "initial_site_months",
  "assign_built_site",
  "slug",
] as const;

const ChildNote = ({ note }: { note: string }): JSX.Element | null =>
  note ? <p class="muted small">{note}</p> : null;

export const advancedSectionHasValues = (
  listing: ListingWithCount,
  builderEnabled: boolean,
): boolean => {
  if (listing.thank_you_url || listing.webhook_url) return true;
  return (
    builderEnabled &&
    (listing.months_per_unit > 0 ||
      listing.initial_site_months > 0 ||
      listing.assign_built_site)
  );
};

export const DurationWarning = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => (
  <div
    data-duration-original={listing.duration_days}
    hidden
    id="duration-warning"
  >
    <p>
      <strong>{t("listings_table.warning")}:</strong>{" "}
      {t("listings_table.duration_warning_message")}
    </p>
    <label>
      <input id="duration-warning-confirm" type="checkbox" />
      {t("listings_table.i_understand")}
    </label>
  </div>
);

export const ListingFormSections = ({
  fields,
  values,
  groups,
  selectedGroupIds,
  dayPricesListing,
  durationWarning,
  advancedOpen,
  childOfNote = "",
  customiseOpen,
  isTemplated,
  showUseDefaults = false,
  useDefaultsChecked = false,
}: {
  fields: Field[];
  values: FieldValues;
  groups: Group[];
  selectedGroupIds: number[];
  dayPricesListing?: ListingWithCount;
  durationWarning: string;
  advancedOpen: boolean;
  childOfNote?: string;
  customiseOpen: boolean;
  isTemplated: boolean;
  showUseDefaults?: boolean;
  useDefaultsChecked?: boolean;
}): JSX.Element => {
  const fieldMap = new Map<string, Field>(
    fields.map((field) => [field.name, field]),
  );
  const sectionFields = (names: readonly string[]): string =>
    renderFields(
      mapNotNullish((name: string) => fieldMap.get(name))(names),
      values,
    );
  const sections = [
    {
      children: (
        <>
          <Raw html={sectionFields(BASICS_FIELDS)} />
          <ListingGroupSelect
            groups={groups}
            selectedGroupIds={selectedGroupIds}
          />
        </>
      ),
      legend: t("listings_table.basics"),
    },
    {
      children: <Raw html={sectionFields(TICKET_FIELDS)} />,
      legend: t("listings_table.tickets_pricing"),
    },
    {
      children: (
        <>
          <ChildNote note={childOfNote} />
          <Raw html={sectionFields(DAILY_FIELDS)} />
        </>
      ),
      className: "listing-section listing-section--daily",
      legend: t("listings_table.daily_scheduling"),
    },
    {
      children: (
        <>
          <ChildNote note={childOfNote} />
          <Raw html={sectionFields(["duration_days"])} />
          {durationWarning && <Raw html={durationWarning} />}
          <Raw html={sectionFields(["customisable_days"])} />
          <Raw html={renderDayPricesFieldset(dayPricesListing)} />
        </>
      ),
      legend: t("listings_table.booking_duration_day_prices"),
    },
    {
      children: <Raw html={sectionFields(OPTION_FIELDS)} />,
      legend: t("listings_table.options_visibility"),
    },
  ];
  return (
    <>
      {(isTemplated || showUseDefaults) && (
        <fieldset class="checkboxes">
          {isTemplated && (
            <label>
              <input
                checked={customiseOpen}
                id="customise-listing"
                name="customise"
                type="checkbox"
                value="1"
              />
              {t("listings_table.customise")}{" "}
              <small>{t("listings_table.customise_hint")}</small>
            </label>
          )}
          {showUseDefaults && (
            <label>
              <input
                checked={useDefaultsChecked}
                id="use-defaults"
                name="use_defaults"
                type="checkbox"
                value="1"
              />
              {t("listing_defaults.use_defaults_toggle")}{" "}
              <small>{t("listing_defaults.use_defaults_hint")}</small>
            </label>
          )}
        </fieldset>
      )}

      {!showUseDefaults && useDefaultsChecked && (
        <input name="use_defaults" type="hidden" value="1" />
      )}

      {sections.map(({ children, className, legend }) => (
        <StackFieldset
          className={className ?? "listing-section"}
          legend={legend}
        >
          {children}
        </StackFieldset>
      ))}

      <StackDetails
        className="listing-advanced"
        open={advancedOpen}
        summary={t("listings_table.advanced_settings")}
      >
        <Raw html={sectionFields(ADVANCED_FIELDS)} />
      </StackDetails>
    </>
  );
};

type ListingFormPageProps = Omit<
  Parameters<typeof ListingFormSections>[0],
  "fields" | "groups" | "isTemplated" | "selectedGroupIds" | "showUseDefaults"
>;

export const listingFormPageState = (
  session: AdminSession,
  groups: Group[],
  selectedGroupIds: number[],
  isTemplated: boolean,
  fields: ListingFieldsOptions = {},
): {
  defaults: typeof settings.listingDefaults;
  formSections: (props: ListingFormPageProps) => JSX.Element;
  showUseDefaults: boolean;
} => {
  const defaults = settings.listingDefaults;
  const showUseDefaults = showUseDefaultsToggle(session, defaults);
  const formFields = listingFieldsFor(session, fields);
  return {
    defaults,
    formSections: (props) => (
      <ListingFormSections
        {...props}
        fields={formFields}
        groups={groups}
        isTemplated={isTemplated}
        selectedGroupIds={selectedGroupIds}
        showUseDefaults={showUseDefaults}
      />
    ),
    showUseDefaults,
  };
};
