/**
 * Admin activity log page template
 */

import { joinStrings, map, pipe } from "#fp";
import { formatDatetimeShort } from "#shared/dates.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, EventWithCount } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

const ActivityLogRow = ({ entry }: { entry: ActivityLogEntry }): string =>
  String(
    <tr>
      <td>{formatDatetimeShort(entry.created)}</td>
      <td>{entry.message}</td>
    </tr>,
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
  session: AdminSession,
): string =>
  String(
    <Layout title={`Log: ${event.name}`}>
      <AdminNav active="/admin/log" session={session} />
      <p>
        <a href={`/admin/event/${event.id}`}>&larr; {event.name}</a>
        {" | "}
        <a href="/admin/guide#activity-log">Activity log guide</a>
      </p>
      <div class="table-scroll">
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
      </div>
    </Layout>,
  );

/**
 * Admin global activity log page (all events)
 */
export const adminGlobalActivityLogPage = (
  entries: ActivityLogEntry[],
  truncated = false,
  session: AdminSession,
): string =>
  String(
    <Layout title="Log">
      <AdminNav active="/admin/log" session={session} />
      <p>
        <a href="/admin/guide#activity-log">Activity log guide</a>
      </p>
      <div class="table-scroll">
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
      </div>
      {truncated && <p>Showing the most recent 200 entries.</p>}
    </Layout>,
  );
