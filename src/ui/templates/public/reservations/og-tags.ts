/** OpenGraph head tags for a public listing page. */

/* jscpd:ignore-start */
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";
import type { ItemImageProjection } from "#shared/types.ts";
import { escapeHtml } from "#templates/layout.tsx";
/* jscpd:ignore-end */

/** OpenGraph meta tags for a public listing page. */
export const buildOgTags = (
  listing: {
    name: string;
    description?: string | null | undefined;
    image_alt_text?: string | undefined;
    slug: string;
    image_url: string;
  },
  baseUrl: string,
): string => {
  const tags = [
    `<meta property="og:title" content="${escapeHtml(listing.name)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escapeHtml(baseUrl)}/ticket/${escapeHtml(
      listing.slug,
    )}">`,
  ];
  if (listing.description) {
    tags.push(
      `<meta property="og:description" content="${escapeHtml(
        listing.description,
      )}">`,
    );
  }
  if (listing.image_url) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(baseUrl)}${escapeHtml(
        getImageProxyUrl(listing.image_url),
      )}">`,
    );
    if (listing.image_alt_text) {
      tags.push(
        `<meta property="og:image:alt" content="${escapeHtml(
          listing.image_alt_text,
        )}">`,
      );
    }
  }
  return tags.join("\n");
};

/** Build the OG head extra for the ticket page from its header bits, or
 * `undefined` when there is no header image / name / base url to tag from. */
export const ticketPageHeadExtra = (
  headerImage: ItemImageProjection | null,
  headerName: string | undefined,
  headerDescription: string | null | undefined,
  slugs: string[],
  baseUrl: string | undefined,
): string | undefined => {
  if (!headerImage || !headerName || !baseUrl) return;
  return buildOgTags(
    {
      description: headerDescription,
      image_alt_text: headerImage.image_alt_text,
      image_url: headerImage.image_url,
      name: headerName,
      slug: slugs.join("+"),
    },
    baseUrl,
  );
};
