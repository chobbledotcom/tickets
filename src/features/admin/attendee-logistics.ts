/**
 * Logistics wiring for the unified attendee form.
 *
 * Kept separate from the core attendee form model so the (common) non-logistics
 * flow is untouched. Provides the field-name scheme, parsing of the submitted
 * drop-off/collection choices into a per-listing plan, and the data the
 * template needs to render the selectors (pre-filled from saved assignments).
 */

import type { AttendeeFormLine } from "#routes/admin/attendee-form-model.ts";
import { isBookedLine } from "#routes/admin/attendee-form-model.ts";
import {
  getLogisticsAssignments,
  type LogisticsAssignment,
} from "#shared/db/logistics.ts";
import { getAllLogisticsAgents } from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Attendee, LogisticsAgent } from "#shared/types.ts";

/** Checkbox field: when "1", each delivered listing carries its own agents. */
export const SPLIT_AGENTS_FIELD = "split_logistics_agents";

/** Drop-off select field name. With a listing id it is the split (per-listing)
 * field; without, the single field that applies to every delivered listing. */
export const startAgentField = (listingId?: number): string =>
  listingId === undefined ? "logistics_start" : `logistics_start_${listingId}`;

/** Collection select field name (see {@link startAgentField}). */
export const endAgentField = (listingId?: number): string =>
  listingId === undefined ? "logistics_end" : `logistics_end_${listingId}`;

/** A delivered listing the attendee books, with its current assignment. */
export type LogisticsLine = {
  listingId: number;
  name: string;
  assignment: LogisticsAssignment;
};

/** Everything the template needs to render the logistics selectors. */
export type AttendeeLogisticsData = {
  /** Selectable agents. */
  agents: LogisticsAgent[];
  /** Whether each delivered listing has its own agents. */
  split: boolean;
  /** Single-mode assignment, applied to every delivered listing. */
  single: LogisticsAssignment;
  /** One row per delivered booked listing (split mode). */
  lines: LogisticsLine[];
};

/** The delivered listings an attendee actually books (booked lines only). */
const deliveredBookedLines = (lines: AttendeeFormLine[]): AttendeeFormLine[] =>
  lines.filter(
    (line) =>
      (isBookedLine(line) || Boolean(line.existingBooking)) &&
      Boolean(line.listing?.uses_logistics),
  );

/** The submitted logistics plan: split flag plus a per-listing assignment for
 * every delivered booked line. Agent ids not in `agentIds` (or blank) become
 * null. In single mode all delivered lines share the one submitted pair. */
export const parseLogisticsPlan = (
  form: FormParams,
  lines: AttendeeFormLine[],
  agentIds: Set<number>,
): { split: boolean; perListing: Map<number, LogisticsAssignment> } => {
  const split = form.get(SPLIT_AGENTS_FIELD) === "1";
  const valid = (raw: string): number | null => {
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && agentIds.has(n) ? n : null;
  };
  const perListing = new Map<number, LogisticsAssignment>();
  for (const line of deliveredBookedLines(lines)) {
    const id = line.listingId;
    perListing.set(id, {
      endAgentId: valid(form.getString(endAgentField(split ? id : undefined))),
      startAgentId: valid(
        form.getString(startAgentField(split ? id : undefined)),
      ),
    });
  }
  return { perListing, split };
};

const EMPTY_ASSIGNMENT: LogisticsAssignment = {
  endAgentId: null,
  startAgentId: null,
};

/**
 * Build the logistics render data, or undefined when logistics is disabled, no
 * agents exist, or the attendee books no delivered listing. For an edit the
 * single-mode pair is seeded from the first delivered booked line's saved
 * assignment (they all share one pair when not split).
 */
export const buildAttendeeLogisticsData = async (
  lines: AttendeeFormLine[],
  attendee: Attendee | null,
): Promise<AttendeeLogisticsData | undefined> => {
  if (!settings.hasLogistics) return undefined;
  const delivered = deliveredBookedLines(lines);
  if (delivered.length === 0) return undefined;
  const agents = await getAllLogisticsAgents();
  if (agents.length === 0) return undefined;

  const existing = attendee
    ? await getLogisticsAssignments(attendee.id)
    : new Map<number, LogisticsAssignment>();
  const logisticsLines: LogisticsLine[] = delivered.map((line) => ({
    assignment: existing.get(line.listingId) ?? EMPTY_ASSIGNMENT,
    listingId: line.listingId,
    name: line.listing!.name,
  }));
  return {
    agents,
    lines: logisticsLines,
    single: logisticsLines[0]!.assignment,
    split: attendee?.split_logistics_agents ?? false,
  };
};
