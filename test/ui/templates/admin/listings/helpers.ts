import { afterEach, beforeAll } from "@std/testing/bdd";
import { fieldById } from "#fp";
import { rosterListSetup } from "#routes/admin/listings-view.ts";
import type {
  AttendeeFilter,
  AttendeeSort,
  DateOption,
} from "#shared/attendee-list-controls.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import { listingLedgerHref } from "#shared/ledger-links.ts";
import { ListingEditPanel } from "#templates/admin/listings/edit-panel.tsx";
import {
  ListingOverviewPanel,
  overviewStatsFromAttendees,
} from "#templates/admin/listings/overview.tsx";
import { ListingRosterPanel } from "#templates/admin/listings/roster.tsx";
import type { RosterListView } from "#templates/admin/listings/types.ts";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";

/** Run fn with CAN_BUILD_SITES pinned to `value` in this worker's env overlay
 *  — never the real process env, which every parallel test worker shares. */
export const withBuilderEnv =
  (value: string | undefined): ((fn: () => void) => void) =>
  (fn: () => void): void => {
    using _env = withEnv({ CAN_BUILD_SITES: value });
    fn();
  };
export const withBuilder = withBuilderEnv("true");
export const withoutBuilder = withBuilderEnv(undefined);

/** The roster options with the filter/sort choices written the way the old
 *  panel took them, so fixture-building tests stay terse: the helper builds
 *  the shared list view (setup + state) from them. */
type DetailOptions = Omit<
  Parameters<typeof ListingRosterPanel>[0],
  "list" | "isOwner"
> & {
  activeFilter?: AttendeeFilter;
  dateFilter?: string | null;
  sort?: AttendeeSort | null;
  availableDates?: DateOption[];
  isOwner?: boolean;
};

const rosterListViewOf = (opts: DetailOptions): RosterListView => ({
  setup: rosterListSetup(opts.listing, opts.availableDates ?? []),
  state: {
    checkin: opts.activeFilter ?? "all",
    date: opts.dateFilter ?? null,
    listingId: null,
    page: 0,
    sort: opts.sort ?? null,
    type: "all",
  },
});

/** Render the listing detail view the way the entity page composes it: the
 *  Overview panel (details table, income/ledger) plus the Roster panel (attendee
 *  table, filters, failed payments, add-attendee). The legacy `adminListingPage`
 *  composer was removed, so these tests assert against the live panels. */
export const renderListingDetail = (opts: DetailOptions): string =>
  String(
    ListingOverviewPanel({
      aggregateRecalculation: opts.aggregateRecalculation,
      allowedDomain: opts.allowedDomain,
      groupContext: opts.groupContext,
      isChild: opts.isChild,
      isHiddenPackageMember: opts.isHiddenPackageMember,
      isOwner: opts.isOwner ?? false,
      ledgerHref: opts.moneyTotals
        ? listingLedgerHref(opts.listing.id)
        : undefined,
      listing: opts.listing,
      moneyTotals: opts.moneyTotals,
      // The Overview now takes precomputed stats + note-author names instead of
      // the raw attendee list; derive them from the fixture's attendees so these
      // tests exercise the same rendered output the SQL path produces.
      noteNames: fieldById("name")(opts.attendees),
      questionData: opts.questionData,
      stats: overviewStatsFromAttendees(
        opts.listing,
        opts.attendees,
        opts.paymentReferenceAttendeeIds,
      ),
      systemNotes: opts.systemNotes,
    }),
  ) +
  String(
    ListingRosterPanel({
      ...opts,
      isOwner: opts.isOwner ?? false,
      list: rosterListViewOf(opts),
    }),
  );

/** Render the listing detail view with the common defaults (localhost domain,
 *  no attendees); pass `extra` to override attendees, filters, ledger, etc. */
export const detailHtml = (
  listing: Parameters<typeof renderListingDetail>[0]["listing"],
  extra: Partial<Parameters<typeof renderListingDetail>[0]> = {},
): string =>
  renderListingDetail({
    allowedDomain: "localhost",
    attendees: [],
    listing,
    ...extra,
  });

/** Render the listing edit panel for `listing` with the shared session and no
 *  groups; pass `extra` for errors, selected groups, or aggregate mismatches. */
export const editPanelHtml = (
  listing: Parameters<typeof ListingEditPanel>[0]["listing"],
  extra: Partial<Parameters<typeof ListingEditPanel>[0]> = {},
): string =>
  String(
    ListingEditPanel({ groups: [], listing, session: OWNER_SESSION, ...extra }),
  );

/** Register the beforeAll/afterEach hooks every listing-template test shares.
 * Call it as the first statement INSIDE each top-level describe — at module
 * level it would register *global* hooks, which cannot be added once any
 * other module's tests exist (files share an isolate under the grouped
 * runner). */
export const registerListingTemplateHooks = (): void => {
  beforeAll(setupAdminPageTest);
  afterEach(() => {
    detectIframeMode(new URL("https://example.com/"));
  });
};
