/**
 * Shared admin-page scaffolding: Layout + AdminNav, with the page title set
 * and the page body (children) inside.
 *
 * Several admin templates open with the same
 *   String(<Layout title={...}><AdminNav active="..." session={...} />
 *         ...body... </Layout>)
 * shape; this helper factors that out so it lives in one place.
 *
 * The optional `flash` prop is rendered immediately after <AdminNav> — most
 * admin pages open with `<Flash error=.../>` or `<Flash success=.../>`, and
 * passing it here collapses the per-page `<Flash>` line into the AdminPage
 * call so the opener boilerplate can't drift across pages.
 */

/* jscpd:ignore-start */
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, Theme } from "#shared/types.ts";
import { AdminNav, type NavActive } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";
/* jscpd:ignore-end */

export type AdminPageProps = {
  title: string;
  session: AdminSession;
  active: NavActive;
  bodyClass?: string;
  /** Page identity/custom-CSS hook; defaults to admin-page. */
  contentClassName?: string;
  /** Optional page theme forwarded to <Layout> — the settings/debug pages
   *  preview the site's saved theme (`s.theme`) rather than the viewer's. */
  theme?: Theme;
  /** Optional flash notice (or any markup) rendered right after <AdminNav>.
   *  Pass a `<Flash .../>` element — or use `flashProps(error, success)` to
   *  build its props. */
  flash?: Child;
  /** Optional page action row, rendered as `<p class="actions">…</p>` right
   *  after the flash (before the body). Pass the action *contents* (e.g. an
   *  `<ActionButton>` and a `<GuideLink>`); AdminPage wraps them so the
   *  action-row scaffold can't drift per page. Omit when a page has no
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
  contentClassName,
  theme,
  flash,
  actions,
  children,
}: AdminPageProps): JSX.Element => (
  <Layout
    beforeContent={<AdminNav active={active} session={session} />}
    {...(bodyClass !== undefined ? { bodyClass } : {})}
    contentClassName={contentClassName ?? "admin-page"}
    {...(theme !== undefined ? { theme } : {})}
    title={title}
  >
    {flash}
    {actions !== undefined && <p class="actions">{actions}</p>}
    {children}
  </Layout>
);

/** Render an admin page to an HTML string with no flash — the plain
 *  `String(<AdminPage active session title>…</AdminPage>)` wrapper shared by
 *  the bulk-email pages, the Site-tab collection pages, and the API-keys pages. */
export const renderAdminPage = (
  active: NavActive,
  session: AdminSession,
  title: string,
  children: Child,
): string =>
  String(
    <AdminPage active={active} session={session} title={title}>
      {children}
    </AdminPage>,
  );

/** An admin page whose whole body is one CSRF form headed by an `<h1>{title}</h1>`
 *  and an error/success Flash — the shape the recalculate pages and the
 *  site-page create/edit forms share. `children` is the form body after the
 *  flash (fields, tables, extra controls). */
export const adminFormPage = ({
  title,
  active,
  session,
  action,
  error,
  success,
  children,
}: {
  title: string;
  active: NavActive;
  session: AdminSession;
  action: string;
  error?: string | undefined;
  success?: string | undefined;
  children: Child;
}): string =>
  renderAdminPage(
    active,
    session,
    title,
    <CsrfForm action={action}>
      <FormHeader error={error} success={success} title={title} />
      {children}
    </CsrfForm>,
  );

/** The `<h1>` heading plus error/success Flash notice that opens most admin
 *  forms. Shared so the heading-then-flash pair is authored once. */
export const FormHeader = ({
  title,
  error,
  success,
}: {
  title: string;
  error?: string | undefined;
  success?: string | undefined;
}): JSX.Element => (
  <>
    <h1>{title}</h1>
    <Flash error={error} success={success} />
  </>
);

/** Build the props for an optional error/success Flash notice. The dashboards
 *  and landing pages share the
 *    <Flash {...(error !== undefined ? { error } : {})}
 *           {...(success !== undefined ? { success } : {})} />
 *  pattern; this helper centralises it and keeps exactOptionalPropertyTypes
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

/**
 * Curried admin-page opener for the list pages (holidays, logistics) and
 * dashboards (update, builder) that share the
 *   (session, [...flash args]) => String(<AdminPage active="/admin/settings"
 *   flash={...} session=session title={title}>){body})()
 * shape. The `flash` builder receives whatever args the specialisation
 * forwards and returns the Flash element (or null); the two exports below
 * specialise it for the success-message list pages and the error/success
 * dashboard pages. The returned body receiver also takes an optional
 * `actions` arg — when supplied, AdminPage renders it as the page's action
 * row so the `<p class="actions">` scaffold lives in one place.
 */
const curriedAdminPage =
  <FlashArgs extends unknown[]>(
    title: string,
    active: string,
    flash: (...args: FlashArgs) => JSX.Element | null,
  ) =>
  (session: AdminSession, ...flashArgs: FlashArgs) =>
  (body: Child, actions?: Child): string =>
    String(
      <AdminPage
        actions={actions}
        active={active}
        flash={flash(...flashArgs)}
        session={session}
        title={title}
      >
        {body}
      </AdminPage>,
    );

/** Themed admin opener for the settings/debug pages, which preview the site's
 *  saved theme (`s.theme`) rather than the viewer's. Takes the title (and
 *  optional `active`), returns a function taking (session, theme) and producing
 *  a page-body receiver. No flash — these pages render their own notices (or
 *  none) inline. Kept curried so the many call sites stay single expressions
 *  rather than repeating the multi-line `<AdminPage>` prop block. */
export const themedAdminPage =
  (title: string, active = "/admin/settings") =>
  (session: AdminSession, theme: Theme) =>
  (body: Child): string =>
    String(
      <AdminPage active={active} session={session} theme={theme} title={title}>
        {body}
      </AdminPage>,
    );

/** Build a titled admin opener from just its `flash` builder — the shared
 *  `(title, active?) => curriedAdminPage(title, active, flash)` shape the three
 *  specialisations below only differ in the flash argument shape of. */
const adminOpenerFor =
  <FlashArgs extends unknown[]>(
    flash: (...args: FlashArgs) => JSX.Element | null,
  ) =>
  (title: string, active = "/admin/settings") =>
    curriedAdminPage(title, active, flash);

/** List-page admin opener: takes the page title (and optional `active`),
 *  returns a function taking (session, successMessage) and producing a
 *  page-body receiver. Renders a success Flash when successMessage is set. */
export const successAdminPage = adminOpenerFor((success?: string) =>
  success === undefined ? null : <Flash success={success} />,
);

/** CRUD edit-page admin opener: takes the page title (and optional `active`),
 *  returns a function taking (session, error) and producing a page-body
 *  receiver. Renders an error Flash when error is set; otherwise no Flash.
 *  Used by the holiday/logistics edit pages. */
export const errorAdminPage = adminOpenerFor((error?: string) =>
  error === undefined ? null : <Flash error={error} />,
);

/** Dashboard admin opener: takes the page title (and optional `active`),
 *  returns a function taking (session, error, success) and producing a
 *  page-body receiver. Renders an error/success Flash via flashProps(). */
export const flashAdminPage = adminOpenerFor(
  (error?: string, success?: string) =>
    error === undefined && success === undefined ? null : (
      <Flash {...flashProps(error, success)} />
    ),
);
