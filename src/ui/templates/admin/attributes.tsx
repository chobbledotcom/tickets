/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import type { AttributeListingRow } from "#routes/admin/attribute-page-data.ts";
import {
  attributeNameForm,
  attributeOptionForm,
} from "#routes/admin/attributes.ts";
import type {
  AttributeOption,
  AttributeWithOptions,
} from "#shared/db/attributes.ts";
import { CsrfForm } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import { errorAdminPage } from "#templates/admin/admin-page.tsx";
import { childEditPage } from "#templates/admin/child-edit-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import {
  BackButton,
  GuideFooter,
  SubmitButton,
} from "#templates/components/actions.tsx";
import {
  FormSections,
  IdCheckboxLabel,
} from "#templates/components/aggregate-sections.tsx";
import { DataTable } from "#templates/components/data-table.tsx";
import {
  ReorderLinkRow,
  ReorderTable,
  reorderLinkTableAt,
} from "#templates/components/reorder-table.tsx";
import { colClass } from "#templates/components/table-columns.ts";
import {
  type ListingPanelProps,
  listingChoicePanel,
} from "./listing-panel-frame.tsx";
/* jscpd:ignore-end */

export const attributeNameFlat = (name: string): string =>
  name.replace(/\r?\n/g, " / ");

export const adminAttributesPage = (
  attributes: AttributeWithOptions[],
  session: AdminSession,
  error?: string,
): string =>
  errorAdminPage(t("attributes.title"), "/admin/attributes")(session, error)(
    <>
      <CsrfForm action="/admin/attributes" id="new-attribute">
        <Raw html={attributeNameForm.render()} />
        <SubmitButton icon="plus">{t("attributes.add_submit")}</SubmitButton>
      </CsrfForm>

      {attributes.length === 0 ? (
        <p>
          <em>{t("attributes.none")}</em>
        </p>
      ) : (
        reorderLinkTableAt(
          "/admin/attributes",
          t("attributes.order_column"),
          <>
            <th>{t("attributes.attribute_column")}</th>
            <th class={colClass("quantity")}>
              {t("attributes.options_column")}
            </th>
          </>,
          attributes,
          (attribute) => attributeNameFlat(attribute.name),
          (attribute) => (
            <td class={colClass("quantity")}>{attribute.options.length}</td>
          ),
        )
      )}

      <GuideFooter href="/admin/guide#listings">
        {t("attributes.guide_link")}
      </GuideFooter>
    </>,
  );

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
  listings.length === 0 ? (
    <p>
      <em>{emptyText}</em>
    </p>
  ) : (
    <DataTable
      columns={[
        { header: t("terms.listing") },
        ...(showOptions ? [{ header: t("attributes.options_column") }] : []),
      ]}
      rows={listings.map((listing) => [
        <a
          class={listing.active ? undefined : "muted"}
          href={`/admin/listing/${listing.id}`}
        >
          {listing.name}
        </a>,
        ...(showOptions ? [listing.optionTexts.join(", ")] : []),
      ])}
    />
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

      <CsrfForm action={`/admin/attributes/${attribute.id}/edit`}>
        <Raw html={attributeNameForm.render({ name: attribute.name })} />
        <SubmitButton icon="save">{t("attributes.update")}</SubmitButton>
      </CsrfForm>

      <h2>{t("attributes.options_heading")}</h2>
      <CsrfForm
        action={`/admin/attributes/${attribute.id}/options`}
        id="new-attribute-option"
      >
        <Raw html={attributeOptionForm.render()} />
        <SubmitButton icon="plus">{t("attributes.add_option")}</SubmitButton>
      </CsrfForm>

      {attribute.options.length === 0 ? (
        <p>
          <em>{t("attributes.no_options")}</em>
        </p>
      ) : (
        <ReorderTable
          columns={
            <>
              <th>{t("attributes.option_column")}</th>
              <th class={colClass("quantity")}>
                {t("attributes.listings_column")}
              </th>
            </>
          }
          orderLabel={t("attributes.order_column")}
        >
          {attribute.options.map((option, index) => (
            <ReorderLinkRow
              action={(direction) =>
                `/admin/attributes/${attribute.id}/options/${option.id}/move-${direction}`
              }
              count={attribute.options.length}
              href={`/admin/attributes/${attribute.id}/options/${option.id}/edit`}
              index={index}
              label={option.text}
            >
              <td class={colClass("quantity")}>
                {data.listingCounts.get(option.id) ?? 0}
              </td>
            </ReorderLinkRow>
          ))}
        </ReorderTable>
      )}

      <h2>{t("attributes.listings.heading")}</h2>
      <AttributeListingsTable
        emptyText={t("attributes.listings.none")}
        listings={data.listings}
        showOptions={true}
      />

      <p>
        <a class="danger" href={`/admin/attributes/${attribute.id}/delete`}>
          {t("attributes.delete.link")}
        </a>
      </p>
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

const attributeConfirmPage = ({
  action,
  buttonText,
  error,
  heading,
  label,
  name,
  prompt,
  session,
  warning,
}: {
  action: string;
  buttonText: string;
  error: string | undefined;
  heading: string;
  label: string;
  name: string;
  prompt: { args: Record<string, string>; key: string };
  session: AdminSession;
  warning: JSX.Element;
}): string =>
  ConfirmPage({
    action,
    active: "/admin/attributes",
    buttonText,
    error,
    heading,
    label,
    name,
    prompt,
    session,
    title: heading,
    warning,
  });

export const adminAttributeDeletePage = (
  attribute: AttributeWithOptions,
  session: AdminSession,
  error?: string | undefined,
): string => {
  const name = attributeNameFlat(attribute.name);
  return attributeConfirmPage({
    action: `/admin/attributes/${attribute.id}/delete`,
    buttonText: t("attributes.delete.submit"),
    error,
    heading: t("attributes.delete.heading"),
    label: t("attributes.delete.confirm_label"),
    name,
    prompt: {
      args: { name },
      key: "attributes.delete.confirm_prompt",
    },
    session,
    warning: <p>{t("attributes.delete.warning")}</p>,
  });
};

export const adminAttributeOptionDeletePage = (
  attribute: AttributeWithOptions,
  option: AttributeOption,
  session: AdminSession,
  error?: string | undefined,
): string =>
  attributeConfirmPage({
    action: `/admin/attributes/${attribute.id}/options/${option.id}/delete`,
    buttonText: t("attributes.delete_option.submit"),
    error,
    heading: t("attributes.delete_option.heading"),
    label: t("attributes.delete_option.confirm_label"),
    name: option.text,
    prompt: {
      args: { text: option.text },
      key: "attributes.delete_option.confirm_prompt",
    },
    session,
    warning: (
      <p>
        {t("attributes.delete_option.warning", {
          attribute: attributeNameFlat(attribute.name),
          option: option.text,
        })}
      </p>
    ),
  });

type ListingAttributesPanelProps = ListingPanelProps & {
  attributes: AttributeWithOptions[];
  selectedOptionIds: Set<number>;
};

export const ListingAttributesPanel = (
  props: ListingAttributesPanelProps,
): JSX.Element => {
  const { attributes, error, listing, selectedOptionIds } = props;
  return listingChoicePanel(
    t("attributes.listing.heading", { listing: listing.name }),
    error,
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
      <CsrfForm action={`/admin/listing/${listing.id}/attributes`}>
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
            legend: attribute.name,
          }))}
        />
        <SubmitButton icon="save">{t("common.save")}</SubmitButton>
      </CsrfForm>
    ),
  );
};
