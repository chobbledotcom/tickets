import { getSitePageById, sitePages } from "#db/site-pages.ts";
import { adminFormPost } from "#test-utils/session.ts";
import type { SitePage } from "#types";

export const BASE = "/admin/site/pages";

/** Create a page through the real create flow (assigns slug_index + order). */
export const create = async (
  slug: string,
  fields: Record<string, string> = {},
) => {
  const { response } = await adminFormPost(BASE, {
    name: `Name ${slug}`,
    slug,
    ...fields,
  });
  return response;
};

export const findPage = async (slug: string): Promise<SitePage> => {
  const rows = await sitePages.getAll();
  const row = rows.find((r) => r.slug === slug);
  if (!row) throw new Error(`page ${slug} not found`);
  return (await getSitePageById(row.id))!;
};
