/**
 * The email address the person a story names books with. One rule, so a later
 * step can look a person up by the same address the booking used.
 *
 * The rule lives in its own module. The unit suite loads this module through
 * the note-picture seeds and runs it. world.ts is also loaded there, but its
 * tests never book anybody, so a helper there would read as uncovered.
 */

export const emailFor = (who: string): string =>
  `${who.toLowerCase().replaceAll(" ", ".")}@example.com`;
