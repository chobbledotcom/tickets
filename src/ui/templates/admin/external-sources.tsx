/**
 * The owner's read-only view of the external sources directory: every source,
 * the pattern it stores, and every link it holds.
 */

import type { ExternalLinkMatch } from "#db/external-sources/queries.ts";
/* jscpd:ignore-start */
import type {
  ExternalSource,
  ExternalSourceLink,
} from "#db/external-sources/types.ts";
import { externalLinkUrl } from "#db/external-sources/url.ts";
import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import { adminPath } from "#shared/admin-surface.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { flashDataPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
/* jscpd:ignore-end */

/** One source and the links it holds, as the page shows them. */
export type ExternalSourceEntry = {
  links: readonly ExternalSourceLink[];
  source: ExternalSource;
};

/** The site's word for each kind of record a link can name. */
const RECORD_KIND: Record<ExternalSourceLink["link_type"], string> = {
  attendee: "Attendee",
  group: "Group",
  listing: "Listing",
};

/** The admin page of the record a link names. */
const recordPath = (link: ExternalSourceLink): string => {
  if (link.link_type === "attendee") {
    return adminPath("attendee", { attendeeId: link.link_id });
  }
  if (link.link_type === "group") {
    return adminPath("group", { id: link.link_id });
  }
  return adminPath("listing", { id: link.link_id });
};

/** The record a link names, opening its own admin page. */
const recordLink = (link: ExternalSourceLink): Child => (
  <a href={recordPath(link)}>
    {`${RECORD_KIND[link.link_type]} ${link.link_id}`}
  </a>
);

/** The address the source's pattern gives this link, or the site's word for a
 *  record the other system has not named yet. */
const addressCell = ({ link, source }: ExternalLinkMatch): Child => {
  const url = externalLinkUrl(source.url_pattern, link.external_id);
  return url === null ? (
    t("features.external_sources.not_named")
  ) : (
    <a href={url}>{url}</a>
  );
};

const linkColumns: TableColumn<ExternalLinkMatch>[] = [
  translatedTableColumn(
    "record",
    "features.external_sources.record",
    ({ link }) => recordLink(link),
  ),
  translatedTableColumn(
    "external_id",
    "features.external_sources.external_id",
    ({ link }) => link.external_id ?? t("features.external_sources.not_named"),
  ),
  translatedTableColumn(
    "address",
    "features.external_sources.address",
    addressCell,
  ),
  translatedTableColumn(
    "created",
    "features.external_sources.created",
    ({ link }) => link.created,
  ),
];

const linkTable = defineTable(linkColumns);

/** One source: what it stores, and the rows that name it. */
const sourceSection = ({ links, source }: ExternalSourceEntry): Child => (
  <section>
    <h2>{source.name}</h2>
    <p>
      <strong>{t("features.external_sources.url_pattern")}</strong>{" "}
      <code>{source.url_pattern}</code>
    </p>
    <p>
      <strong>{t("features.external_sources.created")}</strong> {source.created}
    </p>
    {links.length === 0 ? (
      <p>{t("features.external_sources.no_links")}</p>
    ) : (
      renderTable(
        linkTable,
        links.map((link) => ({ link, source })),
      )
    )}
  </section>
);

export const adminExternalSourcesPage = flashDataPage<
  readonly ExternalSourceEntry[]
>("features.external_sources.name", "/admin/external-sources", (entries) => (
  <>
    <div class="prose">
      {entries.length === 0 ? (
        <p>{t("features.external_sources.empty")}</p>
      ) : (
        entries.map(sourceSection)
      )}
    </div>
    <GuideFooter href="/admin/guide#external-sources">
      {t("features.external_sources.guide_link")}
    </GuideFooter>
  </>
));
