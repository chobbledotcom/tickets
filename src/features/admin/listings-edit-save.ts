/**
 * The listing edit tab's save path: aggregate parsing, duration-change
 * reconciliation, and the in-place error re-render.
 *
 * `handleAdminListingEditPost` in `listings-edit.ts` wires these to the route,
 * so a rejected edit keeps the operator's submitted group selection and an
 * accepted edit replays booked ranges with a group-capacity warning.
 */

import { logActivity } from "#db/activity-log.ts";
import {
  checkGroupCapAfterDurationChange,
  recomputeListingBookingRanges,
} from "#db/attendees/update.ts";
import { listingGroups } from "#db/groups/table.ts";
import {
  type ListingAggregateValues,
  listingAggregates,
} from "#db/listings/aggregates.ts";
import { parseEditableAggregateForm } from "#routes/admin/aggregate-recalculation.ts";
import {
  type EditErrorRenderer,
  editErrorRenderer,
} from "#routes/admin/entity-write-tab.ts";
import { entityReturnPath } from "#shared/admin-pages.ts";
import type { FormParams } from "#shared/form-data.ts";
import { getListingAggregateFields } from "#templates/fields/aggregate.ts";
import type { AdminSession, Listing, ListingWithCount } from "#types";
import { listingPage } from "./listing-page.ts";
import { loadListingEditPanel } from "./listing-page-management-panels.ts";
import { parseGroupIds } from "./listings-form.ts";
import { processUploadsAndRedirect } from "./listings-uploads.ts";

/** The earliest over-capacity day across every group the listing belongs to,
 * or null when all groups fit. Booking ranges were already recomputed by the
 * caller, so each group is swept as its rows now stand. */
export const earliestGroupCapOverflow = async (
  listingId: number,
): Promise<string | null> => {
  let earliest: string | null = null;
  for (const groupId of await listingGroups.getIds(listingId)) {
    const overDay = await checkGroupCapAfterDurationChange(listingId, groupId);
    if (overDay && (earliest === null || overDay < earliest)) {
      earliest = overDay;
    }
  }
  return earliest;
};

const reconcileDurationChange = async (
  row: {
    id: number;
    name: string;
    listing_type: string;
    customisable_days: boolean;
    duration_days: number;
  },
  previousDurationDays: number,
): Promise<string> => {
  if (row.listing_type !== "daily") return "";
  // For customisable-days listings each booking has its own visitor-chosen
  // span, so `duration_days` is only the maximum offered to new bookings —
  // never rewrite existing bookings' stored ranges from it.
  if (row.customisable_days) return "";
  if (row.duration_days === previousDurationDays) return "";

  await recomputeListingBookingRanges(row.id, row.duration_days);
  await logActivity(
    `Listing '${row.name}' duration changed to ${row.duration_days} day(s)`,
    row,
  );
  const overDay = await earliestGroupCapOverflow(row.id);
  if (!overDay) return "";
  await logActivity(
    `Duration change caused group capacity overflow on ${overDay}`,
    row,
  );
  return ` Warning: group capacity exceeded on ${overDay}`;
};

/** Re-render the Edit tab in place at 400 with the submitted error and the
 * operator's submitted group selection (not the saved set), so a rejected edit
 * doesn't silently drop their group changes. Deterministic — no flash stash. */
export const renderListingEditError: EditErrorRenderer = editErrorRenderer(
  () => listingPage,
  "edit",
  (entity, ctx, rejected) =>
    loadListingEditPanel(
      entity,
      ctx,
      rejected.error,
      parseGroupIds(rejected.form),
    ),
);

export const handleListingEditSuccess = async (
  row: Listing,
  existing: ListingWithCount,
  aggregateValues: ListingAggregateValues | null,
  formData: FormData,
  id: number,
): Promise<Response> => {
  if (aggregateValues) {
    await listingAggregates.update(id, aggregateValues);
  }
  const durationWarning = await reconcileDurationChange(
    row,
    existing.duration_days,
  );
  await logActivity(`Listing '${row.name}' updated`, row);
  return processUploadsAndRedirect(
    formData,
    id,
    entityReturnPath("/admin/listings", row.id),
    `Listing updated${durationWarning}`,
    existing.attachment_url,
  );
};

/**
 * Parse the editable trigger-maintained aggregates (booked_quantity,
 * tickets_count, …) from an edit submission — but only for staff. Editors may
 * not touch these owner-level figures, so any such hidden fields they craft are
 * ignored rather than trusted: they always edit with a null aggregate input.
 */
export const parseAggregatesForRole = (
  session: AdminSession,
  form: FormParams,
):
  | { ok: true; input: ListingAggregateValues | null }
  | { ok: false; error: string } =>
  session.adminLevel === "editor"
    ? { input: null, ok: true }
    : parseEditableAggregateForm<ListingAggregateValues>(
        form,
        getListingAggregateFields(),
      );
