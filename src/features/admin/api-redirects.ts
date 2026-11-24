/**
 * Admin JSON API routes for redirects — accessible via API key or cookie+CSRF.
 * The audience and the write rule come from the redirect record. A redirect is
 * added and deleted, never edited, so the record gives no update mapper.
 */

import type { Redirect, RedirectInput } from "#db/redirects.ts";
import type { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { redirectRecord } from "#shared/records/redirects.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { recordApi } from "#shared/rest/record-api.ts";
import { okResult } from "#shared/result.ts";

export const redirectApiRoutes = recordApi<
  typeof ADMIN_API_RESOURCES.redirects,
  RecordShapeOf<Redirect, RedirectInput>
>(redirectRecord, {
  stripKeys: ["from_index"],
  toCreateInput: ({ from_path: fromPath, to_url: toUrl }) =>
    okResult({ fromPath, toUrl }),
});
