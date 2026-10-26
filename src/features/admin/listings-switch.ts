/**
 * The intermediate step a switch to booked-by-the-day serves while the
 * listing holds undated bookings, and the plan that completes the switch.
 *
 * A booking made while the listing was standard carries no day. The per-day
 * count of a daily listing reads none of those rows. So the bare switch
 * reopens a full listing. Instead of saving, the edit POST serves the edit
 * page with an assign card. The card names the bookings without a day and
 * offers one date to move them all to. Saving with a date moves them (under
 * the shared capacity guard) and completes the switch in one transaction.
 * Leaving the page saves nothing.
 */

import { capacityConditionFor } from "#db/capacity.ts";
import { resultRows, type SqlStatement, withTransaction } from "#db/client.ts";
import { holidays } from "#db/holidays.ts";
import {
  type AssignPlan,
  undatedBookingsForListing,
  wouldBeStaySpanDays,
} from "#db/listings/daily-switch.ts";
import { listingsTable } from "#db/listings/records.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import { t } from "#i18n";
import type { AuthSession } from "#routes/auth.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ListingWithCount } from "#types";
import {
  persistListingJoins,
  prepareListingJoins,
} from "./api-listing-joins.ts";
import { listingPage } from "./listing-page.ts";
import { loadListingEditPanel } from "./listing-page-management-panels.ts";
import { buildUpdateListingResource, parseGroupIds } from "./listings-form.ts";

/** The form field a save carries its chosen date under: one of the dates the
 * card offered. Absent on the first POST that lands on the page. */
export const ASSIGN_UNDATED_FIELD = "assign_undated_to";

/** What the assign card shows: the warning's count, the dates offered, and
 * the date already chosen on a re-render. It also records whether any date
 * can hold the bookings at all. */
export interface AssignCard {
  chosen: string;
  count: number;
  dates: string[];
  noDates: boolean;
  noneFits: boolean;
}

/** The switch page's pending state. It holds the card and the organiser's
 * submitted form values. The re-rendered form then still carries the switch —
 * and every other change — it was saved from. Without them the confirm save
 * writes the stored values back and quietly drops the switch. */
export interface AssignPageContext {
  card: AssignCard;
  submittedValues: Record<string, string>;
}

/** What the edit POST does with a switch the listing cannot make yet. */
export type SwitchStep =
  | {
      kind: "assign";
      page: AssignPageContext;
      plan: AssignPlan;
    }
  | { kind: "invalid"; error: string }
  | { kind: "none" }
  | { kind: "page"; error?: string; page: AssignPageContext; status: number };

/** The bookable start dates the switched listing can offer. They read the
 * stored row's calendar under the new fields. The submitted values stand in
 * for anything the submission left out. */
export const wouldBeStartDates = async (
  stored: ListingWithCount,
  input: ListingInput,
): Promise<string[]> =>
  getBookableStartDates(
    {
      ...stored,
      bookable_days: input.bookableDays ?? stored.bookable_days,
      customisable_days: input.customisableDays ?? stored.customisable_days,
      duration_days: input.durationDays ?? stored.duration_days,
      maximum_days_after: input.maximumDaysAfter ?? stored.maximum_days_after,
      minimum_days_before:
        input.minimumDaysBefore ?? stored.minimum_days_before,
    },
    await holidays.getAll(),
  );

/** The probe always rolls its transaction back. This error carries the
 * verdicts out. */
class AssignProbe extends Error {
  constructor(readonly fits: boolean[]) {
    super("the assign probe always rolls back");
  }
}

/** One SELECT asks the shared capacity predicate about every offered date.
 * It answers whether the undated demand can land there under all the caps. */
const dateVerdictsStatement = (
  listingId: number,
  quantity: number,
  dates: readonly string[],
  durationDays: number,
): SqlStatement =>
  numberedStatement((bind) => {
    const columns = dates
      .map((date, index) => {
        const fits = capacityConditionFor({
          date,
          durationDays,
          listingId,
          quantity,
        })(bind);
        return `(${fits}) AS ok${index}`;
      })
      .join(", ");
    return `SELECT ${columns}`;
  });

/** Judge each offered date against the new listing with the production
 * capacity SQL. The row update and the join writes run inside a transaction
 * that always rolls back. The probe can never leave a trace. */
export const probeAssignDates = async (
  stored: ListingWithCount,
  wouldBe: ListingInput,
  dates: readonly string[],
  quantity: number,
  durationDays: number,
): Promise<boolean[]> => {
  if (dates.length === 0) return [];
  try {
    return await withTransaction(async (tx) => {
      // `updateStatement` is optional only on the façade type. The REST layer
      // calls it the same way (see `parseWriteAndCommit` in resource.ts).
      await tx.execute(
        await listingsTable.updateStatement!(stored.id, wouldBe),
      );
      await persistListingJoins(tx, stored.id, prepareListingJoins(wouldBe));
      const results = await tx.batch([
        dateVerdictsStatement(stored.id, quantity, dates, durationDays),
      ]);
      const row = resultRows<Record<string, number>>(results[0]!)[0]!;
      throw new AssignProbe(dates.map((_, index) => row[`ok${index}`] === 1));
    });
  } catch (error) {
    if (error instanceof AssignProbe) return error.fits;
    throw error;
  }
};

/** Read the switch step an edit POST must take. Save straight through when
 * the switch touches no undated booking. Otherwise serve the assign card, or
 * carry the confirmed move into the save. */
export const planListingTypeSwitch = async (
  stored: ListingWithCount,
  form: FormParams,
): Promise<SwitchStep> => {
  if (form.getString("listing_type") !== "daily") return { kind: "none" };
  if (stored.listing_type === "daily") return { kind: "none" };
  const rows = await undatedBookingsForListing(stored.id);
  if (rows.length === 0) return { kind: "none" };

  const count = rows.reduce((total, row) => total + row.quantity, 0);
  const chosen = form.getString(ASSIGN_UNDATED_FIELD);

  const parsed = await buildUpdateListingResource(form, stored).parseInput(
    form,
  );
  if (!parsed.ok) return { error: parsed.error, kind: "invalid" };
  const wouldBe = parsed.value;

  const dates = await wouldBeStartDates(stored, wouldBe);
  const fits =
    dates.length === 0
      ? []
      : await probeAssignDates(
          stored,
          wouldBe,
          dates,
          count,
          wouldBeStaySpanDays(wouldBe),
        );

  const page: AssignPageContext = {
    card: {
      chosen,
      count,
      dates,
      noDates: dates.length === 0,
      // Said plainly the moment the page opens: no offered date can hold the
      // bookings, so picking one cannot succeed.
      noneFits: fits.length > 0 && fits.every((fit) => !fit),
    },
    // The organiser's submitted values, so the confirm save still carries the
    // switch (and every other change) it was saved from.
    submittedValues: form.toRenderValues(),
  };

  const pickError = form.has(ASSIGN_UNDATED_FIELD)
    ? t("listings_table.switch_daily_undated_pick_error")
    : undefined;
  if (chosen === "") {
    return {
      kind: "page",
      page,
      status: 200,
      ...(pickError === undefined ? {} : { error: pickError }),
    };
  }
  if (!dates.includes(chosen)) {
    return {
      error: t("listings_table.switch_daily_undated_pick_error"),
      kind: "page",
      page,
      status: 400,
    };
  }
  if (!fits[dates.indexOf(chosen)]) {
    return {
      error: t("listings_table.switch_daily_undated_refused", {
        count,
        date: chosen,
        name: wouldBe.name,
      }),
      kind: "page",
      page,
      status: 400,
    };
  }
  return { kind: "assign", page, plan: { count, date: chosen } };
};

/** Serve the edit page as the switch's intermediate step. The full form
 * carries the organiser's submitted values, not the stored row. The assign
 * card sits in front of the form, and a refusal sits above the card. */
export const renderListingSwitchAssignPage = async (
  stored: ListingWithCount,
  session: AuthSession,
  form: FormParams,
  page: AssignPageContext,
  error: string | undefined,
  status: number,
): Promise<Response> =>
  listingPage.renderPage(session, stored.id, "edit", {
    panel: (entity, ctx) =>
      loadListingEditPanel(entity, ctx, error, parseGroupIds(form), page),
    status,
  });
