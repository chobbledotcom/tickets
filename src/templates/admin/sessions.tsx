/**
 * Admin sessions page template
 */

import { map, pipe, reduce } from "#fp";
import { CsrfForm } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession, Session } from "#lib/types.ts";
import { t } from "#i18n";
import { AdminNav, UsersSubNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

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
      <td>{new Date(session.expires).toLocaleString()}</td>
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
            SessionRow({ session: s, isCurrent: s.token === currentToken }),
          ),
          joinStrings,
        )(sessions)
      : `<tr><td colspan="3">${t("sessions.no_sessions")}</td></tr>`;

  const otherSessionCount = sessions.filter(
    (s) => s.token !== currentToken,
  ).length;

  return String(
    <Layout title={t("sessions.title")}>
      <AdminNav session={adminSession} active="/admin/users" />
      <UsersSubNav />

      {success && <div class="success">{success}</div>}

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("sessions.col.token")}</th>
              <th>{t("sessions.col.expires")}</th>
              <th>{t("sessions.col.status")}</th>
            </tr>
          </thead>
          <tbody>
            <Raw html={sessionRows} />
          </tbody>
        </table>
      </div>

      {otherSessionCount > 0 && (
        <>
          <br />

          <CsrfForm action="/admin/sessions" class="one-button">
            <button type="submit" class="danger">
              {t("sessions.logout_others", { count: otherSessionCount })}
            </button>
          </CsrfForm>
        </>
      )}
    </Layout>,
  );
};
