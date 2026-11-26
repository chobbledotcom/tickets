// effects: pure
/** The reviews page body: the introduction, then customer reviews in the
 *  chobble-template card layout. The shell supplies the translated labels, so
 *  this module stays free of the request-scoped message catalog. */

import { escapeHtml } from "#jsx/escape-html.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { Review } from "#shared/reviews/types.ts";

/** The words a review card needs, supplied by the page shell. */
export type ReviewsLabels = {
  date: (date: string) => string;
  rating: (rating: number) => string;
  viewOnGoogle: string;
  viewReview: string;
};

/** The initials in a reviewer's avatar. The reviews schema guarantees a
 *  non-empty trimmed name, so there is always at least one word. */
export const reviewerInitials = (name: string): string => {
  const words = name.split(/\s+/);
  return (
    words.length === 1
      ? words[0]!.slice(0, 2)
      : words[0]!.charAt(0) + words.at(-1)!.charAt(0)
  ).toUpperCase();
};

/** One of the six avatar colours, chosen from the name so it never changes. */
export const reviewerTone = (name: string): number => {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return (hash % 6) + 1;
};

const reviewLinkLabel = (url: string, labels: ReviewsLabels): string =>
  url.includes("google.com") ? labels.viewOnGoogle : labels.viewReview;

const reviewLinkHtml = (review: Review, labels: ReviewsLabels): string =>
  `<a class="review-link" href="${escapeHtml(review.url)}" rel="nofollow noopener noreferrer" target="_blank">${reviewLinkLabel(review.url, labels)}</a>`;

const reviewCard = (review: Review, labels: ReviewsLabels): JSX.Element => (
  <li class="review-card">
    <div class="review-header">
      <span class="rating">
        <span aria-hidden="true">{"★".repeat(review.rating)}</span>
        <span class="visually-hidden">{labels.rating(review.rating)}</span>
      </span>
      <time class="date" datetime={review.date}>
        {labels.date(review.date)}
      </time>
    </div>
    <div class="review">
      <Raw html={renderMarkdown(review.text)} />
    </div>
    <div class="author-info">
      <span
        aria-hidden="true"
        class={`reviewer-avatar reviewer-avatar--tone-${reviewerTone(review.name)}`}
      >
        {reviewerInitials(review.name)}
      </span>
      <div class="author-details">
        <span class="name">{review.name}</span>
        <Raw html={reviewLinkHtml(review, labels)} />
      </div>
    </div>
  </li>
);

/** The page body: the reviews in their masonry list. */
export const reviewsBody = (
  reviews: readonly Review[],
  labels: ReviewsLabels,
): JSX.Element => (
  <ul class="reviews-grid">
    {reviews.map((review) => reviewCard(review, labels))}
  </ul>
);
