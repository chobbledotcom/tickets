/**
 * Admin sessions page template
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { successAdminPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import type { AdminSession, Session } from "#types";

/* jscpd:ignore-end */

const sessionColumns: readonly TableColumn<Session, string>[] = [
  translatedTableColumn(
    "token",
    "sessions.col.token",
    (session) => `${session.token.slice(0, 8)}...`,
  ),
  translatedTableColumn("expires", "sessions.col.expires", (session) =>
    formatDatetimeShort(new Date(session.expires).toISOString()),
  ),
  translatedTableColumn("status", "common.status", (session, currentToken) =>
    session.token === currentToken ? <mark>{t("sessions.current")}</mark> : "",
  ),
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
