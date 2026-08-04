/**
 * Public news templates: the `/news` list (newest first, one shared Card per
 * post — name, snippet, first image) and the `/news/:slug` post page (SEO meta,
 * the post's images as a CSS-only gallery, and the markdown body).
 *
 * The gallery is pure CSS: each image contributes a visually-hidden radio, a
 * full-size image, and a thumbnail `<label>` for that radio. The stylesheet
 * shows only the checked radio's full image (first-checked by default) at full
 * content width, with the thumbs wrapping in a flex row of up to five below —
 * clicking a thumb re-checks its radio and swaps the main image, no script.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { formatDateLongLabel } from "#shared/dates.ts";
import { escapeHtml } from "#shared/jsx/escape-html.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { NewsPost, NewsPostCard } from "#shared/types.ts";
import { CARD_GRID_CLASS, cardInner } from "#templates/components/card.tsx";
import { seoContentPage } from "./content-page.tsx";
import {
  PublicImageGallery,
  type PublicNavProps,
  publicPage,
  renderListingImage,
} from "./shared.tsx";

/* jscpd:ignore-end */

/** One post on the /news list: the shared Card wrapped in a link. */
const newsCard = (post: NewsPostCard): string =>
  `<a class="card news-card" href="/news/${escapeHtml(post.slug)}">
      ${cardInner({
        detailHtml: post.snippet
          ? `<span class="news-card-snippet">${escapeHtml(post.snippet)}</span>`
          : "",
        imageHtml: renderListingImage(post, "card-image", { thumb: true }),
        name: post.name,
      })}
    </a>`;

/** The /news list page — every post, newest first, no pagination. */
export const newsListPage = (
  posts: NewsPostCard[],
  nav: PublicNavProps,
  websiteTitle: string,
): string => {
  const newsTitle = t("nav.public.news");
  const title = websiteTitle ? `${newsTitle} - ${websiteTitle}` : newsTitle;
  return publicPage(
    title,
    websiteTitle,
    nav,
  )(
    <div class={CARD_GRID_CLASS}>
      <Raw html={posts.map(newsCard).join("")} />
    </div>,
  );
};

/** The /news/:slug post page: SEO meta (like site pages) and one `.prose`
 * block that folds the title, the published date (a plain date, no time, in
 * italics), the image gallery, and the markdown body together — so the heading
 * and date read as part of the article rather than page chrome. The shared
 * shell renders no `<h1>` of its own (`showHeading: false`); this page supplies
 * it inside the prose. */
export const newsPostPage = seoContentPage<NewsPost>(
  { showHeading: false },
  (post, images) => (
    <div class="prose">
      <h1>{post.name}</h1>
      <p class="news-post-date">
        <em>{formatDateLongLabel(post.created)}</em>
      </p>
      <PublicImageGallery images={images} />
      {post.content && <Raw html={renderMarkdown(post.content)} />}
    </div>
  ),
);
