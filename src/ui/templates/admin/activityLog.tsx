/**
 * Admin activity log page template
 */

import { joinStrings, map, pipe } from "#fp";
import { t } from "#i18n";
import { attendeeAdminPath } from "#shared/attendee-links.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { SafeHtml } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { ErrorCode, errorCodeLabel } from "#shared/logger.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { GuideLink } from "#templates/components/actions.tsx";
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

/**
 * Display names for the global log's optional Attendee and Listing columns:
 * each map turns a record id into the name shown (and linked) for it. The
 * feature layer builds these — decrypting attendee names with the session key
 * and reading listing names from cache — so the template stays render-only.
 */
export interface ActivityLogRefs {
  attendees: {
    kinds: Map<number, string>;
    names: Map<number, string>;
  };
  listings: Map<number, string>;
}

/**
 * Cell content linking a log entry to an attendee/listing detail page, with the
 * record's name as the link text. Renders nothing (an empty cell) when the entry
 * has no such id, or when the id points at a record that no longer exists — a
 * deleted attendee keeps its log rows, so its id can outlive the attendee.
 */
const refLink = (
  id: number | null,
  names: Map<number, string>,
  base: string,
): JSX.Element | null => {
  if (id === null) return null;
  const name = names.get(id);
  return name === undefined ? null : <a href={`${base}/${id}`}>{name}</a>;
};

const attendeeRefLink = (
  id: number | null,
  refs: ActivityLogRefs["attendees"],
): JSX.Element | null => {
  if (id === null) return null;
  const name = refs.names.get(id);
  const kind = refs.kinds.get(id);
  return name === undefined || kind === undefined ? null : (
    <a href={attendeeAdminPath({ id, kind })}>{name}</a>
  );
};

const ActivityLogRow = ({
  entry,
  refs,
}: {
  entry: ActivityLogEntry;
  refs?: ActivityLogRefs;
}): string =>
  String(
    <tr>
      <td>{formatDatetimeShort(entry.created)}</td>
      <td>
        {entry.message.includes(SQUARE_SIGNATURE_LABEL) ? (
          <SquareSignatureHint />
        ) : null}
        {entry.message}
      </td>
      {refs ? (
        <>
          <td>{attendeeRefLink(entry.attendee_id, refs.attendees)}</td>
          <td>{refLink(entry.listing_id, refs.listings, "/admin/listing")}</td>
        </>
      ) : null}
    </tr>,
  );

/** Generate activity log table rows */
const activityLogRows = (
  entries: ActivityLogEntry[],
  refs?: ActivityLogRefs,
): string =>
  entries.length > 0
    ? pipe(
        map((entry: ActivityLogEntry) => ActivityLogRow({ entry, refs })),
        joinStrings,
      )(entries)
    : `<tr><td colspan="${refs ? 4 : 2}">${t("admin.log.no_activity")}</td></tr>`;

/**
 * The Time/Activity log table, scrollable on narrow screens. Shared by the
 * listing and global log pages and the per-attendee log section. Passing `refs`
 * (only the global log does) appends Attendee and Listing columns that link
 * each entry to its records; the listing and attendee views omit them, since
 * there every row already shares the same listing or attendee.
 */
export const ActivityLogTable = ({
  entries,
  refs,
}: {
  entries: ActivityLogEntry[];
  refs?: ActivityLogRefs;
}): JSX.Element => (
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>{t("admin.log.col.time")}</th>
          <th>{t("admin.log.col.activity")}</th>
          {refs ? (
            <>
              <th>{t("terms.attendee")}</th>
              <th>{t("terms.listing")}</th>
            </>
          ) : null}
        </tr>
      </thead>
      <tbody>
        <Raw html={activityLogRows(entries, refs)} />
      </tbody>
    </table>
  </div>
);

/**
 * Admin activity log page for a specific listing
 */
export const adminListingActivityLogPage = (
  listing: ListingWithCount,
  entries: ActivityLogEntry[],
  session: AdminSession,
): string =>
  String(
    <Layout title={`${t("admin.log.heading")}: ${listing.name}`}>
      <AdminNav active="/admin/log" session={session} />
      <p class="actions">
        <a href={`/admin/listing/${listing.id}`}>&larr; {listing.name}</a>
        <GuideLink href="/admin/guide#activity-log">
          Activity log guide
        </GuideLink>
      </p>
      <ActivityLogTable entries={entries} />
    </Layout>,
  );

/**
 * Admin global activity log page (all listings)
 */
export const adminGlobalActivityLogPage = (
  entries: ActivityLogEntry[],
  truncated = false,
  session: AdminSession,
  refs: ActivityLogRefs,
): string =>
  String(
    <Layout title={t("admin.log.heading")}>
      <AdminNav active="/admin/log" session={session} />
      <p class="actions">
        <GuideLink href="/admin/guide#activity-log">
          Activity log guide
        </GuideLink>
      </p>
      <ActivityLogTable entries={entries} refs={refs} />
      {truncated && <p>{t("admin.log.recent_entries")}</p>}
    </Layout>,
  );
