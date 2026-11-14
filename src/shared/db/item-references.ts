/** What points at a listing or a group from outside its own tables. */

import {
  clearExternalLinksStatement,
  externalLinkTargets,
} from "#db/external-sources/target.ts";
import { clearImageUsesForItemStatement, imageUseTargets } from "#db/images.ts";
import { clearItemEdgesStatement } from "#db/site-page-items.ts";
import type { SqlStatement } from "#db/sql.ts";
import { sitePageItemTargets } from "#shared/site-pages/target.ts";

/** Remove every site page item, image use and external link that points at
 * one listing or one group. The delete of the record rides in the same batch,
 * so no page keeps a link to a record that is gone. */
export const clearItemReferencesStatements = (
  kind: "group" | "listing",
  id: number,
): SqlStatement[] => [
  clearItemEdgesStatement(sitePageItemTargets.of(kind)(id)),
  clearImageUsesForItemStatement(imageUseTargets.of(kind)(id)),
  clearExternalLinksStatement(externalLinkTargets.of(kind)(id)),
];
