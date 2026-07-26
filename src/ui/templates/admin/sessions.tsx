/**
 * Admin sessions page template
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { formatDatetimeShort } from "#shared/dates.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import type { AdminSession, Session } from "#shared/types.ts";
import { successAdminPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";

/* jscpd:ignore-end */

const sessionColumns: readonly TableColumn<Session, string>[] = [
  {
    cell: (session) => `${session.token.slice(0, 8)}...`,
    header: t("sessions.col.token"),
    key: "token",
  },
  {
    cell: (session) =>
      formatDatetimeShort(new Date(session.expires).toISOString()),
    header: t("sessions.col.expires"),
    key: "expires",
  },
  {
    cell: (session, currentToken) =>
      session.token === currentToken ? (
        <mark>{t("sessions.current")}</mark>
      ) : (
        ""
      ),
    header: t("common.status"),
    key: "status",
  },
];

const sessionsTable = defineTable(sessionColumns);

/**
 * Admin sessions page
 */
export const adminSessionsPage = (
  sessions: Session[],
  currentToken: string,
  adminSession: AdminSession,
  success?: string,
): string => {
  const otherSessionCount = sessions.filter(
    (s) => s.token !== currentToken,
  ).length;

  return successAdminPage(t("sessions.title"), "/admin/sessions")(
    adminSession,
    success,
  )(
    <>
      {renderTable(sessionsTable, sessions, {
        context: currentToken,
        empty: <Raw html={t("sessions.no_sessions")} />,
      })}

      {otherSessionCount > 0 && (
        <>
          <br />

          <SaveForm
            action="/admin/sessions"
            class="one-button"
            submitClass="danger"
            submitIcon="log-out"
            submitLabel={t("sessions.logout_others", {
              count: otherSessionCount,
            })}
          />
        </>
      )}

      <GuideFooter href="/admin/guide#login">Sessions guide</GuideFooter>
    </>,
  );
};
