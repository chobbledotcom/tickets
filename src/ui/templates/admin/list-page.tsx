/* jscpd:ignore-start */
import type { Child } from "#jsx/jsx-runtime.ts";
import { successAdminPage } from "#templates/admin/admin-page.tsx";
import type { AdminSession } from "#types";
/* jscpd:ignore-end */

export const AdminListPage = ({
  active,
  actions,
  children,
  session,
  successMessage,
  title,
}: {
  active: string;
  /** Optional top action row. Omit on pages whose only affordance is a guide
   *  link (that now lives in a `GuideFooter` at the bottom of the body). The
   *  action-row scaffold is owned by `AdminPage` (via the curried opener), so
   *  we forward `actions` rather than re-authoring the `<p class="actions">`. */
  actions?: Child;
  children: Child;
  session: AdminSession;
  successMessage?: string | undefined;
  title: string;
}): string =>
  successAdminPage(title, active)(session, successMessage)(children, actions);
