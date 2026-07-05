import { formatDateLabel } from "#shared/dates.ts";
import { buildEmbedSnippets } from "#shared/embed.ts";
import type { ListingWithCount } from "#shared/types.ts";

export const formatBookableDays = (days: string[]): string => days.join(", ");

export const listingLinksFor = (
  listing: ListingWithCount,
  allowedDomain: string,
): { ticketUrl: string; embedScriptCode: string; embedIframeCode: string } => {
  const ticketUrl = `https://${allowedDomain}/ticket/${listing.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } =
    buildEmbedSnippets(ticketUrl);
  return { embedIframeCode, embedScriptCode, ticketUrl };
};

export const attendeeCountLabelSuffix = (
  isDaily: boolean,
  dateFilter: string | null,
): string =>
  isDaily
    ? dateFilter
      ? ` (${formatDateLabel(dateFilter)})`
      : " (total)"
    : "";
