/**
 * Admin sessions page template
 */

import { map, pipe, reduce } from "#fp";
import type { AdminSession, Session } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

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
      <td>{isCurrent ? <mark>Current</mark> : ""}</td>
    </tr>
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
      : '<tr><td colspan="3">No sessions</td></tr>';

  const otherSessionCount = sessions.filter(
    (s) => s.token !== currentToken,
  ).length;

  return String(
    <Layout title="Sessions">
      <AdminNav session={adminSession} />

      {success && <div class="success">{success}</div>}

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

            <form method="POST" action="/admin/sessions" class="one-button">
              <input type="hidden" name="csrf_token" value={adminSession.csrfToken} />
              <button type="submit" class="danger">
                Log out of all other sessions ({otherSessionCount})
              </button>
            </form>
        </>
      )}
    </Layout>
  );
};
