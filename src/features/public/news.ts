/**
 * Public `/news` — the news list and the single post pages.
 *
 * Gate order matters, exactly like `/page/:slug`: `requirePublicSite` runs
 * FIRST, so a disabled site redirects to the admin login without leaking
 * whether any posts (or a given post id) exist. The list 404s when there are
 * no posts at all — the nav only links `/news` once one exists, and a link we
 * would render must never 404.
 */

// jscpd:ignore-start
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
// jscpd:ignore-end
import {
  computeNewsSlugIndex,
  getNewsPostBySlugIndex,
  getNewsPostCards,
} from "#shared/db/news-posts.ts";
import { settings } from "#shared/db/settings.ts";
import { newsListPage, newsPostPage } from "#templates/public/news.tsx";
import { requirePublicSite } from "./pages.ts";
import { publicNavProps } from "./site-nav.ts";
import { publicSlugRoute, renderContentPage } from "./site-page.ts";

const handleNewsList = async (): Promise<Response> => {
  const [posts, nav] = await Promise.all([
    getNewsPostCards(),
    publicNavProps(null),
  ]);
  if (posts.length === 0) return notFoundResponse();
  return htmlResponse(newsListPage(posts, nav, settings.websiteTitle));
};

const handleNewsPost = async (slug: string): Promise<Response> => {
  const post = await getNewsPostBySlugIndex(await computeNewsSlugIndex(slug));
  return renderContentPage(post, "news", () => null, newsPostPage);
};

/** Route `/news` requests (public-site gate first, then the read). */
export const routeNews = createRouter(
  defineRoutes({
    "GET /news": () => requirePublicSite(handleNewsList),
    "GET /news/:slug": publicSlugRoute(handleNewsPost),
  }),
);
