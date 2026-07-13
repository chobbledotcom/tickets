/**
 * Admin sessions page template
 */

/* jscpd:ignore-start */
import { joinStrings, map, pipe } from "#fp";
import { t } from "#i18n";
import { formatDatetimeShort } from "#shared/dates.ts";
import type { AdminSession, Session } from "#shared/types.ts";
import { successAdminPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { DataTable, textCol } from "#templates/components/data-table.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";

/* jscpd:ignore-end */

const SessionRow = ({
  session,
  isCurrent,
}: {
  session: Session;
  isCurrent: boolean;
}): string =>
  String(
    <tr>
      <td>{session.token.slice(0, 8)}...</td>
      <td>{formatDatetimeShort(new Date(session.expires).toISOString())}</td>
      <td>{isCurrent ? <mark>{t("sessions.current")}</mark> : ""}</td>
    </tr>,
  );

/**
 * Admin sessions page
 */
export const adminSessionsPage = (
  sessions: Session[],
  currentToken: string,
  adminSession: AdminSession,
  success?: string,
): string => {
  const sessionRows =
    sessions.length > 0
      ? pipe(
          map((s: Session) =>
            SessionRow({ isCurrent: s.token === currentToken, session: s }),
          ),
          joinStrings,
        )(sessions)
      : `<tr><td colspan="3">${t("sessions.no_sessions")}</td></tr>`;

  const otherSessionCount = sessions.filter(
    (s) => s.token !== currentToken,
  ).length;

  return successAdminPage(t("sessions.title"), "/admin/sessions")(
    adminSession,
    success,
  )(
    <>
      <DataTable
        columns={[
          textCol("sessions.col.token"),
          textCol("sessions.col.expires"),
          textCol("common.status"),
        ]}
        rows={sessionRows}
      />

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
