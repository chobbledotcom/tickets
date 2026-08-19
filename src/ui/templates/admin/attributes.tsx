/* jscpd:ignore-start */

import type { AttributeOption, AttributeWithOptions } from "#db/attributes.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import type { AttributeListingRow } from "#routes/admin/attribute-page-data.ts";
import {
  attributeNameForm,
  attributeOptionForm,
} from "#routes/admin/attributes.ts";
import { adminPath } from "#shared/admin-surface.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { errorAdminPage } from "#templates/admin/admin-page.tsx";
import { childEditPage } from "#templates/admin/child-edit-page.tsx";
import { warningDeletePage } from "#templates/admin/confirm-page.tsx";
import { BackButton, SubmitButton } from "#templates/components/actions.tsx";
import {
  FormSections,
  IdCheckboxLabel,
} from "#templates/components/aggregate-sections.tsx";
import {
  itemsOrEmptyNote,
  reorderableListPage,
  reorderCountTable,
} from "#templates/components/reorder-list.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableHeader } from "#templates/components/translated-table-column.ts";
import type { AdminSession } from "#types";
import {
  type ListingPanelProps,
  listingChoicePanel,
} from "./listing-panel-frame.tsx";
import { WritableDangerLink, WritableOnly } from "./writable-only.tsx";
/* jscpd:ignore-end */

export const attributeNameFlat = (name: string): string =>
  name.replace(/\r?\n/g, " / ");

const AttributeListingLink = ({
  listing,
}: {
  listing: AttributeListingRow;
}): JSX.Element => (
  <a
    class={listing.active ? undefined : "muted"}
    href={`/admin/listing/${listing.id}`}
  >
    {listing.name}
  </a>
);

const attributeListingColumns: readonly TableColumn<AttributeListingRow>[] = [
  {
    cell: (listing) => <AttributeListingLink listing={listing} />,
    header: translatedTableHeader("terms.listing"),
    key: "listing",
  },
  {
    cell: (listing) => listing.optionTexts.join(", "),
    header: translatedTableHeader("attributes.options_column"),
    key: "options",
  },
];

const attributeListingsTable = defineTable(attributeListingColumns);

export const adminAttributesPage = (
  attributes: AttributeWithOptions[],
  session: AdminSession,
  error?: string,
): string =>
  reorderableListPage({
    addFormHtml: attributeNameForm.render(),
    addLabel: t("attributes.add_submit"),
    basePath: "/admin/attributes",
    columns: [
      {
        cell: (attribute) => (
          <a href={`/admin/attributes/${attribute.id}`}>
            {attributeNameFlat(attribute.name)}
          </a>
        ),
        header: t("attributes.attribute_column"),
        key: "attribute",
      },
      {
        cell: (attribute) => attribute.options.length,
        class: "quantity",
        header: t("attributes.options_column"),
        key: "options",
      },
    ],
    emptyText: t("attributes.none"),
    error,
    guideHref: "/admin/guide#listings",
    guideLabel: t("attributes.guide_link"),
    items: attributes,
    newFormId: "new-attribute",
    orderLabel: t("attributes.order_column"),
    session,
    title: t("attributes.title"),
  });

/** The listings that use an attribute (or one of its options), each linking to
 * the listing's admin page. Deactivated listings render muted, like the item
 * pickers. The options column (which of the attribute's options each listing
 * selected) only makes sense at attribute level, so it is opt-in. */
const AttributeListingsTable = ({
  listings,
  emptyText,
  showOptions,
}: {
  listings: AttributeListingRow[];
  emptyText: string;
  showOptions: boolean;
}): JSX.Element =>
  itemsOrEmptyNote(listings, <em>{emptyText}</em>, (rows) =>
    renderTable(attributeListingsTable, rows, {
      columnKeys: showOptions ? ["listing", "options"] : ["listing"],
    }),
  );

/** The data the attribute detail page shows beyond the attribute itself: how
 * many listings use each option, and which listings use the attribute. */
export type AttributePageData = {
  listingCounts: Map<number, number>;
  listings: AttributeListingRow[];
};

export const adminAttributePage = (
  attribute: AttributeWithOptions,
  session: AdminSession,
  error: string | undefined,
  data: AttributePageData,
): string =>
  errorAdminPage(
    t("attributes.detail_title", { name: attributeNameFlat(attribute.name) }),
    "/admin/attributes",
  )(
    session,
    error,
  )(
    <>
      <h1>{attributeNameFlat(attribute.name)}</h1>

      <WritableOnly>
        <SaveForm
          action={`/admin/attributes/${attribute.id}/edit`}
          submitLabel={t("attributes.update")}
        >
          <Raw html={attributeNameForm.render({ name: attribute.name })} />
        </SaveForm>
      </WritableOnly>

      <h2>{t("attributes.options_heading")}</h2>
      <WritableOnly>
        <SaveForm
          action={`/admin/attributes/${attribute.id}/options`}
          id="new-attribute-option"
          submitIcon="plus"
          submitLabel={t("attributes.add_option")}
        >
          <Raw html={attributeOptionForm.render()} />
        </SaveForm>
      </WritableOnly>

      {reorderCountTable({
        count: (option) => data.listingCounts.get(option.id) ?? 0,
        countHeader: t("attributes.listings_column"),
        editHref: (option) =>
          adminPath("attributeOptionEdit", {
            id: attribute.id,
            optionId: option.id,
          }),
        emptyText: t("attributes.no_options"),
        items: attribute.options,
        label: (option) => option.text,
        labelHeader: t("attributes.option_column"),
        moveAction: (option) => (direction) =>
          `/admin/attributes/${attribute.id}/options/${option.id}/move-${direction}`,
        orderLabel: t("attributes.order_column"),
      })}

      <h2>{t("attributes.listings.heading")}</h2>
      <AttributeListingsTable
        emptyText={t("attributes.listings.none")}
        listings={data.listings}
        showOptions={true}
      />

      <WritableDangerLink
        href={adminPath("attributeDelete", { id: attribute.id })}
      >
        {t("attributes.delete.link")}
      </WritableDangerLink>
    </>,
  );

/** Option edit page: a back link to the attribute, the editable option text,
 * the listings that have this option set, and the delete action. Ordering
 * still lives on the attribute page. */
export const adminAttributeOptionEditPage = (
  attribute: AttributeWithOptions,
  option: AttributeOption,
  session: AdminSession,
  error: string | undefined,
  listings: AttributeListingRow[],
): string =>
  childEditPage({
    active: "/admin/attributes",
    backHref: `/admin/attributes/${attribute.id}`,
    backLabel: t("attributes.edit_option.back_to_attribute"),
    context: t("attributes.edit_option.attribute_context", {
      name: attributeNameFlat(attribute.name),
    }),
    formAction: `/admin/attributes/${attribute.id}/options/${option.id}/edit`,
    heading: t("attributes.edit_option.heading"),
    title: t("attributes.edit_option.title"),
  })(
    session,
    error,
    <>
      <Raw html={attributeOptionForm.render({ text: option.text })} />
      <SubmitButton icon="save">
        {t("attributes.edit_option.save")}
      </SubmitButton>
    </>,
    <>
      <h2>{t("attributes.edit_option.listings_heading")}</h2>
      <p>
        <small>
          {t("attributes.edit_option.listings_count", {
            count: listings.length,
          })}
        </small>
      </p>
      <AttributeListingsTable
        emptyText={t("attributes.edit_option.listings_none")}
        listings={listings}
        showOptions={false}
      />

      <p>
        <a
          class="danger"
          href={`/admin/attributes/${attribute.id}/options/${option.id}/delete`}
        >
          {t("attributes.delete_option.link")}
        </a>
      </p>
    </>,
  );

/** The warning-led delete page on the attributes nav. */
const attributeDeletePage = warningDeletePage("/admin/attributes");

export const adminAttributeDeletePage = (
  attribute: AttributeWithOptions,
  session: AdminSession,
  error?: string | undefined,
): string => {
  const name = attributeNameFlat(attribute.name);
  return attributeDeletePage(
    {
      action: `/admin/attributes/${attribute.id}/delete`,
      buttonText: t("attributes.delete.submit"),
      heading: t("attributes.delete.heading"),
      label: t("attributes.delete.confirm_label"),
      name,
      prompt: {
        args: { name },
        key: "attributes.delete.confirm_prompt",
      },
      warning: <p>{t("attributes.delete.warning")}</p>,
    },
    session,
    error,
  );
};

export const adminAttributeOptionDeletePage = (
  attribute: AttributeWithOptions,
  option: AttributeOption,
  session: AdminSession,
  error?: string | undefined,
): string =>
  attributeDeletePage(
    {
      action: `/admin/attributes/${attribute.id}/options/${option.id}/delete`,
      buttonText: t("attributes.delete_option.submit"),
      heading: t("attributes.delete_option.heading"),
      label: t("attributes.delete_option.confirm_label"),
      name: option.text,
      prompt: {
        args: { text: option.text },
        key: "attributes.delete_option.confirm_prompt",
      },
      warning: (
        <p>
          {t("attributes.delete_option.warning", {
            attribute: attributeNameFlat(attribute.name),
            option: option.text,
          })}
        </p>
      ),
    },
    session,
    error,
  );

type ListingAttributesPanelProps = ListingPanelProps & {
  attributes: AttributeWithOptions[];
  selectedOptionIds: Set<number>;
};

export const ListingAttributesPanel = (
  props: ListingAttributesPanelProps,
): JSX.Element => {
  const { attributes, listing, selectedOptionIds } = props;
  return listingChoicePanel(
    t("attributes.listing.heading", { listing: listing.name }),
    <p>
      <BackButton href="/admin/attributes">
        {t("attributes.listing.manage")}
      </BackButton>
    </p>,
    attributes,
    () => (
      <p>
        {t("attributes.listing.none")}{" "}
        <a href="/admin/attributes">{t("attributes.listing.create_first")}</a>.
      </p>
    ),
    (availableAttributes) => (
      <SaveForm
        action={`/admin/listing/${listing.id}/attributes`}
        submitLabel={t("common.save")}
      >
        <FormSections
          sections={availableAttributes.map((attribute) => ({
            children:
              attribute.options.length === 0 ? (
                <p>
                  <em>{t("attributes.listing.no_options")}</em>
                </p>
              ) : (
                attribute.options.map((option) => (
                  <IdCheckboxLabel
                    checkedIds={selectedOptionIds}
                    id={option.id}
                    label={` ${option.text}`}
                    name="option_ids"
                  />
                ))
              ),
            // The row-based checkbox layout the logistics tab's user selector
            // uses, so an attribute's options flow as a wrapping row under its
            // legend instead of stacking one per line.
            className: "checkboxes listing-section",
            legend: attribute.name,
          }))}
        />
      </SaveForm>
    ),
  );
};
