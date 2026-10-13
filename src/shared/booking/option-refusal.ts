/**
 * Why an option refuses, as the booking form's walk names it. The pure
 * refusal vocabulary of the option-demand judge. It holds the declared
 * refusal picklist, the child-level failure kinds, the parent-level
 * roll-up, and the refusal each set of span failures maps to.
 */

import * as v from "valibot";
import {
  childCanBeBooked,
  childDateOk,
  childSupportsDays,
  type TicketListing,
} from "#booking/model.ts";
import type { Holiday } from "#db/holidays.ts";

/** Why the form refuses to book an option. The order is the declared
 * precedence: a structural refusal outranks a span refusal, which outranks a
 * date refusal. */
export const OptionRefusalSchema = v.picklist([
  "capacity",
  "closed",
  "date_unsupported",
  "no_bookable_child",
  "sold_out",
  "span_unsupported",
]);
export type OptionRefusal = v.InferOutput<typeof OptionRefusalSchema>;

/** Why one child cannot serve one span. */
export type ChildFailure = "date" | "span" | "structural";

/** Why one parent cannot fold at one span. `parent_date` is the parent's own
 * range refusing the span at the chosen date. */
export type SpanFailure = ChildFailure | "capacity" | "parent_date";

/** What one child must serve: the span, the chosen date, and the holidays. */
export type Serving = {
  child: TicketListing;
  date: string | null;
  durationDays: number;
  holidays: Holiday[];
};

/** Why one child cannot serve one span, or null when it can. */
export const whyChildFails = (serving: Serving): ChildFailure | null => {
  if (!childCanBeBooked(serving.child)) return "structural";
  if (!childSupportsDays(serving.child, serving.durationDays)) return "span";
  if (serving.date === null) return null;
  const dateOk = childDateOk(
    serving.date,
    serving.holidays,
    serving.durationDays,
  )(serving.child);
  if (!dateOk) return "date";
  return null;
};

/** Why no child of a parent can serve one span. The first declared failure
 * wins: a dead child outranks a span no child serves, which outranks a date
 * no child can start. */
export const whyNoChildServes = (
  children: readonly TicketListing[],
  date: string | null,
  durationDays: number,
  holidays: Holiday[],
): ChildFailure => {
  const failures = children.map((child) =>
    whyChildFails({ child, date, durationDays, holidays }),
  );
  if (failures.every((failure) => failure === "structural"))
    return "structural";
  if (failures.includes("date")) return "date";
  return "span";
};

/** The declared refusal for a set of span failures. */
export const reasonOfFailures = (
  failures: readonly SpanFailure[],
): OptionRefusal => {
  if (failures.includes("structural")) return "no_bookable_child";
  if (failures.includes("span")) return "span_unsupported";
  if (failures.includes("date") || failures.includes("parent_date"))
    return "date_unsupported";
  return "capacity";
};

/** Why the form's page rules offer no day count: the required children prune
 * every span, or no count is priced at all. */
export const noSpanReason = (
  children: readonly TicketListing[],
): OptionRefusal => {
  const anyAlive = children.some(childCanBeBooked);
  if (children.length === 0 || anyAlive) return "span_unsupported";
  return "no_bookable_child";
};
