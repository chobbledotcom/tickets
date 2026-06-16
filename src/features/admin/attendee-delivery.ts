/**
 * Delivery wiring for the unified attendee form.
 *
 * Kept separate from the core attendee form model so the (common) non-delivery
 * flow is untouched. Provides the field-name scheme, parsing of the submitted
 * drop-off/collection choices into a per-listing plan, and the data the
 * template needs to render the selectors (pre-filled from saved assignments).
 */

import type { AttendeeFormLine } from "#routes/admin/attendee-form-model.ts";
import { isBookedLine } from "#routes/admin/attendee-form-model.ts";
import {
  type DeliveryAssignment,
  getDeliveryAssignments,
} from "#shared/db/delivery.ts";
import { getAllDeliveryAgents } from "#shared/db/delivery-agents.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Attendee, DeliveryAgent } from "#shared/types.ts";

/** Checkbox field: when "1", each delivered listing carries its own agents. */
export const SPLIT_AGENTS_FIELD = "split_delivery_agents";

/** Drop-off select field name. With a listing id it is the split (per-listing)
 * field; without, the single field that applies to every delivered listing. */
export const dropOffAgentField = (listingId?: number): string =>
  listingId === undefined
    ? "delivery_drop_off"
    : `delivery_drop_off_${listingId}`;

/** Collection select field name (see {@link dropOffAgentField}). */
export const collectionAgentField = (listingId?: number): string =>
  listingId === undefined
    ? "delivery_collection"
    : `delivery_collection_${listingId}`;

/** A delivered listing the attendee books, with its current assignment. */
export type DeliveryLine = {
  listingId: number;
  name: string;
  assignment: DeliveryAssignment;
};

/** Everything the template needs to render the delivery selectors. */
export type AttendeeDeliveryData = {
  /** Selectable agents. */
  agents: DeliveryAgent[];
  /** Whether each delivered listing has its own agents. */
  split: boolean;
  /** Single-mode assignment, applied to every delivered listing. */
  single: DeliveryAssignment;
  /** One row per delivered booked listing (split mode). */
  lines: DeliveryLine[];
};

/** The delivered listings an attendee actually books (booked lines only). */
const deliveredBookedLines = (lines: AttendeeFormLine[]): AttendeeFormLine[] =>
  lines.filter(
    (line) =>
      (isBookedLine(line) || Boolean(line.existingBooking)) &&
      Boolean(line.listing?.delivered),
  );

/** The submitted delivery plan: split flag plus a per-listing assignment for
 * every delivered booked line. Agent ids not in `agentIds` (or blank) become
 * null. In single mode all delivered lines share the one submitted pair. */
export const parseDeliveryPlan = (
  form: FormParams,
  lines: AttendeeFormLine[],
  agentIds: Set<number>,
): { split: boolean; perListing: Map<number, DeliveryAssignment> } => {
  const split = form.get(SPLIT_AGENTS_FIELD) === "1";
  const valid = (raw: string): number | null => {
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && agentIds.has(n) ? n : null;
  };
  const perListing = new Map<number, DeliveryAssignment>();
  for (const line of deliveredBookedLines(lines)) {
    const id = line.listingId;
    perListing.set(id, {
      collectionAgentId: valid(
        form.getString(collectionAgentField(split ? id : undefined)),
      ),
      dropOffAgentId: valid(
        form.getString(dropOffAgentField(split ? id : undefined)),
      ),
    });
  }
  return { perListing, split };
};

const EMPTY_ASSIGNMENT: DeliveryAssignment = {
  collectionAgentId: null,
  dropOffAgentId: null,
};

/**
 * Build the delivery render data, or undefined when delivery is disabled, no
 * agents exist, or the attendee books no delivered listing. For an edit the
 * single-mode pair is seeded from the first delivered booked line's saved
 * assignment (they all share one pair when not split).
 */
export const buildAttendeeDeliveryData = async (
  lines: AttendeeFormLine[],
  attendee: Attendee | null,
): Promise<AttendeeDeliveryData | undefined> => {
  if (!settings.hasDelivery) return undefined;
  const delivered = deliveredBookedLines(lines);
  if (delivered.length === 0) return undefined;
  const agents = await getAllDeliveryAgents();
  if (agents.length === 0) return undefined;

  const existing = attendee
    ? await getDeliveryAssignments(attendee.id)
    : new Map<number, DeliveryAssignment>();
  const deliveryLines: DeliveryLine[] = delivered.map((line) => ({
    assignment: existing.get(line.listingId) ?? EMPTY_ASSIGNMENT,
    listingId: line.listingId,
    name: line.listing!.name,
  }));
  return {
    agents,
    lines: deliveryLines,
    single: deliveryLines[0]!.assignment,
    split: attendee?.split_delivery_agents ?? false,
  };
};
