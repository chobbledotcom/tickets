/**
 * Admin templates for Site → Pages: the list, the create/edit forms (the edit
 * page carrying the item manager), and the delete confirmation.
 */

import { t } from "#i18n";
import { pageToValues, sitePageForm } from "#routes/admin/site-pages-form.ts";
import { ConfirmForm, CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminSession,
  SitePage,
  SitePageItemType,
  SitePageNavRow,
} from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  ActionButton,
  DeleteSection,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

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
    {index > 0 && (
      <CsrfForm action={`${base}/move-up`} class="inline">
        <button class="link-button small" type="submit">
          &#9650;
        </button>
      </CsrfForm>
    )}{" "}
    {index < count - 1 && (
      <CsrfForm action={`${base}/move-down`} class="inline">
        <button class="link-button small" type="submit">
          &#9660;
        </button>
      </CsrfForm>
    )}
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
    <Layout title={t("site.pages.title")}>
      <AdminNav active={ACTIVE} session={session} />
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
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("site.pages.order_column")}</th>
                  <th>{t("site.pages.name_column")}</th>
                  <th>{t("common.slug")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {model.roots.map((page, i) => (
                  <tr>
                    <td>
                      <Arrows
                        base={`${LIST}/${page.id}`}
                        count={model.roots.length}
                        index={i}
                      />
                    </td>
                    <td>
                      <a href={`${LIST}/${page.id}/edit`}>{page.name}</a>
                    </td>
                    <td>
                      <code>/page/{page.slug}</code>
                    </td>
                    <td>
                      <DeleteLink id={page.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {model.nested.length > 0 && (
            <>
              <h2>{t("site.pages.nested_heading")}</h2>
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t("site.pages.name_column")}</th>
                      <th>{t("site.pages.parent_column")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {model.nested.map(({ page, parentName }) => (
                      <tr>
                        <td>
                          <a href={`${LIST}/${page.id}/edit`}>{page.name}</a>
                        </td>
                        <td>{parentName}</td>
                        <td>
                          <DeleteLink id={page.id} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Layout>,
  );

export const adminSitePageNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("site.pages.new_title")}>
      <AdminNav active={ACTIVE} session={session} />
      <CsrfForm action={LIST}>
        <h1>{t("site.pages.new_title")}</h1>
        <Flash error={error} />
        <Raw html={sitePageForm.renderFields()} />
        <SubmitButton icon="plus">{t("site.pages.create_submit")}</SubmitButton>
      </CsrfForm>
    </Layout>,
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
    <Layout title={t("site.pages.edit_title")}>
      <AdminNav active={ACTIVE} session={session} />
      <CsrfForm action={`${LIST}/${page.id}/edit`}>
        <h1>{t("site.pages.edit_title")}</h1>
        <Flash error={error} />
        <Raw html={sitePageForm.renderFields(pageToValues(page))} />
        <SubmitButton icon="save">{t("common.save_changes")}</SubmitButton>
      </CsrfForm>

      <h2>{t("site.pages.items_heading")}</h2>
      {items.length === 0 ? (
        <p>
          <em>{t("site.pages.no_items")}</em>
        </p>
      ) : (
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("site.pages.order_column")}</th>
                <th>{t("site.pages.item_type_column")}</th>
                <th>{t("site.pages.name_column")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr>
                  <td>
                    <Arrows
                      base={itemBase(item)}
                      count={items.length}
                      index={i}
                    />
                  </td>
                  <td>{t(`site.pages.type.${item.type}`)}</td>
                  <td>{item.label}</td>
                  <td>
                    <CsrfForm
                      action={`${itemBase(item)}/remove`}
                      class="inline"
                    >
                      <button class="link-button small" type="submit">
                        {t("site.pages.remove")}
                      </button>
                    </CsrfForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
    </Layout>,
  );
};

export const adminSitePageDeletePage = (
  page: SitePage,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("site.pages.delete_title")}>
      <AdminNav active={ACTIVE} session={session} />
      <ConfirmForm
        action={`${LIST}/${page.id}/delete`}
        buttonText={t("site.pages.delete_submit")}
        label={t("site.pages.name_label")}
        name={page.name}
      >
        <h1>{t("site.pages.delete_title")}</h1>
        <Flash error={error} />
        <p>{t("site.pages.delete_prompt", { name: page.name })}</p>
      </ConfirmForm>
    </Layout>,
  );
