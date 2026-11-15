/** Owner posts of the listing create and edit forms: the smallest boxes the
 *  forms accept, plus the boxes a test names. */

import { baseListingForm } from "#test-utils/factories.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { adminFormPost, adminMultipartPost } from "#test-utils/session.ts";

/** The create page posts multipart, since it can carry an attachment. */
export const submitListingCreate = (boxes: TestFormValues = {}) =>
  adminMultipartPost("/admin/listing", { ...baseListingForm, ...boxes });

export const submitListingEdit = (id: number, boxes: TestFormValues = {}) =>
  adminFormPost(`/admin/listing/${id}/edit`, { ...baseListingForm, ...boxes });
