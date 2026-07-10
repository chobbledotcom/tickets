/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
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
import {
  ReorderCell,
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

const OptionRow = ({
  attribute,
  option,
  index,
}: {
  attribute: AttributeWithOptions;
  option: AttributeOption;
  index: number;
}): JSX.Element => (
  <tr>
    <ReorderCell
      action={(direction) =>
        `/admin/attributes/${attribute.id}/options/${option.id}/move-${direction}`
      }
      count={attribute.options.length}
      index={index}
    />
    <td>
      <CsrfForm
        action={`/admin/attributes/${attribute.id}/options/${option.id}/edit`}
      >
        <input
          aria-label={t("attributes.option_text_label")}
          name="text"
          required
          type="text"
          value={option.text}
        />
        <SubmitButton icon="save">{t("common.save")}</SubmitButton>
      </CsrfForm>
    </td>
    <td class={colClass("actions")}>
      <a
        class="danger"
        href={`/admin/attributes/${attribute.id}/options/${option.id}/delete`}
      >
        {t("common.delete")}
      </a>
    </td>
  </tr>
);

export const adminAttributePage = (
  attribute: AttributeWithOptions,
  session: AdminSession,
  error?: string,
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
              <th class={colClass("actions")}>{t("common.actions")}</th>
            </>
          }
          orderLabel={t("attributes.order_column")}
        >
          {attribute.options.map((option, index) => (
            <OptionRow attribute={attribute} index={index} option={option} />
          ))}
        </ReorderTable>
      )}

      <p>
        <a class="danger" href={`/admin/attributes/${attribute.id}/delete`}>
          {t("attributes.delete.link")}
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
