import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { successAdminPage } from "#templates/admin/admin-page.tsx";

export const AdminListPage = ({
  active,
  actions,
  children,
  session,
  successMessage,
  title,
}: {
  active: string;
  actions: Child;
  children: Child;
  session: AdminSession;
  successMessage?: string | undefined;
  title: string;
}): string =>
  successAdminPage(title, active)(session, successMessage)(
    <>
      <p class="actions">{actions}</p>
      {children}
    </>,
  );
