/**
 * The admin page spec and its renderer: the one typed schema every admin page
 * fills in, rendered through the shell (AdminPage) defined in admin-page.tsx.
 * The legacy openers in admin-page.tsx rewire to this module layer by layer.
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
import { defineTable } from "#shared/tables/definition.ts";
import {
  AdminPage,
  FormHeader,
  flashProps,
} from "#templates/admin/admin-page.tsx";
import { AgentHeader } from "#templates/admin/agent-header.tsx";
import { type NavActive, StaffAdminNav } from "#templates/admin/nav.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { Layout } from "#templates/layout.tsx";
import type { AdminSession, Theme } from "#types";
/* jscpd:ignore-end */

/** The standard list body: intro, then the table or its empty note, then the
 *  guide footer. */
export type AdminPageListPart<TItem> = {
  intro?: Child;
  items: TItem[];
  columns: readonly TableColumn<TItem>[];
  empty: Child;
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
export type AdminPageSpec<TItem = never> = {
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
  list?: AdminPageListPart<TItem>;
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
const listBody = <TItem,>(list: AdminPageListPart<TItem>): JSX.Element => (
  <>
    {list.intro}
    {list.items.length > 0
      ? renderTable(defineTable(list.columns), list.items, {
          ...(list.reorder !== undefined ? { reorder: list.reorder } : {}),
        })
      : list.empty}
    {list.guideFooter}
  </>
);

/** Open an admin page from its spec — the one render function every admin
 *  page goes through. */
export const renderAdminPageSpec = <TItem,>(
  spec: AdminPageSpec<TItem>,
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
