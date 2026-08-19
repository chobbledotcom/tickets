/**
 * Builds a public content-page template (a news post, a site page): the shared
 * SEO shell wrapped around a body built from the item, its images, and the
 * public nav. The two page kinds differ only in that body (and shell options),
 * so each template file is just one `seoContentPage(...)` call.
 */

import type { Image } from "#types";
import { type PublicNavProps, publicSeoPage } from "./shared.tsx";

/** What the SEO shell reads off a content row. */
type SeoContent = Parameters<typeof publicSeoPage>[0];

export const seoContentPage =
  <T extends SeoContent>(
    options: Parameters<typeof publicSeoPage>[3],
    body: (
      item: T,
      images: readonly Image[],
      nav: PublicNavProps,
    ) => JSX.Element,
  ) =>
  (
    item: T,
    images: readonly Image[],
    nav: PublicNavProps,
    websiteTitle: string,
  ): string =>
    publicSeoPage(item, nav, websiteTitle, options)(body(item, images, nav));
