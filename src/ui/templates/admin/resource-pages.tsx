/**
 * Resource-level admin page factory.
 *
 * Several owner-only settings resources share one workflow: a list page, a
 * create page, and a type-the-name delete confirmation page. This factory
 * turns one config object into those three pages. The
 * resource declares its paths (derived from `basePath`), titles, table
 * columns (typed via {@link DataColumn}), form fields (a `renderFields`
 * callback so non-`Field[]` forms like the attendee-status checkboxes still
 * fit), and the delete confirmation copy.
 * `AdminPage`, `DataTable`, and `ConfirmPage` are its rendering primitives.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import {
  type FlashPageRenderer,
  flashAdminPage,
} from "#templates/admin/admin-page.tsx";
import { ConfirmPage, type TCall } from "#templates/admin/confirm-page.tsx";
import { WritableLink, WritableOnly } from "#templates/admin/writable-only.tsx";
import {
  type DataColumn,
  dataTable,
} from "#templates/components/data-table.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
/* jscpd:ignore-end */

/** A delete confirmation spec, parameterised by the entity. */
export type DeleteSpec<TEntity> = {
  /** The name the operator must type to confirm (also the ConfirmForm target). */
  name: (entity: TEntity) => string;
  /** ConfirmForm label ("type X to confirm"). */
  label: string;
  /** Page + form heading. */
  heading: string;
  /** A `<Raw html={t(...)}/>` "this will delete X" warning paragraph. */
  confirm?: (entity: TEntity) => TCall;
  /** A plain-text confirm prompt paragraph. */
  prompt?: (entity: TEntity) => TCall;
  /** Extra body inside the ConfirmForm (e.g. a `<p>{t(…, {name})}</p>`). */
  children?: (entity: TEntity) => Child;
  /** Whether to style the form as dangerous. */
  danger: boolean;
};

/** A resource's page labels. */
export type ResourceLabels = {
  listTitle: string;
  addTitle: string;
  addHeading: string;
  addSubmit: string;
  deleteTitle: string;
  deleteButton: string;
  deleteLabel: string;
};

/** The list-page facet of a resource: its table columns, empty-state markup,
 *  and optional intro/action-row content. Omitted entirely by resources whose
 *  list page is hand-rolled (logistics), which never call `listPage`. */
export type ResourceList<TEntity> = {
  columns: readonly DataColumn<TEntity>[];
  /** Empty-state markup when the list has no rows (nothing when omitted). */
  empty?: Child;
  /** Optional intro markup rendered before the table (e.g. a prose heading). */
  intro?: Child;
  /** Action-row contents (e.g. an "Add" button). */
  actions: JSX.Element;
  /** Optional guide link rendered at the very bottom of the list body. */
  guideFooter?: Child;
};

export type AdminResourcePagesConfig<TEntity extends { id: number }> = {
  /** The nav `active` key (e.g. "/admin/settings"). */
  active: string;
  /** Base collection path (e.g. "/admin/holidays"). */
  basePath: string;
  labels: ResourceLabels;
  /** The list-page facet (columns + empty state + optional intro/actions).
   *  Omitted by resources whose list page is hand-rolled (logistics). */
  list?: ResourceList<TEntity>;
  /** Render the create form fields. */
  renderFields: (entity: TEntity | undefined) => Child;
  /** Delete confirmation spec. */
  delete: DeleteSpec<TEntity>;
};

/** A "Name" column whose text links to the row's edit page (shown as plain
 *  text when the page is read-only). `editHref` and `name` both read the row. */
export const writableNameColumn = <TEntity,>(
  editHref: (entity: TEntity) => string,
  name: (entity: TEntity) => string,
): DataColumn<TEntity> => ({
  cell: (entity) => (
    <WritableLink href={editHref(entity)}>{name(entity)}</WritableLink>
  ),
  header: t("common.name"),
});

/** The shape every resource list page shares: the rows to show, then the same
 *  session + optional error/success flashes every flash-carrying admin page
 *  takes ({@link FlashPageRenderer}). */
export type AdminListPage<TEntity> = (
  entities: TEntity[],
  ...args: Parameters<FlashPageRenderer>
) => string;

export interface AdminResourcePages<TEntity extends { id: number }> {
  deletePage: (
    entity: TEntity,
    session: AdminSession,
    error?: string,
  ) => string;
  listPage: AdminListPage<TEntity>;
  newPage: (session: AdminSession, error?: string) => string;
}

/** Build the standard list/new/delete pages for a resource. */
export const defineAdminResourcePages = <TEntity extends { id: number }>(
  config: AdminResourcePagesConfig<TEntity>,
): AdminResourcePages<TEntity> => {
  const listPage: AdminListPage<TEntity> = (
    entities,
    session,
    error,
    success,
  ) => {
    // listPage is only called by resources that declare a `list` facet.
    const list = config.list as ResourceList<TEntity>;
    return flashAdminPage(config.labels.listTitle, config.active)(
      session,
      error,
      success,
    )(
      <>
        {list.intro}
        {entities.length > 0 ? dataTable(list.columns)(entities) : list.empty}
        {list.guideFooter}
      </>,
      <WritableOnly>{list.actions}</WritableOnly>,
    );
  };

  const newPage = (session: AdminSession, error?: string): string =>
    flashAdminPage(config.labels.addTitle, config.active)(session, error)(
      <SaveForm
        action={config.basePath}
        submitIcon="plus"
        submitLabel={config.labels.addSubmit}
      >
        <h1>{config.labels.addHeading}</h1>
        {config.renderFields(undefined)}
      </SaveForm>,
    );

  const deletePage = (
    entity: TEntity,
    session: AdminSession,
    error?: string,
  ): string => {
    const del = config.delete;
    const confirm = del.confirm?.(entity);
    const prompt = del.prompt?.(entity);
    const children = del.children?.(entity);
    return ConfirmPage({
      action: `${config.basePath}/${entity.id}/delete`,
      active: config.active,
      buttonText: config.labels.deleteButton,
      danger: del.danger,
      heading: del.heading,
      label: del.label,
      name: del.name(entity),
      session,
      title: config.labels.deleteTitle,
      ...(confirm !== undefined ? { confirm } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(children !== undefined ? { children } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  };

  return { deletePage, listPage, newPage };
};
