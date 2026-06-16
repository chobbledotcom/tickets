/**
 * Generic map-link helpers. Given a free-text place query (typically an
 * address), build "open in maps" URLs for the major providers so links work on
 * both Android/desktop (Google) and Apple devices. Kept provider-agnostic and
 * UI-free so it can be reused anywhere a location needs a directions link.
 */

/** A labelled map link to one provider. */
export type MapLink = {
  provider: "Google" | "Apple";
  url: string;
};

/** Google Maps search URL for a place query. */
export const googleMapsUrl = (query: string): string =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

/** Apple Maps search URL for a place query. */
export const appleMapsUrl = (query: string): string =>
  `https://maps.apple.com/?q=${encodeURIComponent(query)}`;

/**
 * Build both providers' links for a query, or an empty list when the query is
 * blank (nothing to link to). Order is stable: Google then Apple.
 */
export const mapLinks = (query: string): MapLink[] => {
  if (query.trim() === "") return [];
  return [
    { provider: "Google", url: googleMapsUrl(query) },
    { provider: "Apple", url: appleMapsUrl(query) },
  ];
};
