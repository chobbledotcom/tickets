/**
 * Resource-level admin page factory.
 *
 * Several owner-only settings resources (holidays, attendee statuses,
 * logistics agents) share one workflow — a list page (table + actions + empty
 * state), a create page, an edit page (form + delete section), and a
 * type-the-name delete confirmation page. Each used to hand-wire that
 * workflow against `AdminPage`/`DataTable`/`ConfirmPage` directly, so every
 * new resource had to re-remember the same path/title/flash/table/delete
 * conventions.
 *
 * This factory turns one config object into the four standard pages. The
 * resource declares its paths (derived from `basePath`), titles, table
 * columns (typed via {@link DataColumn}), form fields (a `renderFields`
 * callback so non-`Field[]` forms like the attendee-status checkboxes still
 * fit), optional extra edit-only form content carried by a typed `TEditCtx`
 * (the logistics assigned-users selector), and the delete confirmation copy.
 * `AdminPage`, `DataTable`, and `ConfirmPage` stay as the low-level
 * primitives the factory renders through — they are no longer the main
 * public abstraction each resource wires by hand.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import {
  type FlashPageRenderer,
  flashAdminPage,
} from "#templates/admin/admin-page.tsx";
import { ConfirmPage, type TCall } from "#templates/admin/confirm-page.tsx";
import { WritableLink, WritableOnly } from "#templates/admin/writable-only.tsx";
import {
  DeleteSection,
  SaveChangesButton,
  SubmitButton,
} from "#templates/components/actions.tsx";
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

/** A resource's page labels. Functions receive the entity for edit/delete. */
export type ResourceLabels = {
  listTitle: string;
  addTitle: string;
  addHeading: string;
  addSubmit: string;
  editTitle: string;
  editHeading: string;
  /** Edit submit button label. Defaults to `common.save_changes`. */
  editSubmit?: string;
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

export type AdminResourcePagesConfig<
  TEntity extends { id: number },
  TEditCtx = undefined,
> = {
  /** The nav `active` key (e.g. "/admin/settings"). */
  active: string;
  /** Base collection path (e.g. "/admin/holidays"). `…/:id/edit` and
   *  `…/:id/delete` are derived from it. */
  basePath: string;
  labels: ResourceLabels;
  /** The list-page facet (columns + empty state + optional intro/actions).
   *  Omitted by resources whose list page is hand-rolled (logistics). */
  list?: ResourceList<TEntity>;
  /** Render the form fields for new/edit. Receives `undefined` on the create
   *  page and the entity on edit — so a single callback covers both. Return
   *  a `<Raw html={renderFields(...)}/>` for `Field[]`-backed forms, or any
   *  JSX for hand-rolled field markup. */
  renderFields: (entity: TEntity | undefined) => Child;
  /** Optional extra content rendered inside the edit form (after the fields),
   *  e.g. the logistics assigned-users selector. `TEditCtx` carries whatever
   *  extra runtime data the edit page needs (defaults to `undefined` when the
   *  edit form has no extra data). */
  renderEditExtra?: (entity: TEntity, ctx: TEditCtx) => Child;
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

/** Build the four standard admin pages (list/new/edit/delete) for a resource
 *  from one config. The edit page takes an optional typed `ctx` whose value
 *  is forwarded to `renderEditExtra` — so a resource whose edit form needs
 *  extra runtime data (logistics assigned users) supplies it without forcing
 *  every other resource to widen its signature. */
export const defineAdminResourcePages = <
  TEntity extends { id: number },
  TEditCtx = undefined,
>(
  config: AdminResourcePagesConfig<TEntity, TEditCtx>,
) => {
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

  const editPage = (
    entity: TEntity,
    session: AdminSession,
    error?: string,
    ctx?: TEditCtx,
  ): string =>
    flashAdminPage(config.labels.editTitle, config.active)(session, error)(
      <>
        <CsrfForm action={`${config.basePath}/${entity.id}/edit`}>
          <h1>{config.labels.editHeading}</h1>
          {config.renderFields(entity)}
          {config.renderEditExtra?.(entity, ctx as TEditCtx)}
          {config.labels.editSubmit !== undefined ? (
            <SubmitButton icon="save">{config.labels.editSubmit}</SubmitButton>
          ) : (
            SaveChangesButton()
          )}
        </CsrfForm>
        <DeleteSection
          heading={t("common.delete")}
          href={`${config.basePath}/${entity.id}/delete`}
        >
          {config.labels.deleteButton}
        </DeleteSection>
      </>,
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

  return { deletePage, editPage, listPage, newPage };
};
