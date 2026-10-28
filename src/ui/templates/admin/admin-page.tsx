/**
 * The admin-page openers: the families every admin page opens through. Each
 * renders via the AdminPageSpec module's renderer. The edit-panel and
 * listing-link helpers the page modules share also live here.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import type {
  AdminPathParams,
  AdminRecordDestinationId,
} from "#shared/admin-surface/ids.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { Flash } from "#shared/forms/flash.tsx";
import {
  type AdminPageListPart,
  type FlashPageRenderer,
  renderAdminPageSpec,
} from "#templates/admin/admin-page-spec.tsx";
import type { NavActive } from "#templates/admin/nav.tsx";
import { linkCell } from "#templates/components/link-cell.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import type { AdminSession } from "#types";
/* jscpd:ignore-end */

/** A link to a listing's admin page showing its name. Owned here so the same
 *  admin listing link is not re-authored across the attendee form and the
 *  booking-QR page. */
export const adminListingLink = linkCell(
  (listing: { id: number; name: string }) => `/admin/listing/${listing.id}`,
  (listing) => listing.name,
);

/** Render an admin page to an HTML string with no flash — the plain wrapper
 *  the confirm pages, the bulk-email page, the Site-tab collection pages, and
 *  the API-keys pages share. */
export const renderAdminPage = (
  active: NavActive,
  session: AdminSession,
  title: string,
  children: Child,
): string => openWithNotices(active, title, children, session);

/** The one notice-carrying page render the openers share: the spec's flash
 *  bag carries whatever the route passed back, and an empty bag renders no
 *  notice at all. */
const openWithNotices = (
  active: NavActive,
  title: string,
  body: Child,
  session: AdminSession,
  error?: string | undefined,
  success?: string | undefined,
): string =>
  renderAdminPageSpec({
    active,
    body,
    flash: { error, success },
    session,
    title,
  });

/** CRUD edit-page admin opener: takes the page title (and optional `active`),
 *  returns a function taking (session, error) and producing a page-body
 *  receiver. Renders an error Flash when error is set; otherwise no Flash.
 *  Used by the holiday/logistics edit pages. */
const errorFlash = (error?: string): JSX.Element | null =>
  error === undefined ? null : <Flash error={error} />;

/** Wrap an entity edit panel with its optional rejected-form error. */
export const editPanel =
  (error?: string) =>
  (children: Child): JSX.Element => (
    <>
      {errorFlash(error)}
      {children}
    </>
  );

/** The Edit tab of a record page: the save form posting to the route that
 * edits that record, with any rejection message above it. Naming the route
 * once keeps the panel and the handler on the same path. */
export const recordEditPanel =
  <Id extends AdminRecordDestinationId>(route: Id, submitLabel: Child) =>
  (id: number, error: string | undefined, fields: Child): JSX.Element =>
    editPanel(error)(
      <SaveForm
        action={adminPath(route, { id } as AdminPathParams<Id>)}
        submitLabel={submitLabel}
      >
        {fields}
      </SaveForm>,
    );

/** The detail, edit, and guard pages: one error notice over a bespoke body.
 *  Binds the title and nav link once; the renderer takes the viewer and the
 *  rejection notice, then the body. */
export const errorAdminPage =
  (title: string, active: NavActive) =>
  (session: AdminSession, error: string | undefined) =>
  (body: Child): string =>
    openWithNotices(active, title, body, session, error);

/** Bind a dashboard page to its title, nav link, and a body built from the
 *  loaded data; the renderer carries the notices its route passes back — the
 *  shape the backup and update dashboards share. */
export function flashDataPage<Data>(
  titleKey: string,
  active: string | undefined,
  renderBody: (data: Data) => Child,
): (
  session: AdminSession,
  data: Data,
  error?: string,
  success?: string,
) => string {
  return (session, data, error, success) =>
    openWithNotices(
      active ?? "/admin/settings",
      t(titleKey),
      renderBody(data),
      session,
      error,
      success,
    );
}

/** The pages that carry their error/success notices in one opts bag (the
 *  users list, the site tab). Binds the title and nav highlight once. */
export const flashOptsPage =
  (title: string, active: string) =>
  (
    session: AdminSession,
    opts: { error?: string | undefined; success?: string | undefined },
    body: Child,
  ): string =>
    openWithNotices(active, title, body, session, opts.error, opts.success);

/** Bind a list page to its title, nav link, and the spec's list part; the
 *  renderer builds the table-or-empty body and carries a write's success
 *  notice — the exact signature the list-page routes call with. */
export const successListPage =
  <TItem, TContext = undefined>(
    titleKey: string,
    active: NavActive,
    list: (
      items: TItem[],
      session: AdminSession,
    ) => AdminPageListPart<TItem, TContext>,
  ): ((
    items: TItem[],
    session: AdminSession,
    successMessage?: string,
  ) => string) =>
  (items, session, successMessage) =>
    renderAdminPageSpec({
      active,
      flash: { success: successMessage },
      list: list(items, session),
      session,
      title: t(titleKey),
    });

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

/** Bind a single-form page to its title and nav highlight once; the renderer
 *  takes the viewer's session plus the error and success notices its route
 *  passes back — the shape the seeds and catalog-import pages share. */
export const flashFormPage =
  (
    titleKey: string,
    active: string,
    body: (session: AdminSession) => Child,
  ): FlashPageRenderer =>
  (session, error, success) =>
    openWithNotices(
      active,
      t(titleKey),
      body(session),
      session,
      error,
      success,
    );
