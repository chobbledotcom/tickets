import { settings } from "#db/settings.ts";
import { compact } from "#fp";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import type { FormRenderValuesFor } from "#shared/forms/definition.ts";
import type { FieldValues } from "#shared/forms/values.ts";
import type { ImagePickerOption } from "#shared/images/picker.ts";
import { showUseDefaultsToggle } from "#shared/listing-defaults.ts";
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
  listingFormView,
} from "#templates/fields/listing.ts";
import type { AdminSession, Group, ListingWithCount } from "#types";
import { renderDayPricesFieldset } from "./form-values.tsx";
import { ListingImagesField } from "./listing-images.tsx";

type ListingFieldsOptions = { includeSlug?: boolean; nameAutofocus?: boolean };

const ALL_BOOKABLE_DAYS = VALID_DAY_NAMES.join(",");

type ListingRenderValues = FormRenderValuesFor<
  ReturnType<typeof getListingForm>["fields"]
>;

/** A purchase-only, non-dated product seed: the buyer pays, nothing is
 *  checked in, and the form collects exactly the given contact fields. */
const purchaseSeed = (fields: string): ListingRenderValues => ({
  fields,
  listingType: "standard",
  purchaseOnly: "1",
  usesLogistics: "",
});

/** A checked-in seed booked on a day the buyer picks from the given days. */
const dailySeed = (bookableDays: string): ListingRenderValues => ({
  bookableDays,
  durationDays: "1",
  fields: "email",
  listingType: "daily",
  maximumDaysAfter: "90",
  minimumDaysBefore: "1",
  purchaseOnly: "",
  usesLogistics: "",
});

/* jscpd:ignore-start -- a list of strings, not code */
export const TEMPLATE_SEEDS: Record<string, ListingRenderValues> = {
  "day-pass": dailySeed(ALL_BOOKABLE_DAYS),
  donation: { ...purchaseSeed("email"), canPayMore: "1" },
  "hireable-item": {
    ...dailySeed(ALL_BOOKABLE_DAYS),
    fields: "email,phone,address",
    purchaseOnly: "1",
    usesLogistics: "1",
  },
  "one-off-event": {
    fields: "email",
    listingType: "standard",
    purchaseOnly: "",
    usesLogistics: "",
  },
  "online-digital": purchaseSeed("email"),
  "physical-product": purchaseSeed("email,address"),
  subscription: {
    fields: "email",
    listingType: "standard",
    purchaseOnly: "",
    recurringInterval: "month",
    usesLogistics: "",
  },
  // One day ticked, so the operator picks the day the class runs.
  "weekly-event": dailySeed(VALID_DAY_NAMES[0]),
};
/* jscpd:ignore-end */

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
  if (listing.thankYouUrl || listing.webhookUrl) return true;
  return (
    builderEnabled &&
    (listing.monthsPerUnit > 0 ||
      listing.initialSiteMonths > 0 ||
      listing.assignBuiltSite)
  );
};

export const DurationWarning = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => (
  <div
    data-duration-original={listing.durationDays}
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
  images,
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
  /** The chosen pictures, when this form offers the Images section. */
  images?: readonly ImagePickerOption[];
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
  const sections: FormSection[] = compact([
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
    images
      ? {
          children: <ListingImagesField selected={images} />,
          className: "listing-section listing-section--images",
          legend: t("listings_table.images"),
        }
      : null,
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
  ]);
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
                name="useDefaults"
                type="checkbox"
                value="1"
              />
              {t("listing_defaults.use_defaults_toggle")}{" "}
              <small>{t("listing_defaults.use_defaults_hint")}</small>
            </label>
          )}
        </fieldset>
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
  const view: ListingFormView = {
    ...listingFormView(session.adminLevel),
    ...(fields.nameAutofocus ? { nameAutofocus: true } : {}),
  };
  const showUseDefaults = showUseDefaultsToggle(view.closed, defaults);
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
