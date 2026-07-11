import { afterEach, beforeAll } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { attendeeNameMap } from "#shared/db/system-notes.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import { listingLedgerHref } from "#shared/ledger-links.ts";
import { ListingEditPanel } from "#templates/admin/listings/edit-panel.tsx";
import {
  ListingOverviewPanel,
  overviewStatsFromAttendees,
} from "#templates/admin/listings/overview.tsx";
import { ListingRosterPanel } from "#templates/admin/listings/roster.tsx";
import { setTestEnv, setupTestEncryptionKey } from "#test-utils/env.ts";

export const TEST_SESSION = { adminLevel: "owner" as const };

/** Run fn with CAN_BUILD_SITES pinned to `value` in this worker's env overlay
 *  — never the real process env, which every parallel test worker shares. */
export const withBuilderEnv =
  (value: string | undefined) =>
  (fn: () => void): void => {
    const restore = setTestEnv({ CAN_BUILD_SITES: value });
    try {
      fn();
    } finally {
      restore();
    }
  };
export const withBuilder = withBuilderEnv("true");
export const withoutBuilder = withBuilderEnv(undefined);

/** Render the listing detail view the way the entity page composes it: the
 *  Overview panel (details table, income/ledger) plus the Roster panel (attendee
 *  table, filters, failed payments, add-attendee). The legacy `adminListingPage`
 *  composer was removed, so these tests assert against the live panels. */
export const renderListingDetail = (
  opts: Parameters<typeof ListingRosterPanel>[0],
): string =>
  String(
    ListingOverviewPanel({
      aggregateRecalculation: opts.aggregateRecalculation,
      allowedDomain: opts.allowedDomain,
      groupContext: opts.groupContext,
      isChild: opts.isChild,
      isHiddenPackageMember: opts.isHiddenPackageMember,
      ledger: opts.ledger,
      ledgerHref: opts.revenueBreakdown
        ? listingLedgerHref(opts.listing.id)
        : undefined,
      listing: opts.listing,
      // The Overview now takes precomputed stats + note-author names instead of
      // the raw attendee list; derive them from the fixture's attendees so these
      // tests exercise the same rendered output the SQL path produces.
      noteNames: attendeeNameMap(opts.attendees),
      questionData: opts.questionData,
      revenueBreakdown: opts.revenueBreakdown,
      stats: overviewStatsFromAttendees(
        opts.listing,
        opts.attendees,
        opts.paymentReferenceAttendeeIds,
      ),
      systemNotes: opts.systemNotes,
    }),
  ) + String(ListingRosterPanel(opts));

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
    ListingEditPanel({ groups: [], listing, session: TEST_SESSION, ...extra }),
  );

/** Register the beforeAll/afterEach hooks every listing-template test shares. */
export const registerListingTemplateHooks = (): void => {
  beforeAll(async () => {
    setupTestEncryptionKey();
    await signCsrfToken();
  });
  afterEach(() => {
    detectIframeMode(new URL("https://example.com/"));
  });
};
