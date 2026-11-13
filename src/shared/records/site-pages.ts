/**
 * The site-page record: its table, its one write rule, and its custom write
 * commands. The JSON API keeps its own parent-change route, so its create,
 * update, read, and delete are overrides on this same declaration.
 */

import { deleteSitePageWithEdges } from "#db/site-page-items.ts";
import {
  createSitePage,
  getSitePageById,
  type SitePageWriteInput,
  sitePagesTable,
  updateSitePage,
} from "#db/site-pages.ts";
import { t } from "#i18n";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import { logNameActivity, type RecordShapeOf } from "#shared/rest/record.ts";
import { contentCommands } from "#shared/rest/record-command.ts";
import { errorResult, okResult } from "#shared/result.ts";
import { isReservedSlug } from "#shared/site-pages/core.ts";
import type { SitePage } from "#types";

const logPage = logNameActivity("Page");

/** The one site-page rule: the public site reserves some slugs, so a page
 *  cannot take one. Both doors answer the same refusal. */
export const sitePageRule = (input: SitePageWriteInput) =>
  isReservedSlug(input.slug)
    ? errorResult(t("site.pages.error.reserved"))
    : okResult(input);

export const sitePageRecord = defineNamedRowRecord<
  RecordShapeOf<SitePage, SitePageWriteInput, SitePage>
>({
  activityName: "Page",
  api: ADMIN_API_RESOURCES["site-pages"],
  getAll: () =>
    sitePagesTable.read.many({}, { order: "sort_order ASC, id ASC" }),
  list: "sitePages",
  load: getSitePageById,
  rule: sitePageRule,
  write: contentCommands<
    SitePage,
    SitePageWriteInput,
    "notFound" | "slugTaken"
  >({
    create: createSitePage,
    load: getSitePageById,
    log: logPage,
    message: () => t("site.pages.error.slug_taken"),
    notFound: "notFound",
    remove: (page) => deleteSitePageWithEdges(page.id),
    rule: sitePageRule,
    update: updateSitePage,
    updateInput: (input) => input,
  }),
});
