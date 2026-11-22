/**
 * Helpers that the new-listing suites share: the page text, the template that
 * the page carries, a create that fails, and a stored image.
 */

import { expect } from "@std/expect";
import { insertImageRecord } from "#db/images.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { adminGet, adminMultipartPost } from "#test-utils/session.ts";

export const pageAt = async (path: string): Promise<string> =>
  await (await adminGet(path)).text();

/** The template the page will carry back into a re-submitted create. */
export const carriedTemplate = (html: string): string | null =>
  /name="templateId"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? null;

/** A create that always fails validation, so the error page renders. The blank
 * name is what fails; every other field is the shape under test. */
export const rejectedCreate = async (
  shape: Parameters<typeof testListingInput>[0],
  extra: Record<string, string> = {},
): Promise<string> => {
  const { response } = await adminMultipartPost("/admin/listing", {
    ...buildCreateListingForm(testListingInput({ ...shape, name: "" })),
    ...extra,
  });
  expect(response.status).toBe(400);
  return await response.text();
};

export const storedImage = (name: string) =>
  insertImageRecord({
    filename: nonEmptyString(`${name}.webp`, "test filename"),
    filenameThumb: nonEmptyString(`${name}-thumb.webp`, "test thumbnail"),
    name,
  });
