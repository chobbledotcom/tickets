/**
 * Admin redirect routes - owner only. Both doors read the one redirect record
 * declaration. A redirect is added and deleted, never edited.
 */

import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import { REDIRECT_FIELDS } from "#shared/records/redirect-fields.ts";
import { redirectRecord } from "#shared/records/redirects.ts";
import { formInput } from "#shared/rest/field-reads.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import { getRedirectPages } from "#templates/admin/redirects.tsx";
import { getRedirectForm } from "#templates/fields/redirect.ts";

const pages = recordPages(redirectRecord, {
  form: getRedirectForm(),
  renderDelete: (...args) => getRedirectPages().deletePage(...args),
  renderList: (rows, session, success) =>
    getRedirectPages().listPage(rows, session, undefined, success),
  renderNew: (...args) => getRedirectPages().newPage(...args),
  skip: ["edit"],
  toInput: formInput(REDIRECT_FIELDS),
});

export const adminHandlers = defineAdminRoutes({
  "GET /admin/redirects": pages.listGet,
  "GET /admin/redirects/:id/delete": pages.deleteGet,
  "GET /admin/redirects/new": pages.newGet,
  "POST /admin/redirects": pages.createPost,
  "POST /admin/redirects/:id/delete": pages.deletePost,
});
