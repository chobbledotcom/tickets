/* jscpd:ignore-start */
import { t } from "#i18n";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormRenderValuesFor } from "#shared/forms/definition.ts";
import type { FieldValues } from "#shared/forms/values.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import type { AdminSession, Group, ListingWithCount } from "#shared/types.ts";
import { ListingGroupSelect } from "#templates/admin/group-select.tsx";
import {
  type FormSection,
  FormSections,
  StackDetails,
} from "#templates/components/aggregate-sections.tsx";
import {
  getListingEditForm,
  getListingForm,
  type ListingFormView,
} from "#templates/fields/listing.ts";
import {
  renderDayPricesFieldset,
  showUseDefaultsToggle,
} from "./form-values.tsx";

/* jscpd:ignore-end */

type ListingFieldsOptions = { includeSlug?: boolean; nameAutofocus?: boolean };

const ALL_BOOKABLE_DAYS = VALID_DAY_NAMES.join(",");

type ListingRenderValues = FormRenderValuesFor<
  ReturnType<typeof getListingForm>["fields"]
>;

export const TEMPLATE_SEEDS: Record<string, ListingRenderValues> = {
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

type ListingSectionId = ReturnType<typeof getListingForm>["sections"][number];
type ListingSectionRenderer = (
  id: ListingSectionId,
  values: FieldValues,
) => string;

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
  renderSection,
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
  renderSection: ListingSectionRenderer;
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
  const sectionFields = (id: ListingSectionId): string =>
    renderSection(id, values);
  // A section body that opens with the child note, then the given fields, then
  // any extra content after them.
  const childNoteFields = (
    id: ListingSectionId,
    after?: JSX.Element,
  ): JSX.Element => (
    <>
      <ChildNote note={childOfNote} />
      <Raw html={sectionFields(id)} />
      {after}
    </>
  );
  const sections: FormSection[] = [
    {
      children: (
        <>
          <Raw html={sectionFields("basics")} />
          <ListingGroupSelect
            groups={groups}
            selectedGroupIds={selectedGroupIds}
          />
        </>
      ),
      legend: t("listings_table.basics"),
    },
    {
      children: <Raw html={sectionFields("tickets")} />,
      legend: t("listings_table.tickets_pricing"),
    },
    {
      children: childNoteFields("daily"),
      className: "listing-section listing-section--daily",
      legend: t("listings_table.daily_scheduling"),
    },
    {
      children: childNoteFields(
        "duration",
        <>
          {durationWarning && <Raw html={durationWarning} />}
          <Raw html={sectionFields("customisable")} />
          <Raw html={renderDayPricesFieldset(dayPricesListing)} />
        </>,
      ),
      legend: t("listings_table.booking_duration_day_prices"),
    },
    {
      children: <Raw html={sectionFields("options")} />,
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

      <FormSections sections={sections} />

      <StackDetails
        className="listing-advanced"
        open={advancedOpen}
        summary={t("listings_table.advanced_settings")}
      >
        <Raw html={sectionFields("advanced")} />
      </StackDetails>
    </>
  );
};

type ListingFormPageProps = Omit<
  Parameters<typeof ListingFormSections>[0],
  | "groups"
  | "isTemplated"
  | "renderSection"
  | "selectedGroupIds"
  | "showUseDefaults"
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
  const view: ListingFormView = {
    builder: isBuilderEnabled(),
    logistics: settings.features.logistics,
    ...(fields.nameAutofocus ? { nameAutofocus: true } : {}),
    storage: isStorageEnabled(),
    webhook: session.adminLevel !== "editor",
  };
  const renderSection: ListingSectionRenderer = fields.includeSlug
    ? (id, values) => getListingEditForm(view).section(id, values)
    : (id, values) => getListingForm(view).section(id, values);
  return {
    defaults,
    formSections: (props) => (
      <ListingFormSections
        {...props}
        groups={groups}
        isTemplated={isTemplated}
        renderSection={renderSection}
        selectedGroupIds={selectedGroupIds}
        showUseDefaults={showUseDefaults}
      />
    ),
    showUseDefaults,
  };
};
