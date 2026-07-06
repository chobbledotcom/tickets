/**
 * Public news templates: the `/news` list (newest first, one shared Card per
 * post — name, snippet, first image) and the `/news/:id` post page (SEO meta,
 * the post's images as a CSS-only gallery, and the markdown body).
 *
 * The gallery is pure CSS: each image contributes a visually-hidden radio, a
 * full-size image, and a thumbnail `<label>` for that radio. The stylesheet
 * shows only the checked radio's full image (first-checked by default) at full
 * content width, with the thumbs wrapping in a flex row of up to five below —
 * clicking a thumb re-checks its radio and swaps the main image, no script.
 */

import { t } from "#i18n";
import { formatDatetimeShort } from "#shared/dates.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import type { Image, NewsPost, NewsPostCard } from "#shared/types.ts";
import { CARD_GRID_CLASS, cardInner } from "#templates/components/card.tsx";
import { escapeHtml } from "#templates/layout.tsx";
import {
  MarkdownProse,
  type PublicNavProps,
  publicPage,
  publicSeoPage,
  renderListingImage,
} from "./shared.tsx";

/** One post on the /news list: the shared Card wrapped in a link. */
const newsCard = (post: NewsPostCard): string =>
  `<a class="card news-card" href="/news/${post.id}">
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

/** One gallery entry: the radio, its full-size image, and (when the post has
 * more than one image, so there is something to swap to) its thumbnail label.
 * The three stay adjacent siblings — the stylesheet's `+` selectors depend on
 * that order. */
const galleryEntry = (
  image: Image,
  index: number,
  withThumb: boolean,
): JSX.Element => (
  <>
    <input
      checked={index === 0}
      class="news-gallery-radio"
      id={`news-gallery-${index}`}
      name="news-gallery"
      type="radio"
    />
    <img
      alt={image.alt_text || image.name}
      class="news-gallery-full"
      src={getImageProxyUrl(image.filename)}
    />
    {withThumb && (
      <label class="news-gallery-thumb" for={`news-gallery-${index}`}>
        <img
          alt={t("news.public.thumb_label", { number: index + 1 })}
          src={getImageProxyUrl(image.filename_thumb)}
        />
      </label>
    )}
  </>
);

/** The post's images: nothing without images; with them, the CSS-only gallery
 * (a single image renders just its full-width self — no thumbs to swap to). */
const NewsGallery = ({
  images,
}: {
  images: readonly Image[];
}): JSX.Element | null =>
  images.length === 0 ? null : (
    <fieldset class="news-gallery">
      <legend class="visually-hidden">{t("news.public.gallery_label")}</legend>
      {images.map((image, index) =>
        galleryEntry(image, index, images.length > 1),
      )}
    </fieldset>
  );

/** The /news/:id post page: SEO meta (like site pages), the published date,
 * the image gallery, and the markdown body. */
export const newsPostPage = (
  post: NewsPost,
  images: readonly Image[],
  nav: PublicNavProps,
  websiteTitle: string,
): string =>
  publicSeoPage(
    post,
    nav,
    websiteTitle,
  )(
    <>
      <p class="news-post-date">{formatDatetimeShort(post.created)}</p>
      <NewsGallery images={images} />
      <MarkdownProse markdown={post.content} />
    </>,
  );
