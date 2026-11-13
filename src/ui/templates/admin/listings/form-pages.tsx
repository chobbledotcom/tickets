import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import { isBuilderEnabled } from "#shared/config.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { Flash } from "#shared/forms/flash.tsx";
import type { FieldValues } from "#shared/forms/values.ts";
import {
  inferTemplate,
  LISTING_TEMPLATES,
  type ListingTemplate,
  type TemplateId,
} from "#shared/listing-templates.ts";
import { renderAdminPage } from "#templates/admin/admin-page.tsx";
import {
  Icon,
  type PickerIconName,
  SubmitButton,
} from "#templates/components/actions.tsx";
import type { ChildProps } from "#templates/components/child-props.ts";
import { ProseIntro } from "#templates/components/prose-intro.tsx";
import type { AdminSession, Group, ListingWithCount } from "#types";
import {
  advancedSectionHasValues,
  listingFormPageState,
  TEMPLATE_SEEDS,
} from "./form-sections.tsx";
import {
  defaultsToFieldValues,
  listingFormClassAttr,
  listingToFieldValues,
} from "./form-values.tsx";

const CreateListingFormBody = ({ children }: ChildProps): JSX.Element => (
  <>
    {children}
    <SubmitButton icon="plus">
      {t("listings_table.create_listing")}
    </SubmitButton>
  </>
);

const createListingFormPage = ({
  beforeForm,
  children,
  defaults,
  session,
  template,
  title,
}: {
  beforeForm?: Child;
  children: Child;
  defaults: typeof settings.listingDefaults;
  session: AdminSession;
  template: ReturnType<typeof inferTemplate>;
  title: string;
}): string =>
  renderAdminPage(
    "/admin/listing/new",
    session,
    title,
    <>
      {beforeForm}
      <CsrfForm
        action="/admin/listing"
        {...listingFormClassAttr(template, defaults)}
        enctype="multipart/form-data"
      >
        {children}
      </CsrfForm>
    </>,
  );

const createListingPageFromForm = (
  form: ReturnType<typeof listingFormPageState>,
  session: AdminSession,
  template: ReturnType<typeof inferTemplate>,
  title: string,
  children: Child,
  beforeForm?: Child,
): string =>
  createListingFormPage({
    ...(beforeForm ? { beforeForm } : {}),
    children,
    defaults: form.defaults,
    session,
    template,
    title,
  });

/** One picker card. A disabled card renders as a non-link div — the feature
 *  it needs is off, so the operator learns it exists but cannot open it. */
type PickerCard = {
  description: string;
  disabled?: boolean;
  href: string;
  icon: PickerIconName;
  label: string;
};

/** Each card's icon, keyed by the template it stands for. The custom card
 *  has no template, so it carries its own. */
const PICKER_ICONS: Record<TemplateId, PickerIconName> = {
  "hireable-item": "key-round",
  "one-off-event": "party-popper",
  "online-digital": "ticket",
  "physical-product": "package",
  "weekly-event": "calendar-check",
};

const pickerCard = (
  href: string,
  labelKey: string,
  descriptionKey: string,
  icon: PickerIconName,
  disabled = false,
): PickerCard => ({
  description: t(descriptionKey),
  disabled,
  href,
  icon,
  label: t(labelKey),
});

const listingTypeCard = (card: PickerCard): Child => {
  const classes = [
    "listing-type-card",
    card.disabled ? "listing-type-card--disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <a
      aria-disabled={card.disabled || undefined}
      class={classes}
      href={card.disabled ? undefined : card.href}
    >
      <span class="listing-type-card-icon">
        <Icon name={card.icon} />
      </span>
      <strong>{card.label}</strong>
      <span>{card.description}</span>
    </a>
  );
};

const templateCard = (tmpl: ListingTemplate): PickerCard =>
  pickerCard(
    `/admin/listing/new?template=${tmpl.id}`,
    tmpl.label,
    tmpl.description,
    PICKER_ICONS[tmpl.id],
  );

export const adminListingPickerPage = (session: AdminSession): string => {
  // The hireable card needs the logistics agents feature. Without it the
  // picker shows it as a disabled card so the operator learns it exists.
  const hireableCardHidden = LISTING_TEMPLATES.some(
    (tmpl) => tmpl.requiresLogistics && !settings.features.logistics,
  );
  const hireableTemplates = settings.features.logistics
    ? LISTING_TEMPLATES.filter((tmpl) => tmpl.requiresLogistics)
    : [];
  const cards: PickerCard[] = [
    // The card order is the storefront-first order an ecommerce operator
    // reads: what they sell, then how it is booked. It is deliberately
    // independent of LISTING_TEMPLATES order, which pins inference
    // precedence (online-digital must stay first for the shared
    // purchase-only signature).
    ...["physical-product", "online-digital", "one-off-event", "weekly-event"]
      .flatMap((id) => LISTING_TEMPLATES.filter((tmpl) => tmpl.id === id))
      .map(templateCard),
    ...(hireableCardHidden
      ? [
          pickerCard(
            "",
            "listings_table.template_hireable_item",
            "listings_table.template_requires_logistics",
            PICKER_ICONS["hireable-item"],
            true,
          ),
        ]
      : []),
    ...hireableTemplates.map(templateCard),
    pickerCard(
      "/admin/listing/new?template=custom",
      "listings_table.listing_type_picker_custom",
      "listings_table.listing_type_picker_custom_description",
      "sliders-horizontal",
    ),
  ];
  return renderAdminPage(
    "/admin/listing/new",
    session,
    t("listings_table.add_listing"),
    <>
      <ProseIntro
        heading={t("listings_table.listing_type_picker_heading")}
        headingTag="h1"
        intro={
          <>
            {t("listings_table.listing_type_picker_subheading")}{" "}
            {t("listings_table.listing_type_picker_import_prefix")}{" "}
            <a href="/admin/catalog/import">
              {t("listings_table.listing_type_picker_import_link")}
            </a>
          </>
        }
      />
      <div class="listing-type-picker">
        {cards.map((card) => listingTypeCard(card))}
      </div>
    </>,
  );
};

export const adminListingNewPage = (
  groups: Group[],
  session: AdminSession,
  opts?: {
    customiseOpen?: boolean;
    error?: string;
    templateId?: string | null;
    values?: FieldValues;
    selectedGroupIds?: number[];
  },
): string => {
  const {
    error,
    templateId,
    customiseOpen = false,
    values: submitted,
    selectedGroupIds = [],
  } = opts ?? {};
  const template =
    LISTING_TEMPLATES.find((tmpl) => tmpl.id === templateId) ?? null;
  const seeds = templateId ? (TEMPLATE_SEEDS[templateId] ?? {}) : {};
  const form = listingFormPageState(
    session,
    groups,
    selectedGroupIds,
    !!template,
  );
  const useDefaultsChecked = submitted
    ? submitted.use_defaults === "1"
    : form.showUseDefaults && !template;
  const newValues = submitted
    ? submitted
    : template
      ? seeds
      : { ...seeds, ...defaultsToFieldValues(form.defaults) };
  return createListingPageFromForm(
    form,
    session,
    template,
    t("listings_table.add_listing"),
    <>
      <h1>{t("listings_table.add_listing")}</h1>
      <Flash error={error} />
      {templateId && (
        <input name="template_id" type="hidden" value={templateId} />
      )}
      {!!submitted?.duplicated_from && (
        <input
          name="duplicated_from"
          type="hidden"
          value={String(submitted.duplicated_from)}
        />
      )}
      <CreateListingFormBody>
        {form.formSections({
          advancedOpen: !!error,
          customiseOpen,
          durationWarning: "",
          useDefaultsChecked,
          values: newValues,
        })}
      </CreateListingFormBody>
    </>,
  );
};

export const adminDuplicateListingPage = (
  listing: ListingWithCount,
  groups: Group[],
  session: AdminSession,
  selectedGroupIds: number[] = [],
): string => {
  const values = listingToFieldValues(listing);
  values.name = "";
  const builderEnabled = isBuilderEnabled();
  const template = inferTemplate(listing);
  const form = listingFormPageState(
    session,
    groups,
    selectedGroupIds,
    !!template,
    { nameAutofocus: true },
  );
  return createListingPageFromForm(
    form,
    session,
    template,
    t("listings_table.duplicate_listing_title", {
      name: listing.name,
    }),
    <>
      <input name="duplicated_from" type="hidden" value={String(listing.id)} />
      <CreateListingFormBody>
        {form.formSections({
          advancedOpen: advancedSectionHasValues(listing, builderEnabled),
          customiseOpen: false,
          dayPricesListing: listing,
          durationWarning: "",
          useDefaultsChecked: listing.use_defaults,
          values,
        })}
      </CreateListingFormBody>
    </>,
    <div class="prose">
      <h2>{t("listings_table.duplicate_listing")}</h2>
      <p>
        {t("listings_table.creating_new_listing_based_on", {
          name: listing.name,
        })}
      </p>
    </div>,
  );
};
