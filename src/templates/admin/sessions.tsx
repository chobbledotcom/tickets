/**
 * Admin sessions page template
 */

import { map, pipe, reduce } from "#fp";
import type { Session } from "#lib/types.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { Layout } from "../layout.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

const SessionRow = ({
  session,
  isCurrent,
}: {
  session: Session;
  isCurrent: boolean;
}): string =>
  String(
    <tr style={isCurrent ? "font-weight: bold;" : ""}>
      <td>{session.token.slice(0, 8)}...</td>
      <td>{new Date(session.expires).toLocaleString()}</td>
      <td>{isCurrent ? "Current" : ""}</td>
    </tr>
  );

/**
 * Admin sessions page
 */
export const adminSessionsPage = (
  sessions: Session[],
  currentToken: string,
  csrfToken: string,
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
    <Layout title="Admin Sessions">
      <h1>Sessions</h1>
      <p><a href="/admin/">&larr; Back to Dashboard</a></p>

      {success && <div class="success">{success}</div>}

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

      {otherSessionCount > 0 && (
        <form method="POST" action="/admin/sessions" style="margin-top: 1rem;">
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <button type="submit" style="background: #c00; border-color: #900;">
            Log out of all other sessions ({otherSessionCount})
          </button>
        </form>
      )}
    </Layout>
  );
};
