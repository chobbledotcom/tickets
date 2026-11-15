// effects: pure
import * as v from "valibot";

// valibot's word-splitting handles digits and acronyms. The schema is built
// once at module load.
const camelCaseSchema = v.pipe(v.string(), v.toCamelCase());

/** Convert snake_case to camelCase: `max_attendees` becomes `maxAttendees`. */
export const toCamelCase = (s: string): string => v.parse(camelCaseSchema, s);
