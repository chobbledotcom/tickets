/** Triggers that keep derived database state in step with its source rows. */

import { ADMIN_FEATURE_TRIGGERS } from "./admin-feature-triggers.ts";
import {
  LISTING_AGGREGATE_WRITE_COLUMNS,
  ticketCountPredicateFor,
} from "./listing-aggregates.ts";
import type { Trigger } from "./types.ts";

/**
 * The per-row delta a listing-aggregate trigger adds to / subtracts from
 * tickets_count for a NEW/OLD row: +1 only when that row is a real ticket, so
 * toggling a line 0↔n nets out correctly via the OLD/NEW deltas.
 */
const ticketCountTriggerDelta = (row: "NEW" | "OLD"): string =>
  `CASE WHEN ${ticketCountPredicateFor(
    `${row}.quantity`,
    `${row}.attendee_id`,
  )} THEN 1 ELSE 0 END`;

const LISTING_AGGREGATE_USES = {
  attendees: ["kind"],
  listing_attendees: ["attendee_id", "listing_id", "quantity"],
  listings: ["booked_quantity", "tickets_count"],
} as const;

/**
 * Triggers that keep the listing count aggregates (booked_quantity,
 * tickets_count) in lockstep with listing_attendees, so the hot listing reads
 * and the active-listing stats cost one row read instead of scanning every
 * attendee row. tickets_count counts only quantity > 0 rows (see
 * TICKET_COUNTS_PREDICATE); income is no longer an aggregate column — it is
 * projected from the transfers ledger (gross credits to revenue:<listingId>) at
 * read time.
 *
 * The UPDATE trigger is scoped to `OF quantity, listing_id` so the frequent
 * check-in / refund / attachment-download / price writes (which touch other
 * columns) don't fire it. It subtracts the OLD row's contribution from its old
 * listing and adds the NEW row's to its new listing, so a row moving between
 * listings stays correct and a same-listing edit nets out to the delta.
 *
 * booked_quantity mirrors the previous SUM(quantity) exactly (every row counts
 * toward capacity, including the quantity = 0 no-quantity sentinel, which adds
 * nothing); tickets_count counts only quantity > 0 rows, so the sentinel keeps
 * its attendee↔listing link without inflating the ticket total.
 */
const LISTING_AGGREGATE_TRIGGERS: Trigger[] = [
  {
    name: "trg_listing_attendees_aggregates_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_listing_attendees_aggregates_insert
AFTER INSERT ON listing_attendees
FOR EACH ROW
BEGIN
  UPDATE listings SET
    booked_quantity = booked_quantity + NEW.quantity,
    tickets_count = tickets_count + ${ticketCountTriggerDelta("NEW")}
  WHERE id = NEW.listing_id;
END`,
    table: "listing_attendees",
    uses: LISTING_AGGREGATE_USES,
  },
  {
    name: "trg_listing_attendees_aggregates_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_listing_attendees_aggregates_delete
AFTER DELETE ON listing_attendees
FOR EACH ROW
BEGIN
  UPDATE listings SET
    booked_quantity = booked_quantity - OLD.quantity,
    tickets_count = tickets_count - ${ticketCountTriggerDelta("OLD")}
  WHERE id = OLD.listing_id;
END`,
    table: "listing_attendees",
    uses: LISTING_AGGREGATE_USES,
  },
  {
    name: "trg_listing_attendees_aggregates_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_listing_attendees_aggregates_update
AFTER UPDATE OF ${LISTING_AGGREGATE_WRITE_COLUMNS.join(
      ", ",
    )} ON listing_attendees
FOR EACH ROW
BEGIN
  UPDATE listings SET
    booked_quantity = booked_quantity - OLD.quantity,
    tickets_count = tickets_count - ${ticketCountTriggerDelta("OLD")}
  WHERE id = OLD.listing_id;
  UPDATE listings SET
    booked_quantity = booked_quantity + NEW.quantity,
    tickets_count = tickets_count + ${ticketCountTriggerDelta("NEW")}
  WHERE id = NEW.listing_id;
END`,
    table: "listing_attendees",
    uses: LISTING_AGGREGATE_USES,
  },
];

const MODIFIER_AGGREGATE_USES = {
  modifier_usages: ["modifier_id", "quantity"],
  modifiers: ["total_uses", "usage_count"],
} as const;

/**
 * Modifier aggregate triggers keep modifiers.total_uses and modifiers.usage_count
 * in step with the modifier_usages ledger, the same way the listing triggers
 * maintain the listings aggregates. The UPDATE trigger is scoped to OF quantity,
 * modifier_id so the only writes that affect the counts fire it, and it subtracts
 * the OLD row's contribution from its old modifier and adds the NEW row's to its
 * new modifier so a row moving between modifiers stays correct.
 *
 * Semantics mirror the previous SUM(quantity) / COUNT(*) queries over
 * modifier_usages exactly. The money figure (total_revenue) is no longer a
 * maintained column — it is projected from the transfers ledger at read time —
 * so amount_applied no longer drives any aggregate and is out of the UPDATE OF
 * list.
 */
const MODIFIER_AGGREGATE_TRIGGERS: Trigger[] = [
  {
    name: "trg_modifier_usages_aggregates_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_modifier_usages_aggregates_insert
AFTER INSERT ON modifier_usages
FOR EACH ROW
BEGIN
  UPDATE modifiers SET
    total_uses = total_uses + NEW.quantity,
    usage_count = usage_count + 1
  WHERE id = NEW.modifier_id;
END`,
    table: "modifier_usages",
    uses: MODIFIER_AGGREGATE_USES,
  },
  {
    name: "trg_modifier_usages_aggregates_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_modifier_usages_aggregates_delete
AFTER DELETE ON modifier_usages
FOR EACH ROW
BEGIN
  UPDATE modifiers SET
    total_uses = total_uses - OLD.quantity,
    usage_count = usage_count - 1
  WHERE id = OLD.modifier_id;
END`,
    table: "modifier_usages",
    uses: MODIFIER_AGGREGATE_USES,
  },
  {
    name: "trg_modifier_usages_aggregates_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_modifier_usages_aggregates_update
AFTER UPDATE OF quantity, modifier_id ON modifier_usages
FOR EACH ROW
BEGIN
  UPDATE modifiers SET
    total_uses = total_uses - OLD.quantity,
    usage_count = usage_count - 1
  WHERE id = OLD.modifier_id;
  UPDATE modifiers SET
    total_uses = total_uses + NEW.quantity,
    usage_count = usage_count + 1
  WHERE id = NEW.modifier_id;
END`,
    table: "modifier_usages",
    uses: MODIFIER_AGGREGATE_USES,
  },
];

const ANSWER_AGGREGATE_USES = {
  answers: ["times_selected"],
  attendee_answers: ["answer_id"],
} as const;

/**
 * Answer aggregate triggers keep answers.times_selected in step with the
 * attendee_answers join table, the same way the listing and modifier triggers
 * maintain their aggregates. Each attendee_answers row is one selection, so the
 * count is COUNT(*) per answer_id. The UPDATE trigger is scoped to OF answer_id
 * — the only column whose change moves a selection between answers — and it
 * subtracts the OLD answer's contribution and adds the NEW answer's so a
 * reassigned row stays correct.
 *
 * Semantics mirror the previous COUNT(*) query over attendee_answers exactly.
 */
const ANSWER_AGGREGATE_TRIGGERS: Trigger[] = [
  {
    name: "trg_attendee_answers_aggregates_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_aggregates_insert
AFTER INSERT ON attendee_answers
FOR EACH ROW
WHEN NEW.answer_id IS NOT NULL
BEGIN
  UPDATE answers SET times_selected = times_selected + 1
  WHERE id = NEW.answer_id;
END`,
    table: "attendee_answers",
    uses: ANSWER_AGGREGATE_USES,
  },
  {
    name: "trg_attendee_answers_aggregates_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_aggregates_delete
AFTER DELETE ON attendee_answers
FOR EACH ROW
WHEN OLD.answer_id IS NOT NULL
BEGIN
  UPDATE answers SET times_selected = times_selected - 1
  WHERE id = OLD.answer_id;
END`,
    table: "attendee_answers",
    uses: ANSWER_AGGREGATE_USES,
  },
  {
    name: "trg_attendee_answers_aggregates_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_aggregates_update
AFTER UPDATE OF answer_id ON attendee_answers
FOR EACH ROW
WHEN OLD.answer_id IS NOT NEW.answer_id
BEGIN
  UPDATE answers SET times_selected = times_selected - 1
  WHERE id = OLD.answer_id;
  UPDATE answers SET times_selected = times_selected + 1
  WHERE id = NEW.answer_id;
END`,
    table: "attendee_answers",
    uses: ANSWER_AGGREGATE_USES,
  },
];

const ATTENDEE_ANSWER_VALIDATION_USES = {
  attendee_answers: ["answer_id", "question_id", "string_id"],
} as const;

const ATTENDEE_ANSWER_VALIDATION_TRIGGERS: Trigger[] = [
  {
    name: "trg_attendee_answers_validate_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_validate_insert
BEFORE INSERT ON attendee_answers
WHEN NOT (
  (NEW.answer_id IS NOT NULL AND NEW.question_id IS NOT NULL AND NEW.string_id IS NULL) OR
  (NEW.answer_id IS NULL AND NEW.question_id IS NOT NULL AND NEW.string_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid attendee answer');
END`,
    table: "attendee_answers",
    uses: ATTENDEE_ANSWER_VALIDATION_USES,
  },
  {
    name: "trg_attendee_answers_validate_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_validate_update
BEFORE UPDATE ON attendee_answers
WHEN NOT (
  (NEW.answer_id IS NOT NULL AND NEW.question_id IS NOT NULL AND NEW.string_id IS NULL) OR
  (NEW.answer_id IS NULL AND NEW.question_id IS NOT NULL AND NEW.string_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid attendee answer');
END`,
    table: "attendee_answers",
    uses: ATTENDEE_ANSWER_VALIDATION_USES,
  },
];

const STRING_AGGREGATE_USES = {
  attendee_answers: ["string_id"],
  strings: ["used_count"],
} as const;

const ATTENDEE_STATUS_VALIDATION_USES = {
  attendee_statuses: ["id"],
  attendees: ["status_id"],
} as const;

const ATTENDEE_STATUS_VALIDATION_TRIGGERS: Trigger[] = [
  {
    name: "trg_attendees_validate_status_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendees_validate_status_insert
BEFORE INSERT ON attendees
WHEN NEW.status_id IS NOT NULL AND NOT EXISTS (
  SELECT status.id FROM attendee_statuses AS status WHERE status.id = NEW.status_id
)
BEGIN
  SELECT RAISE(ABORT, 'attendee status does not exist');
END`,
    table: "attendees",
    uses: ATTENDEE_STATUS_VALIDATION_USES,
  },
  {
    name: "trg_attendees_validate_status_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendees_validate_status_update
BEFORE UPDATE OF status_id ON attendees
WHEN NEW.status_id IS NOT NULL AND NOT EXISTS (
  SELECT status.id FROM attendee_statuses AS status WHERE status.id = NEW.status_id
)
BEGIN
  SELECT RAISE(ABORT, 'attendee status does not exist');
END`,
    table: "attendees",
    uses: ATTENDEE_STATUS_VALIDATION_USES,
  },
];

const STRING_AGGREGATE_TRIGGERS: Trigger[] = [
  {
    name: "trg_attendee_answers_strings_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_strings_insert
AFTER INSERT ON attendee_answers
WHEN NEW.string_id IS NOT NULL
BEGIN
  UPDATE strings SET used_count = used_count + 1 WHERE id = NEW.string_id;
END`,
    table: "attendee_answers",
    uses: STRING_AGGREGATE_USES,
  },
  {
    name: "trg_attendee_answers_strings_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_strings_delete
AFTER DELETE ON attendee_answers
WHEN OLD.string_id IS NOT NULL
BEGIN
  UPDATE strings SET used_count = used_count - 1 WHERE id = OLD.string_id;
END`,
    table: "attendee_answers",
    uses: STRING_AGGREGATE_USES,
  },
  {
    name: "trg_attendee_answers_strings_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_strings_update
AFTER UPDATE OF string_id ON attendee_answers
WHEN OLD.string_id IS NOT NEW.string_id
BEGIN
  UPDATE strings SET used_count = used_count - 1 WHERE id = OLD.string_id;
  UPDATE strings SET used_count = used_count + 1 WHERE id = NEW.string_id;
END`,
    table: "attendee_answers",
    uses: STRING_AGGREGATE_USES,
  },
];

/** Every declared aggregate and validation trigger. */
export const TRIGGERS: Trigger[] = [
  ...ADMIN_FEATURE_TRIGGERS,
  ...LISTING_AGGREGATE_TRIGGERS,
  ...MODIFIER_AGGREGATE_TRIGGERS,
  ...ANSWER_AGGREGATE_TRIGGERS,
  ...ATTENDEE_ANSWER_VALIDATION_TRIGGERS,
  ...ATTENDEE_STATUS_VALIDATION_TRIGGERS,
  ...STRING_AGGREGATE_TRIGGERS,
];
