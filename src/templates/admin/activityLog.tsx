/**
 * Admin activity log page template
 */

import { map, pipe, reduce } from "#fp";
import type { ActivityLogEntry } from "#lib/db/activityLog.ts";
import type { AdminLevel, EventWithCount } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

const ActivityLogRow = ({ entry }: { entry: ActivityLogEntry }): string =>
  String(
    <tr>
      <td>{new Date(entry.created).toLocaleString()}</td>
      <td>{entry.message}</td>
    </tr>
  );

/** Generate activity log table rows */
const activityLogRows = (entries: ActivityLogEntry[]): string =>
  entries.length > 0
    ? pipe(
        map((entry: ActivityLogEntry) => ActivityLogRow({ entry })),
        joinStrings,
      )(entries)
    : '<tr><td colspan="2">No activity recorded yet</td></tr>';

/**
 * Admin activity log page for a specific event
 */
export const adminEventActivityLogPage = (
  event: EventWithCount,
  entries: ActivityLogEntry[],
  adminLevel?: AdminLevel,
): string =>
  String(
    <Layout title={`Log: ${event.name}`}>
      <AdminNav adminLevel={adminLevel} />
        <h2>Log</h2>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Activity</th>
            </tr>
          </thead>
          <tbody>
            <Raw html={activityLogRows(entries)} />
          </tbody>
        </table>
    </Layout>
  );

/**
 * Admin global activity log page (all events)
 */
export const adminGlobalActivityLogPage = (
  entries: ActivityLogEntry[],
  truncated = false,
  adminLevel?: AdminLevel,
): string =>
  String(
    <Layout title="Log">
      <AdminNav adminLevel={adminLevel} />
        <h2>Log</h2>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Activity</th>
            </tr>
          </thead>
          <tbody>
            <Raw html={activityLogRows(entries)} />
          </tbody>
        </table>
        {truncated && <p>Showing the most recent 200 entries.</p>}
    </Layout>
  );
