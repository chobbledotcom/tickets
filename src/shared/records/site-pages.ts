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
import {
  deleteCommand,
  transactCommand,
  updateIfPresent,
} from "#shared/rest/record-command.ts";
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
  /* jscpd:ignore-start -- declarative command config, one per content record */
  write: {
    create: (input) =>
      transactCommand<SitePage, SitePageWriteInput, "slugTaken">({
        input,
        log: (page, tx) => logPage(page.name, "created", tx),
        message: () => t("site.pages.error.slug_taken"),
        rule: sitePageRule,
        write: (tx, value) => createSitePage(value, tx),
      }),
    remove: deleteCommand(
      getSitePageById,
      (page) => deleteSitePageWithEdges(page.id),
      (page) => logPage(page.name, "deleted"),
    ),
    update: (id, input) =>
      updateIfPresent(
        getSitePageById,
        () =>
          transactCommand<
            SitePage,
            SitePageWriteInput,
            "notFound" | "slugTaken"
          >({
            input,
            log: (page, tx) => logPage(page.name, "updated", tx),
            message: () => t("site.pages.error.slug_taken"),
            notFound: "notFound",
            rule: sitePageRule,
            write: (tx, value) => updateSitePage(id, value, tx),
          }),
        id,
        input,
      ),
  },
  /* jscpd:ignore-end */
});
