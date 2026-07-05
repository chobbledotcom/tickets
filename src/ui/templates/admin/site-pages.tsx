/**
 * Admin templates for Site → Pages: the list, the create/edit forms (the edit
 * page carrying the item manager), and the delete confirmation.
 */

import { t } from "#i18n";
import { pageToValues, sitePageForm } from "#routes/admin/site-pages-form.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminSession,
  SitePage,
  SitePageItemType,
  SitePageNavRow,
} from "#shared/types.ts";
import { AdminPage, adminFormPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import {
  ActionButton,
  DeleteSection,
  SaveChangesButton,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { DataTable } from "#templates/components/data-table.tsx";
import { ReorderArrows } from "#templates/components/reorder.tsx";

const ACTIVE = "/admin/site";
const LIST = "/admin/site/pages";

export type PickerOption = { value: string; label: string };
export type ResolvedItem = {
  type: SitePageItemType;
  id: number;
  label: string;
};
export type ListModel = {
  roots: SitePageNavRow[];
  nested: { page: SitePageNavRow; parentName: string }[];
};
export type EditModel = {
  page: SitePage;
  items: ResolvedItem[];
  listingOptions: PickerOption[];
  groupOptions: PickerOption[];
  pageOptions: PickerOption[];
};

/** Up/down reorder arrows for a row at `index` of `count`, posting to `base`. */
const Arrows = ({
  base,
  index,
  count,
}: {
  base: string;
  index: number;
  count: number;
}): JSX.Element => (
  <span class="reorder">
    <ReorderArrows
      action={(d) => `${base}/move-${d}`}
      count={count}
      index={index}
    />
  </span>
);

const DeleteLink = ({ id }: { id: number }): JSX.Element => (
  <a href={`${LIST}/${id}/delete`}>{t("common.delete")}</a>
);

export const adminSitePagesListPage = (
  model: ListModel,
  session: AdminSession,
  successMessage?: string,
): string =>
  String(
    <AdminPage active={ACTIVE} session={session} title={t("site.pages.title")}>
      <h1>{t("site.pages.title")}</h1>
      <Flash success={successMessage} />
      <p class="actions">
        <ActionButton href={`${LIST}/new`} icon="plus">
          {t("site.pages.add")}
        </ActionButton>
      </p>
      {model.roots.length === 0 && model.nested.length === 0 ? (
        <p>
          <em>{t("site.pages.none")}</em>
        </p>
      ) : (
        <>
          {/* A nested page always has a root ancestor, so reaching here (not the
              all-empty case above) guarantees at least one root to list. */}
          <h2>{t("site.pages.roots_heading")}</h2>
          <DataTable
            columns={[
              { header: t("site.pages.order_column") },
              { header: t("site.pages.name_column") },
              { header: t("common.slug") },
              { header: "" },
            ]}
            rows={model.roots.map((page, i) => [
              <Arrows
                base={`${LIST}/${page.id}`}
                count={model.roots.length}
                index={i}
              />,
              <a href={`${LIST}/${page.id}/edit`}>{page.name}</a>,
              <code>/page/{page.slug}</code>,
              <DeleteLink id={page.id} />,
            ])}
          />
          {model.nested.length > 0 && (
            <>
              <h2>{t("site.pages.nested_heading")}</h2>
              <DataTable
                columns={[
                  { header: t("site.pages.name_column") },
                  { header: t("site.pages.parent_column") },
                  { header: "" },
                ]}
                rows={model.nested.map(({ page, parentName }) => [
                  <a href={`${LIST}/${page.id}/edit`}>{page.name}</a>,
                  parentName,
                  <DeleteLink id={page.id} />,
                ])}
              />
            </>
          )}
        </>
      )}
    </AdminPage>,
  );

const sitePageFormShell = (
  title: string,
  action: string,
  session: AdminSession,
  fieldsHtml: string,
  error?: string,
  children?: JSX.Element,
): string =>
  adminFormPage({
    action,
    active: ACTIVE,
    children: (
      <>
        <Raw html={fieldsHtml} />
        {children}
      </>
    ),
    error,
    session,
    title,
  });

export const adminSitePageNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  sitePageFormShell(
    t("site.pages.new_title"),
    LIST,
    session,
    sitePageForm.renderFields(),
    error,
    <SubmitButton icon="plus">{t("site.pages.create_submit")}</SubmitButton>,
  );

/** A single "add <type>" picker: a select of eligible targets + an Add button. */
const ItemPicker = ({
  pageId,
  type,
  label,
  options,
}: {
  pageId: number;
  type: SitePageItemType;
  label: string;
  options: PickerOption[];
}): JSX.Element =>
  options.length === 0 ? (
    <p class="hint">
      {label}: {t("site.pages.no_targets")}
    </p>
  ) : (
    <CsrfForm action={`${LIST}/${pageId}/items`} class="inline-add">
      <input name="item_type" type="hidden" value={type} />
      <label>
        {label}{" "}
        <select name="item_id">
          {options.map((o) => (
            <option value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>{" "}
      <SubmitButton icon="plus">{t("site.pages.add_item")}</SubmitButton>
    </CsrfForm>
  );

export const adminSitePageEditPage = (
  model: EditModel,
  session: AdminSession,
  error?: string,
): string => {
  const { page, items } = model;
  const itemBase = (item: ResolvedItem): string =>
    `${LIST}/${page.id}/items/${item.type}/${item.id}`;
  return String(
    <AdminPage
      active={ACTIVE}
      session={session}
      title={t("site.pages.edit_title")}
    >
      <CsrfForm action={`${LIST}/${page.id}/edit`}>
        <h1>{t("site.pages.edit_title")}</h1>
        <Flash error={error} />
        <Raw html={sitePageForm.renderFields(pageToValues(page))} />
        {SaveChangesButton()}
      </CsrfForm>

      <h2>{t("site.pages.items_heading")}</h2>
      {items.length === 0 ? (
        <p>
          <em>{t("site.pages.no_items")}</em>
        </p>
      ) : (
        <DataTable
          columns={[
            { header: t("site.pages.order_column") },
            { header: t("site.pages.item_type_column") },
            { header: t("site.pages.name_column") },
            { header: "" },
          ]}
          rows={items.map((item, i) => [
            <Arrows base={itemBase(item)} count={items.length} index={i} />,
            t(`site.pages.type.${item.type}`),
            item.label,
            <CsrfForm action={`${itemBase(item)}/remove`} class="inline">
              <button class="link-button small" type="submit">
                {t("site.pages.remove")}
              </button>
            </CsrfForm>,
          ])}
        />
      )}

      <h3>{t("site.pages.add_item_heading")}</h3>
      <ItemPicker
        label={t("site.pages.type.listing")}
        options={model.listingOptions}
        pageId={page.id}
        type="listing"
      />
      <ItemPicker
        label={t("site.pages.type.group")}
        options={model.groupOptions}
        pageId={page.id}
        type="group"
      />
      <ItemPicker
        label={t("site.pages.type.page")}
        options={model.pageOptions}
        pageId={page.id}
        type="page"
      />

      <DeleteSection
        heading={t("common.delete")}
        href={`${LIST}/${page.id}/delete`}
      >
        {t("site.pages.delete_submit")}
      </DeleteSection>
    </AdminPage>,
  );
};

export const adminSitePageDeletePage = (
  page: SitePage,
  session: AdminSession,
  error?: string,
): string =>
  ConfirmPage({
    action: `${LIST}/${page.id}/delete`,
    active: ACTIVE,
    buttonText: t("site.pages.delete_submit"),
    children: (
      <>
        <h1>{t("site.pages.delete_title")}</h1>
        <p>{t("site.pages.delete_prompt", { name: page.name })}</p>
      </>
    ),
    error,
    label: t("site.pages.name_label"),
    name: page.name,
    session,
    title: t("site.pages.delete_title"),
  });
