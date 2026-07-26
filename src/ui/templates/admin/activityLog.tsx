/**
 * Admin activity log page template
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { attendeeAdminPath } from "#shared/attendee-links.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { Child, SafeHtml } from "#shared/jsx/jsx-runtime.ts";
import { ErrorCode, errorCodeLabel } from "#shared/logger.ts";
import { requireValue } from "#shared/required-value.ts";
import { defineTable } from "#shared/tables/definition.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { renderTable } from "#templates/components/table.tsx";

/* jscpd:ignore-end */

/** The "Activity log guide" link shown at the bottom of both activity-log
 *  pages. */
const activityLogGuide = (
  <GuideFooter href="/admin/guide#activity-log">
    {t("admin.log.guide_link")}
  </GuideFooter>
);

/** Curried `String(<AdminPage active="/admin/log" session=session
 *  title={title}>{body}{guide})`. The two activity-log pages (per-listing and
 *  global) share this opener + guide footer. */
const activityLogPage =
  (title: string) =>
  (session: AdminSession) =>
  (body: Child): string =>
    String(
      <AdminPage active="/admin/log" session={session} title={title}>
        {body}
        {activityLogGuide}
      </AdminPage>,
    );

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
      {t("admin.log.square_signature_hint")}
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
/** Link an id to its detail page, or render nothing when the id is absent —
 * a deleted attendee keeps its log rows, so its id can outlive the record. */
const idLink = (
  id: number | null,
  buildLink: (id: number) => JSX.Element | null,
): JSX.Element | null => (id === null ? null : buildLink(id));

/** Link an id to its detail page from a looked-up value, rendering nothing when
 *  the id is absent or no value was loaded for it. `lookup` returns whatever the
 *  link text/target needs (a name, or a name+kind pair), and `anchor` turns the
 *  id and that value into the link. */
const namedRefLink = <Value,>(
  id: number | null,
  lookup: (id: number) => Value | undefined,
  anchor: (id: number, value: Value) => JSX.Element,
): JSX.Element | null =>
  idLink(id, (id) => {
    const value = lookup(id);
    return value === undefined ? null : anchor(id, value);
  });

const refLink = (
  id: number | null,
  names: Map<number, string>,
  base: string,
): JSX.Element | null =>
  namedRefLink(
    id,
    (id) => names.get(id),
    (id, name) => <a href={`${base}/${id}`}>{name}</a>,
  );

const attendeeRefLink = (
  id: number | null,
  refs: ActivityLogRefs["attendees"],
): JSX.Element | null =>
  namedRefLink(
    id,
    // A deleted attendee can be missing its name or its kind; skip the link
    // unless both are present.
    (id) => {
      const name = refs.names.get(id);
      const kind = refs.kinds.get(id);
      return name === undefined || kind === undefined
        ? undefined
        : { kind, name };
    },
    (id, { kind, name }) => (
      <a href={attendeeAdminPath({ id, kind })}>{name}</a>
    ),
  );

const activityLogTable = defineTable<
  ActivityLogEntry,
  ActivityLogRefs | undefined
>([
  {
    cell: (entry) => formatDatetimeShort(entry.created),
    header: () => t("admin.log.col.time"),
    key: "time",
  },
  {
    cell: (entry) => (
      <>
        {entry.message.includes(SQUARE_SIGNATURE_LABEL) ? (
          <SquareSignatureHint />
        ) : null}
        {entry.message}
      </>
    ),
    header: () => t("admin.log.col.activity"),
    key: "activity",
  },
  {
    cell: (entry, refs) =>
      attendeeRefLink(
        entry.attendee_id,
        requireValue(refs, "Activity attendee column requires references")
          .attendees,
      ),
    header: () => t("terms.attendee"),
    key: "attendee",
  },
  {
    cell: (entry, refs) =>
      refLink(
        entry.listing_id,
        requireValue(refs, "Activity listing column requires references")
          .listings,
        "/admin/listing",
      ),
    header: () => t("terms.listing"),
    key: "listing",
  },
]);

const ACTIVITY_COLUMNS = ["time", "activity"] as const;

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
}): JSX.Element =>
  renderTable(activityLogTable, entries, {
    columnKeys: refs === undefined ? ACTIVITY_COLUMNS : undefined,
    context: refs,
    empty: t("admin.log.no_activity"),
  });

/**
 * Admin activity log page for a specific listing
 */
export const adminListingActivityLogPage = (
  listing: ListingWithCount,
  entries: ActivityLogEntry[],
  session: AdminSession,
): string =>
  activityLogPage(`${t("admin.log.heading")}: ${listing.name}`)(session)(
    <ActivityLogTable entries={entries} />,
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
  activityLogPage(t("admin.log.heading"))(session)(
    <>
      <ActivityLogTable entries={entries} refs={refs} />
      {truncated && <p>{t("admin.log.recent_entries")}</p>}
    </>,
  );
