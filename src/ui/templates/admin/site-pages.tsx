/**
 * Admin templates for Site → Pages: the list, the create/edit forms (the edit
 * page carrying the item manager), and the delete confirmation.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { contentFieldValues } from "#routes/admin/content-form-fields.ts";
import {
  sitePageEditForm,
  sitePageForm,
} from "#routes/admin/site-pages-form.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminSession,
  SitePage,
  SitePageItemType,
  SitePageNavRow,
} from "#shared/types.ts";
import { adminFormPage } from "#templates/admin/admin-page.tsx";
import { rowDeleteLink } from "#templates/admin/delete-link.tsx";
import {
  collectionPage,
  contentEditPanel,
  deleteConfirmPage,
} from "#templates/admin/site-content.tsx";
import { WritableLink, WritableOnly } from "#templates/admin/writable-only.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { DataTable } from "#templates/components/data-table.tsx";
import { InlineFormButton } from "#templates/components/inline-form-button.tsx";
import { ReorderArrows } from "#templates/components/reorder.tsx";

/* jscpd:ignore-end */

const LIST = "/admin/site/pages";
const ACTIVE = LIST;

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
  <WritableOnly>
    <span class="reorder">
      <ReorderArrows
        action={(d) => `${base}/move-${d}`}
        count={count}
        index={index}
      />
    </span>
  </WritableOnly>
);

const DeleteLink = rowDeleteLink(LIST);

/** A page row's name cell: the page name linking through to its edit page.
 * Shared by the root-page list and the nested-page list. */
const PageNameLink = ({
  id,
  name,
}: {
  id: number;
  name: string;
}): JSX.Element => (
  <WritableLink href={`${LIST}/${id}/edit`}>{name}</WritableLink>
);

/** A reorderable table: the order-arrow cell first, then the caller's cells,
 * under (order, ...headers, actions) columns. Shared by the root-page list
 * and the edit page's item manager. */
const reorderableTable = <T,>(opts: {
  headers: string[];
  rows: T[];
  base: (row: T) => string;
  cells: (row: T) => (JSX.Element | string)[];
}): JSX.Element => (
  <DataTable
    columns={[
      { header: t("site.pages.order_column") },
      ...opts.headers.map((header) => ({ header })),
      { header: "" },
    ]}
    rows={opts.rows.map((row, index) => [
      <Arrows base={opts.base(row)} count={opts.rows.length} index={index} />,
      ...opts.cells(row),
    ])}
  />
);

/** A page-list row's cells: the name link, one middle cell (public slug or
 * parent name), then the delete link. Shared by the root and nested lists. */
const pageRowCells = (
  page: SitePageNavRow,
  middle: JSX.Element | string,
): (JSX.Element | string)[] => [
  <PageNameLink id={page.id} name={page.name} />,
  middle,
  <DeleteLink id={page.id} />,
];

export const adminSitePagesListPage = (
  model: ListModel,
  session: AdminSession,
  successMessage?: string,
): string =>
  collectionPage("site.pages", LIST)(
    session,
    successMessage,
    model.roots.length === 0 && model.nested.length === 0 ? (
      <p>
        <em>{t("site.pages.none")}</em>
      </p>
    ) : (
      <>
        {/* A nested page always has a root ancestor, so reaching here (not the
              all-empty case above) guarantees at least one root to list. */}
        <h2>{t("site.pages.roots_heading")}</h2>
        {reorderableTable({
          base: (page) => `${LIST}/${page.id}`,
          cells: (page) => pageRowCells(page, <code>/page/{page.slug}</code>),
          headers: [t("site.pages.name_column"), t("common.slug")],
          rows: model.roots,
        })}
        {model.nested.length > 0 && (
          <>
            <h2>{t("site.pages.nested_heading")}</h2>
            <DataTable
              columns={[
                { header: t("site.pages.name_column") },
                { header: t("site.pages.parent_column") },
                { header: "" },
              ]}
              rows={model.nested.map(({ page, parentName }) =>
                pageRowCells(page, parentName),
              )}
            />
          </>
        )}
      </>
    ),
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

/** A single "add <type>" picker: a select of eligible targets + an Add button.
 * Renders nothing when there is nothing to add (an empty picker only shows a
 * confusing "nothing available" line otherwise). */
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
}): JSX.Element | null =>
  options.length === 0 ? null : (
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

/** The Edit tab's panel: the page-fields form (name, editable slug + public
 * link, SEO meta, markdown body) posting to the update route. */
export const sitePageEditPanel = (page: SitePage): JSX.Element =>
  contentEditPanel(
    `${LIST}/${page.id}/edit`,
    sitePageEditForm.renderFields(contentFieldValues(page)),
  );

/** The Items tab's panel: the page's current contents (reorderable, each
 * removable) plus the add-item pickers. Pickers with nothing to offer are
 * hidden, and the whole "Add" section disappears when nothing can be added. */
export const sitePageItemsPanel = (model: EditModel): JSX.Element => {
  const { page, items } = model;
  const itemBase = (item: ResolvedItem): string =>
    `${LIST}/${page.id}/items/${item.type}/${item.id}`;
  const anyOptions =
    model.listingOptions.length > 0 ||
    model.groupOptions.length > 0 ||
    model.pageOptions.length > 0;
  return (
    <>
      {items.length === 0 ? (
        <p>
          <em>{t("site.pages.no_items")}</em>
        </p>
      ) : (
        reorderableTable({
          base: itemBase,
          cells: (item) => [
            t(`site.pages.type.${item.type}`),
            item.label,
            <InlineFormButton action={`${itemBase(item)}/remove`}>
              {t("site.pages.remove")}
            </InlineFormButton>,
          ],
          headers: [
            t("site.pages.item_type_column"),
            t("site.pages.name_column"),
          ],
          rows: items,
        })
      )}

      {anyOptions && (
        <>
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
        </>
      )}
    </>
  );
};

export const adminSitePageDeletePage = (
  page: SitePage,
  session: AdminSession,
  error?: string,
): string =>
  deleteConfirmPage("site.pages", ACTIVE)(
    `${LIST}/${page.id}/delete`,
    page.name,
    session,
    error,
  );
