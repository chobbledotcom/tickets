/**
 * Admin guide — External sources section.
 *
 * The directory of where a site's records also appear in other systems. The
 * admin API writes it and the settings menu shows it.
 */

import {
  faqSection,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

/* jscpd:ignore-start -- a list of strings, not code */
/** The section's FAQ entry ids, in the order it shows them. */
const EXTERNAL_SOURCES_ENTRY_IDS = [
  "what_are_external_sources",
  "turn_external_sources_on",
  "external_source_url_pattern",
  "external_links_follow_records",
  "external_sources_api",
] as const;
/* jscpd:ignore-end */

export const externalSourcesSection: GuideSection = faqSection(
  "external_sources",
  EXTERNAL_SOURCES_ENTRY_IDS,
  "external-sources",
);
