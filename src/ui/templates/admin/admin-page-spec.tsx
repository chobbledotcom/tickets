/**
 * The admin page spec and its renderer: the one typed schema every admin page
 * fills in, rendered through the AdminPage shell defined here. The legacy
 * openers in admin-page.tsx rewire to this module layer by layer.
 */

/* jscpd:ignore-start */
import type { Child } from "#jsx/jsx-runtime.ts";
import type { FlashFields } from "#shared/flash-fields.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { Flash } from "#shared/forms/flash.tsx";
import type {
  ReorderColumnOptions,
  TableColumn,
} from "#shared/tables/column.ts";
import { AgentHeader } from "#templates/admin/agent-header.tsx";
import {
  AdminNav,
  type NavActive,
  StaffAdminNav,
} from "#templates/admin/nav.tsx";
import {
  renderListPartTable,
  type TableContextOptions,
} from "#templates/components/table.tsx";
import { Layout } from "#templates/layout.tsx";
import type { AdminSession, Theme } from "#types";
/* jscpd:ignore-end */

export type AdminPageProps = {
  title: string;
  session: AdminSession;
  active: NavActive;
  bodyClass?: string;
  /** Page identity/custom-CSS hook. Defaults to admin-page. */
  contentClassName?: string;
  /** Optional page theme forwarded to <Layout> — the settings/debug pages
   *  preview the site's saved theme (`s.theme`) rather than the viewer's. */
  theme?: Theme;
  /** Optional flash notice (or any markup) rendered right after <AdminNav>.
   *  Pass a `<Flash .../>` element — or use `flashProps(error, success)` to
   *  build its props. */
  flash?: Child;
  /** Optional page action row, rendered as `<p class="actions">…</p>` right
   *  after the flash (before the body). Pass the action *contents* (for
   *  example an `<ActionButton>` and a `<GuideLink>`). AdminPage wraps them so
   *  the action-row scaffold does not drift per page. Omit when a page has no
   *  actions. */
  actions?: Child;
  children: Child;
};

/** Render an admin page wrapped in <Layout> + <AdminNav>. */
export const AdminPage = ({
  title,
  session,
  active,
  bodyClass,
  contentClassName = "admin-page",
  theme,
  flash,
  actions,
  children,
}: AdminPageProps): JSX.Element => (
  <Layout
    beforeContent={<AdminNav active={active} session={session} />}
    {...(bodyClass !== undefined ? { bodyClass } : {})}
    contentClassName={contentClassName}
    family="admin"
    {...(theme !== undefined ? { theme } : {})}
    title={title}
  >
    {flash}
    {actions !== undefined && <p class="actions">{actions}</p>}
    {children}
  </Layout>
);

/** Build the props for an optional error/success Flash notice. The dashboards
 *  and landing pages share the
 *    <Flash {...(error !== undefined ? { error } : {})}
 *           {...(success !== undefined ? { success } : {})} />
 *  pattern. This helper centralises it and keeps exactOptionalPropertyTypes
 *  satisfied at the call sites. */
export const flashProps = (
  error?: string,
  success?: string,
  info?: string,
): { error?: string; success?: string; info?: string } => ({
  ...(error !== undefined ? { error } : {}),
  ...(success !== undefined ? { success } : {}),
  ...(info !== undefined ? { info } : {}),
});

/** The `<h1>` heading plus error/success Flash notice that opens most admin
 *  forms. Shared so the heading-then-flash pair is authored once. */
export const FormHeader = ({
  title,
  error,
  info,
  success,
}: {
  title: string;
  error?: string | undefined;
  info?: string | undefined;
  success?: string | undefined;
}): JSX.Element => (
  <>
    <h1>{title}</h1>
    <Flash error={error} info={info} success={success} />
  </>
);

/** The standard list body: intro, then the table or its empty note, then the
 *  guide footer. */
export type AdminPageListPart<
  TItem,
  TContext = undefined,
> = TableContextOptions<TContext> & {
  intro?: Child;
  items: TItem[];
  columns: readonly TableColumn<TItem, TContext>[];
  empty: Child;
  /** Replaces the table-or-empty section when set: the listing's source is
   *  unavailable (the images page: file storage not configured). */
  unavailable?: Child;
  /** Wraps the table-or-empty section, when the page frames its list (the
   *  logistics agents article). */
  frame?: (section: Child) => Child;
  /** Optional move controls, hidden with their column in read-only mode. */
  reorder?: ReorderColumnOptions<TItem> | undefined;
  guideFooter?: Child;
};

/** A body that is one CSRF form, headed by the h1-then-flash pair. */
export type AdminPageFormPart = {
  action: string;
  flash?: FlashFields;
  fields: Child;
};

/** What it takes to open an admin page: the shell fields every page sets,
 *  plus at most one of `list`, `form`, or `body`. Staff pages (the run
 *  sheet, the logout page) set `staff` instead. Staff pages render through
 *  the staff nav with the bare agent header shown to agent users, and their
 *  notices stay inside the body. */
export type AdminPageSpec<TItem = never, TContext = undefined> = {
  title: string;
  active: NavActive;
  session: AdminSession;
  /** Preview the site's saved theme (settings/debug) rather than the
   *  viewer's. */
  theme?: Theme;
  /** Page identity/custom-CSS hook. Defaults to admin-page. */
  contentClassName?: string | undefined;
  bodyClass?: string | undefined;
  /** The notice right after the nav, when the page carries one. */
  flash?: FlashFields;
  /** Top action row contents. AdminPage renders the scaffold around them. */
  actions?: Child;
  list?: AdminPageListPart<TItem, TContext>;
  form?: AdminPageFormPart;
  body?: Child;
  staff?: { heading?: Child };
};

/** The Flash element a spec's notice bag renders as: null when the bag holds
 *  no message, so the page shows no notice at all. */
const specFlash = (flash: FlashFields): Child =>
  flash.error === undefined &&
  flash.success === undefined &&
  flash.info === undefined ? null : (
    <Flash {...flashProps(flash.error, flash.success, flash.info)} />
  );

/** The standard list body: intro, table-or-empty, guide footer. */
const listBody = <TItem, TContext>(
  list: AdminPageListPart<TItem, TContext>,
): JSX.Element => {
  const section =
    list.unavailable !== undefined
      ? list.unavailable
      : list.items.length > 0
        ? renderListPartTable(
            list.columns,
            list.items,
            list.reorder,
            list.context,
          )
        : list.empty;
  return (
    <>
      {list.intro}
      {list.frame !== undefined ? list.frame(section) : section}
      {list.guideFooter}
    </>
  );
};

/** The render function a flash-carrying admin page exposes: given the viewer's
 *  session and optional error/success notices, it returns the page HTML. Shared
 *  by the single-form pages and the resource pages. */
export type FlashPageRenderer = (
  session: AdminSession,
  error?: string,
  success?: string,
) => string;

/** Open an admin page from its spec — the one render function every admin
 *  page goes through. */
export const renderAdminPageSpec = <TItem, TContext = undefined>(
  spec: AdminPageSpec<TItem, TContext>,
): string => {
  if (spec.staff !== undefined) {
    return String(
      <Layout
        beforeContent={
          <StaffAdminNav active={spec.active} session={spec.session} />
        }
        family="admin"
        title={spec.title}
      >
        {spec.session.adminLevel === "agent" ? (
          <AgentHeader title={spec.title} />
        ) : (
          spec.staff.heading
        )}
        {spec.body}
      </Layout>,
    );
  }
  const body =
    spec.form !== undefined ? (
      <CsrfForm action={spec.form.action}>
        <FormHeader
          error={spec.form.flash?.error}
          info={spec.form.flash?.info}
          success={spec.form.flash?.success}
          title={spec.title}
        />
        {spec.form.fields}
      </CsrfForm>
    ) : spec.list !== undefined ? (
      listBody(spec.list)
    ) : (
      spec.body
    );
  return String(
    <AdminPage
      active={spec.active}
      session={spec.session}
      title={spec.title}
      {...(spec.theme !== undefined ? { theme: spec.theme } : {})}
      {...(spec.contentClassName !== undefined
        ? { contentClassName: spec.contentClassName }
        : {})}
      {...(spec.bodyClass !== undefined ? { bodyClass: spec.bodyClass } : {})}
      flash={spec.flash === undefined ? null : specFlash(spec.flash)}
      {...(spec.actions !== undefined ? { actions: spec.actions } : {})}
    >
      {body}
    </AdminPage>,
  );
};

/** The `<h1>` heading plus error/success Flash notice that opens admin
 *  forms. Shared so the heading-then-flash pair is authored once. */
