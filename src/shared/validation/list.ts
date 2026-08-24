import * as v from "valibot";

/**
 * A list of records an outside system can leave out of its answer.
 *
 * Absence stays absent: what a missing list means belongs to the boundary
 * reading it, not to this schema. Every provider states its repeated facts
 * this way, so they say it in one shape.
 */
export const optionalRecordList = <Entries extends v.ObjectEntries>(
  entries: Entries,
): v.OptionalSchema<
  v.ArraySchema<v.ObjectSchema<Entries, undefined>, undefined>,
  undefined
> => v.optional(v.array(v.object(entries)));
