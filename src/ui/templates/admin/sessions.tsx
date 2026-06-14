/**
 * Admin sessions page template
 */

import { joinStrings, map, pipe } from "#fp";
import { formatDatetimeShort } from "#shared/dates.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, Session } from "#shared/types.ts";
import { AdminNav, UsersSubNav } from "#templates/admin/nav.tsx";
import { GuideLink } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

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
      <td>{isCurrent ? <mark>Current</mark> : ""}</td>
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
      : '<tr><td colspan="3">No sessions</td></tr>';

  const otherSessionCount = sessions.filter(
    (s) => s.token !== currentToken,
  ).length;

  return String(
    <Layout title="Sessions">
      <AdminNav active="/admin/users" session={adminSession} />
      <UsersSubNav />

      <Flash success={success} />

      <p class="actions">
        <GuideLink href="/admin/guide#login">Sessions guide</GuideLink>
      </p>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>Expires</th>
              <th>Status</th>
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
            <button class="danger" type="submit">
              Log out of all other sessions ({otherSessionCount})
            </button>
          </CsrfForm>
        </>
      )}
    </Layout>,
  );
};
