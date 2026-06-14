/**
 * Admin activity log page template
 */

import { joinStrings, map, pipe } from "#fp";
import { formatDatetimeShort } from "#shared/dates.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { SafeHtml } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { ErrorCode, errorCodeLabel } from "#shared/logger.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** Label of the Square signature error, used to spot it in log messages */
const SQUARE_SIGNATURE_LABEL = errorCodeLabel[ErrorCode.SQUARE_SIGNATURE];

/**
 * Hint prepended to Square webhook signature failures: these almost always
 * mean a mis-pasted Square credential that the owner needs to re-enter, so we
 * link straight to the relevant settings.
 */
const SquareSignatureHint = (): SafeHtml => (
  <>
    <a href="/admin/settings#settings-square-webhook">
      Click here to re-do your Square settings, paying close attention to the
      name of each field.
    </a>{" "}
  </>
);

const ActivityLogRow = ({ entry }: { entry: ActivityLogEntry }): string =>
  String(
    <tr>
      <td>{formatDatetimeShort(entry.created)}</td>
      <td>
        {entry.message.includes(SQUARE_SIGNATURE_LABEL) ? (
          <SquareSignatureHint />
        ) : null}
        {entry.message}
      </td>
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
 * Admin activity log page for a specific listing
 */
export const adminListingActivityLogPage = (
  listing: ListingWithCount,
  entries: ActivityLogEntry[],
  session: AdminSession,
): string =>
  String(
    <Layout title={`Log: ${listing.name}`}>
      <AdminNav active="/admin/log" session={session} />
      <p>
        <a href={`/admin/listing/${listing.id}`}>&larr; {listing.name}</a>
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
 * Admin global activity log page (all listings)
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
