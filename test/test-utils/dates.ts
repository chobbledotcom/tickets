/** Test fixtures for date values that cross a branded boundary. */

import {
  type DateString,
  parseDateStringOrThrow,
} from "#shared/validation/date-string.ts";

/** Brand a literal date for a fixture. Throws when the literal is not a real
 *  calendar day, so a typo stops the suite at the fixture line. */
export const testDate = (raw: string): DateString =>
  parseDateStringOrThrow(raw, "a test fixture date");
