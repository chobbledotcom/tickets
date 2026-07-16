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
import { t } from "#i18n";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, Theme } from "#shared/types.ts";
import { AgentHeader } from "#templates/admin/agent-header.tsx";
import {
  AdminNav,
  type NavActive,
  StaffAdminNav,
} from "#templates/admin/nav.tsx";
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

/** A link to a listing's admin page showing its name —
 *  `<a href="/admin/listing/{id}">{name}</a>`. Owned here so the same admin
 *  listing link isn't re-authored (and re-detected as a clone) across the
 *  attendee form and the booking-QR page. */
export const AdminListingLink = ({
  listing,
}: {
  listing: { id: number; name: string };
}): JSX.Element => <a href={`/admin/listing/${listing.id}`}>{listing.name}</a>;

/** Render an <AdminPage> to an HTML string from its props and body — the one
 *  `String(<AdminPage …>{body}</AdminPage>)` wrapper every admin opener below
 *  shares, so the props each opener sets (flash+actions, theme, or none) are the
 *  only difference between them. */
const stringifyAdminPage = (
  props: Omit<AdminPageProps, "children">,
  children: Child,
): string => String(<AdminPage {...props}>{children}</AdminPage>);

/** Render an admin page to an HTML string with no flash — the plain
 *  `String(<AdminPage active session title>…</AdminPage>)` wrapper shared by
 *  the bulk-email pages, the Site-tab collection pages, and the API-keys pages. */
export const renderAdminPage = (
  active: NavActive,
  session: AdminSession,
  title: string,
  children: Child,
): string => stringifyAdminPage({ active, session, title }, children);

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
    stringifyAdminPage(
      { actions, active, flash: flash(...flashArgs), session, title },
      body,
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
    stringifyAdminPage({ active, session, theme, title }, body);

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

/** Bind a dashboard page to its title/nav highlight and a body built from the
 *  loaded data, giving back a `(session, data, error?, success?) => string`
 *  page. This is the shared shape behind the backup, builder, and update pages:
 *  each differs only in its title, nav path, and how it renders its data — never
 *  in the `(session, …, error?, success?) => flashAdminPage(…)` wrapper. Pass
 *  `undefined` for `active` to fall back to the settings nav highlight. */
// A `function` declaration (not a `const` arrow) so it is hoisted: the page
// modules below build their `adminXPage` with `flashDataPage(...)` at module
// load, and admin-page.tsx sits in an import cycle with them, so a const would
// be in its temporal dead zone when they run. Calling it only builds a closure
// (the flashAdminPage/renderBody calls happen later, at render), so hoisting is
// safe.
export function flashDataPage<D>(
  titleKey: string,
  active: string | undefined,
  renderBody: (data: D) => Child,
): (
  session: AdminSession,
  data: D,
  error?: string,
  success?: string,
) => string {
  return (session, data, error, success) =>
    flashAdminPage(t(titleKey), active)(session, error, success)(
      renderBody(data),
    );
}

/** Curried opener for pages that carry their error/success notices inside a
 *  single `opts` object (the users list and per-user manage pages). Binds the
 *  title and nav highlight, then takes the session plus that opts object, and
 *  returns the page-body receiver — so both pages share the one
 *  `flashAdminPage(...)(session, opts.error, opts.success)(body)` wiring. */
/** The error/success notices a page carries in one bag, so a page function can
 *  take a single `opts` argument instead of positional notice params. */
export type FlashOpts = {
  error?: string | undefined;
  success?: string | undefined;
};

export const flashOptsPage =
  (title: string, active: string) =>
  (session: AdminSession, opts: FlashOpts) =>
  (body: Child): string =>
    flashAdminPage(title, active)(session, opts.error, opts.success)(body);

/** Bind a collection page to its title and nav highlight once. The returned
 *  function renders the whole page from the items it lists, the viewer's
 *  session, and an optional success notice — the exact signature the
 *  list-page routes (groups, logistics) call with. */
export const successListPage =
  <Items,>(
    titleKey: string,
    active: string,
    body: (items: Items, session: AdminSession) => Child,
  ): ((
    items: Items,
    session: AdminSession,
    successMessage?: string,
  ) => string) =>
  (items: Items, session: AdminSession, successMessage?: string): string =>
    successAdminPage(t(titleKey), active)(session, successMessage)(
      body(items, session),
    );

/** A page that edits a many-to-many assignment: given the record, the list of
 *  things it can be assigned to, the currently-selected ids, the viewer's
 *  session and an optional error, it renders the edit page. Shared by the
 *  logistics-agent editor (which users drive an agent) and the user-agents
 *  editor (which agents a user drives) so their identical shape lives in one
 *  type rather than being re-declared per page. */
export type AssignmentEditPage<Record, Item> = (
  record: Record,
  items: Item[],
  selectedIds: ReadonlySet<number>,
  session: AdminSession,
  error?: string,
) => string;

/** The render function a flash-carrying admin page exposes: given the viewer's
 *  session and optional error/success notices, it returns the page HTML. Shared
 *  by the single-form pages here and the recalculate pages. */
export type FlashPageRenderer = (
  session: AdminSession,
  error?: string,
  success?: string,
) => string;

/** Bind a single-form page to its title and nav highlight once. The returned
 *  function renders the whole page from the viewer's session plus the error
 *  and success notices its route passes back after a submit — the shape the
 *  seeds and catalog-import pages share. */
export const flashFormPage =
  (
    titleKey: string,
    active: string,
    body: (session: AdminSession) => Child,
  ): FlashPageRenderer =>
  (session: AdminSession, error?: string, success?: string): string =>
    flashAdminPage(t(titleKey), active)(session, error, success)(body(session));

/** A page for staff and delivery agents alike (the run sheet, the logout
 *  page): Layout + the staff nav, with the bare agent header shown to agent
 *  users instead. `staffHeading` is what non-agent viewers get in the header
 *  spot — the logout page shows an `<h1>`; the run sheet shows nothing. */
export const staffAdminPage = ({
  active,
  children,
  session,
  staffHeading,
  title,
}: {
  active: NavActive;
  children: Child;
  session: AdminSession;
  staffHeading?: Child;
  title: string;
}): string =>
  String(
    <Layout
      beforeContent={<StaffAdminNav active={active} session={session} />}
      title={title}
    >
      {session.adminLevel === "agent" ? (
        <AgentHeader title={title} />
      ) : (
        staffHeading
      )}
      {children}
    </Layout>,
  );
