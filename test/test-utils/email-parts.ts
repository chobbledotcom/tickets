import { expect } from "@std/expect";
import type { EmailContent } from "#templates/email/shared.ts";

/** The email's subject, HTML, and text hold exactly the expected values. A
 *  template that renders the wrong name fails rather than passing. */
export const expectEmailParts = (
  actual: EmailContent,
  expected: EmailContent,
): void => {
  expect(actual).toMatchObject(expected);
};
