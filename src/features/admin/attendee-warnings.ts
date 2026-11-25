/** The warnings about an attendee: facts about the stored booking that the
 * operator must see. They come from the booking each time, so a warning goes
 * away when the booking no longer needs it. No one can dismiss one.
 *
 * Each kind reads the whole list of attendees at once, so a list page costs
 * the same few reads as one attendee page. */

import { type BookedLine, getBookedLines } from "#db/attendees/booked-lines.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeesByIds } from "#db/attendees/queries.ts";
import { hasAssignedBuiltSite } from "#db/built-sites/claims.ts";
import { hydrateListingLinks, listingChildren } from "#db/listing-parents.ts";
import { getAllListings } from "#db/listings/records.ts";
import { getAttendeeIdsWithPaymentReference } from "#db/payment-references.ts";
import { countHiddenLineAnswers } from "#db/questions/attendee-answers/hidden.ts";
import type { ReadByIds } from "#db/rows-for-ids.ts";
import {
  compact,
  fieldById,
  groupToMap,
  mapParallel,
  requiredMapValue,
  unique,
} from "#fp";
import { isIncompletePayment } from "#shared/incomplete-payment.ts";
import { requireValue } from "#shared/required-value.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#types";
import {
  type LineAnswerRow,
  loadLineAnswerRows,
} from "./attendee-line-answers.ts";

/** One warning about an attendee. */
export type AttendeeWarning =
  /** Answers for tickets that the booking no longer takes. */
  | { kind: "hidden_answers"; count: number }
  /** A parent listing booked without one of its child listings. */
  | { kind: "parent_without_child"; parent: string; children: string[] }
  /** A paid site plan whose buyer has no site. */
  | { kind: "plan_without_site"; listings: string[] };

type WarningKind = AttendeeWarning["kind"];

/** The warnings of each attendee in a list that has some. */
export type WarningsByAttendee = ReadonlyMap<
  number,
  readonly AttendeeWarning[]
>;

/** What every kind reads from: the attendees, and their booking lines. */
type WarningSubject = {
  attendeeIds: readonly number[];
  lines: readonly BookedLine[];
};

/** One kind's warnings for each attendee. An attendee with none is absent. */
type WarningLoader = (
  subject: WarningSubject,
) => Promise<Map<number, AttendeeWarning[]>>;

/** The booked parents of one attendee that hold none of their children. */
const parentsWithoutChild = (
  bookedIds: readonly number[],
  childrenByParent: ReadonlyMap<
    number,
    readonly { id: number; name: string }[]
  >,
  names: ReadonlyMap<number, string>,
): AttendeeWarning[] =>
  compact(
    unique([...bookedIds]).map((listingId) => {
      const children = childrenByParent.get(listingId);
      return children === undefined ||
        children.some((child) => bookedIds.includes(child.id))
        ? null
        : {
            children: children.map((child) => child.name),
            kind: "parent_without_child" as const,
            parent: requiredMapValue(names, listingId),
          };
    }),
  );

/** The plan warning for one buyer, or null when the buyer needs none. One
 * site serves every plan row the buyer holds. A refunded plan's claim still
 * holds the site, so the claim check reads every plan row. A sale that never
 * completed cannot owe a site. */
const planWarningOrNull = async (
  rows: readonly Attendee[],
  hasPaymentReference: boolean,
  names: ReadonlyMap<number, string>,
): Promise<AttendeeWarning | null> => {
  const first = requireValue(rows[0], "A buyer's plan rows hold a row");
  const owed = rows.filter((row) => row.quantity >= 1 && !row.refunded);
  if (
    owed.length === 0 ||
    isIncompletePayment(first, true, hasPaymentReference) ||
    (await hasAssignedBuiltSite(
      first.id,
      unique(rows.map((row) => row.listing_id)),
    ))
  ) {
    return null;
  }
  return {
    kind: "plan_without_site",
    listings: unique(
      owed.map((row) => requiredMapValue(names, row.listing_id)),
    ),
  };
};

const WARNING_LOADERS: Record<WarningKind, WarningLoader> = {
  hidden_answers: async ({ attendeeIds }) =>
    new Map(
      [...(await countHiddenLineAnswers(attendeeIds))].map(([id, count]) => [
        id,
        [{ count, kind: "hidden_answers" }],
      ]),
    ),
  parent_without_child: async ({ lines }) => {
    const booked = lines.filter((line) => line.quantity > 0);
    if (booked.length === 0) return new Map();
    const [{ listingsByKey }, listings] = await Promise.all([
      hydrateListingLinks(
        listingChildren,
        unique(booked.map((line) => line.listingId)),
      ),
      getAllListings(),
    ]);
    const byAttendee = groupToMap(
      (line: BookedLine) => line.attendeeId,
      (line: BookedLine) => line.listingId,
    )(booked);
    return new Map(
      [...byAttendee]
        .map(([id, bookedIds]): [number, AttendeeWarning[]] => [
          id,
          parentsWithoutChild(
            bookedIds,
            listingsByKey,
            fieldById("name")(listings),
          ),
        ])
        .filter(([, warnings]) => warnings.length > 0),
    );
  },
  plan_without_site: async ({ lines }) => {
    const listings = await getAllListings();
    const planIds = new Set(
      listings.filter((l) => l.assignBuiltSite).map((l) => l.id),
    );
    const buyerIds = unique(
      lines
        .filter((line) => line.quantity > 0 && planIds.has(line.listingId))
        .map((line) => line.attendeeId),
    );
    if (buyerIds.length === 0) return new Map();
    // The payment reference test reads the stored payment id, so it needs
    // the decrypted row.
    const rows = await decryptAttendees(
      await getAttendeesByIds(buyerIds),
      await requireRequestPrivateKey(),
    );
    const planRows = groupToMap(
      (row: Attendee) => row.id,
      (row: Attendee) => row,
    )(rows.filter((row) => planIds.has(row.listing_id)));
    const withReference = await getAttendeeIdsWithPaymentReference(rows);
    const names = fieldById("name")(listings);
    const found = await mapParallel(
      async ([id, buyerRows]: [number, Attendee[]]) => ({
        id,
        warning: await planWarningOrNull(
          buyerRows,
          withReference.has(id),
          names,
        ),
      }),
    )([...planRows]);
    return new Map(
      found.flatMap(({ id, warning }): [number, AttendeeWarning[]][] =>
        warning === null ? [] : [[id, [warning]]],
      ),
    );
  },
};

/** Every warning for each attendee in the list, in the order of the kinds. An
 * attendee with none is absent. */
export const loadAttendeeWarnings: ReadByIds<AttendeeWarning[]> = async (
  attendeeIds,
) => {
  const subject = { attendeeIds, lines: await getBookedLines(attendeeIds) };
  const byKind = await Promise.all(
    Object.values(WARNING_LOADERS).map((load) => load(subject)),
  );
  return groupToMap(
    ([attendeeId]: [number, AttendeeWarning]) => attendeeId,
    ([, warning]: [number, AttendeeWarning]) => warning,
  )(
    byKind.flatMap((found) =>
      [...found].flatMap(([id, warnings]) =>
        warnings.map((warning): [number, AttendeeWarning] => [id, warning]),
      ),
    ),
  );
};

/** The warnings on the attendee page, and the hidden answers that the page
 * lists. The answers are read only when there are some. */
export type AttendeePageWarnings = {
  hiddenAnswers: LineAnswerRow[];
  warnings: AttendeeWarning[];
};

export const loadAttendeePageWarnings = async (
  attendeeId: number,
): Promise<AttendeePageWarnings> => {
  const warnings =
    (await loadAttendeeWarnings([attendeeId])).get(attendeeId) ?? [];
  return {
    hiddenAnswers: warnings.some(({ kind }) => kind === "hidden_answers")
      ? await loadLineAnswerRows(attendeeId, "hidden")
      : [],
    warnings,
  };
};
