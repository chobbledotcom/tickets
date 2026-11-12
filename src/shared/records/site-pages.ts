/**
 * The site-page record: its table, its one write rule, and its custom write
 * commands. The JSON API keeps its own parent-change route, so its create,
 * update, read, and delete are overrides on this same declaration.
 */

import { logActivity } from "#db/activity-log.ts";
import type { TxScope } from "#db/client.ts";
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
import {
  deleteAndLog,
  transactCommand,
  updateIfPresent,
} from "#shared/rest/record-command.ts";
import { errorResult, okResult } from "#shared/result.ts";
import { isReservedSlug } from "#shared/site-pages/core.ts";
import type { SitePage } from "#types";

const logPage = (
  name: string,
  verb: string,
  transaction?: TxScope,
): Promise<unknown> =>
  logActivity(`Page '${name}' ${verb}`, undefined, undefined, transaction);

/** The one site-page rule: the public site reserves some slugs, so a page
 *  cannot take one. Both doors answer the same refusal. */
export const sitePageRule = (input: SitePageWriteInput) =>
  isReservedSlug(input.slug)
    ? errorResult(t("site.pages.error.reserved"))
    : okResult(input);

export const sitePageRecord = defineNamedRowRecord<
  SitePage,
  SitePageWriteInput,
  SitePage
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
    remove: (id) =>
      deleteAndLog(id, {
        destroy: (page) => deleteSitePageWithEdges(page.id),
        load: getSitePageById,
        log: (page) => logPage(page.name, "deleted"),
      }),
    update: (id, input) =>
      updateIfPresent(
        id,
        async (pageId) => (await getSitePageById(pageId)) !== null,
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
      ),
  },
  /* jscpd:ignore-end */
});
