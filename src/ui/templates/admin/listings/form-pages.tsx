/* jscpd:ignore-start */
import { t } from "#i18n";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { settings } from "#shared/db/settings.ts";
import { CsrfForm, type FieldValues, Flash } from "#shared/forms.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { inferTemplate, LISTING_TEMPLATES } from "#shared/listing-templates.ts";
import type { AdminSession, Group, ListingWithCount } from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import type { ChildProps } from "#templates/components/child-props.ts";
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

/* jscpd:ignore-end */

const CreateListingFormBody = ({ children }: ChildProps): JSX.Element => (
  <>
    {children}
    <SubmitButton icon="plus">
      {t("listings_table.create_listing")}
    </SubmitButton>
  </>
);

/** The admin shell every "new listing" screen shares: the type picker and the
 * create form both sit on the `/admin/listing/new` tab under one title. */
const listingNewAdminPage = (
  session: AdminSession,
  title: string,
  body: Child,
): string =>
  String(
    <AdminPage active="/admin/listing/new" session={session} title={title}>
      {body}
    </AdminPage>,
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
  listingNewAdminPage(
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

export const adminListingPickerPage = (session: AdminSession): string =>
  listingNewAdminPage(
    session,
    t("listings_table.add_listing"),
    <>
      <h1>{t("listings_table.listing_type_picker_heading")}</h1>
      <p>{t("listings_table.listing_type_picker_subheading")}</p>
      <div class="listing-type-picker">
        {LISTING_TEMPLATES.filter(
          (tmpl) =>
            !tmpl.requiresLogistics || settings.enabledFeatures.logistics,
        ).map((tmpl) => (
          <a
            class="listing-type-card"
            href={`/admin/listing/new?template=${tmpl.id}`}
          >
            <strong>{t(tmpl.label)}</strong>
            <span>{t(tmpl.description)}</span>
          </a>
        ))}
        {LISTING_TEMPLATES.some(
          (tmpl) =>
            tmpl.requiresLogistics && !settings.enabledFeatures.logistics,
        ) && (
          <div class="listing-type-card listing-type-card--disabled">
            <strong>{t("listings_table.template_hireable_item")}</strong>
            <span>{t("listings_table.template_requires_logistics")}</span>
          </div>
        )}
        <a class="listing-type-card" href="/admin/listing/new?template=custom">
          <strong>{t("listings_table.listing_type_picker_custom")}</strong>
          <span>
            {t("listings_table.listing_type_picker_custom_description")}
          </span>
        </a>
        <a class="listing-type-card" href="/admin/catalog/import">
          <strong>{t("catalog_transfer.import_button")}</strong>
          <span>
            {t("listings_table.listing_type_picker_import_description")}
          </span>
        </a>
      </div>
    </>,
  );

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
