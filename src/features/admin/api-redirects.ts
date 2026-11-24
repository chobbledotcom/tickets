/**
 * Admin JSON API routes for redirects — accessible via API key or cookie+CSRF.
 * The audience and the write rule come from the redirect record. A redirect is
 * added and deleted, never edited, so the record gives no update mapper.
 */

import type { Redirect, RedirectInput } from "#db/redirects.ts";
import type { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { REDIRECT_FIELDS } from "#shared/records/redirect-fields.ts";
import { redirectRecord } from "#shared/records/redirects.ts";
import { bodyMappers } from "#shared/rest/field-reads.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { recordApi } from "#shared/rest/record-api.ts";

const { toCreateInput } = bodyMappers(REDIRECT_FIELDS);

export const redirectApiRoutes = recordApi<
  typeof ADMIN_API_RESOURCES.redirects,
  RecordShapeOf<Redirect, RedirectInput>
>(redirectRecord, {
  stripKeys: ["from_index", "to_index"],
  toCreateInput,
});
