/** Owner posts of the listing create and edit forms: the smallest boxes the
 *  forms accept, plus the boxes a test names. */

import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { baseListingForm } from "#test-utils/factories.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import {
  adminFormPost,
  adminMultipartPost,
  setupListingAndLogin,
} from "#test-utils/session.ts";

/** The create page posts multipart, since it can carry an attachment. */
export const submitListingCreate = (boxes: TestFormValues = {}) =>
  adminMultipartPost("/admin/listing", { ...baseListingForm, ...boxes });

export const submitListingEdit = (id: number, boxes: TestFormValues = {}) =>
  adminFormPost(`/admin/listing/${id}/edit`, { ...baseListingForm, ...boxes });

/** Save the listing under its own name and slug, plus the given boxes. */
export const submitOwnListingEdit = (
  listing: { id: number; name: string; slug: string },
  boxes: TestFormValues = {},
) =>
  submitListingEdit(listing.id, {
    name: listing.name,
    slug: listing.slug,
    ...boxes,
  });

/** Sign in with a fresh listing, save it with the given boxes, and expect the
 *  save to be refused with the message. */
export const expectOwnEditRefused = async (
  boxes: TestFormValues,
  message: string,
): Promise<void> => {
  const { listing } = await setupListingAndLogin();
  const { response } = await submitOwnListingEdit(listing, boxes);
  await expectHtmlResponse(response, 400, message);
};
