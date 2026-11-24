// effects: pure
import * as v from "valibot";
import { integerAtLeast } from "#shared/validation/number.ts";

/** One person a door can check in, under the key that names them. The
 * person has a name and the places one check-in at the door admits. The
 * door-safe details tell two people with the same name apart. The search
 * route keys a person by attendee id, and the offline list by ticket
 * digest. */
export const doorPersonSchema = <Key extends v.ObjectEntries>(key: Key) =>
  v.object({
    ...key,
    details: v.array(v.string()),
    name: v.string(),
    quantity: integerAtLeast(1),
  });

/** One person the door's name search answers, keyed by attendee id. */
const RosterOptionSchema = doorPersonSchema({ attendeeId: integerAtLeast(1) });

export type RosterOption = v.InferOutput<typeof RosterOptionSchema>;

/** The search route's answer: the people whose name holds the search text.
 * The server builds it and the browser parses it with this one schema. */
export const SearchAnswerSchema = v.object({
  options: v.array(RosterOptionSchema),
});
