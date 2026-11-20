/** The catalog and the scripted API that the import runner tests share. */

import type { AdminApiTransport } from "#shared/admin-api-client.ts";

/** A catalog with one product in one category. */
export const PRODUCT_FRONTMATTER = [
  "---",
  "title: Tumble Tower Hire",
  "filter_attributes:",
  "  - name: Guest Capacity",
  "    value: 50 guests",
  "categories:",
  "  - categories/tarps.md",
  "options:",
  "  - name: 1 Day",
  "    unit_price: 100",
  "---",
].join("\n");

export const CATEGORY_FRONTMATTER = "---\ntitle: Tarpaulins\n---\n";

/** Write files (paths relative to the catalog's src/) into a fresh temp
 *  catalog and return its path. */
export const seedCatalogFiles = async (
  files: Record<string, string>,
): Promise<string> => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/src/products`, { recursive: true });
  await Deno.mkdir(`${dir}/src/categories`, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/src/${name}`, text);
  }
  return dir;
};

/** The one-product, one-category catalog the tests share. */
export const seedCatalog = (productText: string): Promise<string> =>
  seedCatalogFiles({
    "categories/tarps.md": CATEGORY_FRONTMATTER,
    "products/tower.md": productText,
  });

export type ApiCall = { body: unknown; method: string; path: string };
export type Routes = Record<string, (body: unknown) => unknown>;

/** An API client stub that answers from `routes` and records every call. The
 *  route key is "METHOD path". The stub wraps each answer in the transport's
 *  `{ data }` envelope, so the client validates it like a real answer. */
export const scriptedApi = (
  routes: Routes,
): { api: AdminApiTransport; calls: ApiCall[] } => {
  const calls: ApiCall[] = [];
  const api: AdminApiTransport = async (options) => {
    const key = `${options.method} ${options.path}`;
    calls.push({
      body: options.body,
      method: options.method,
      path: options.path,
    });
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected API call: ${key}`);
    return { data: handler(options.body) };
  };
  return { api, calls };
};

export const callPaths = (calls: readonly ApiCall[]): string[] =>
  calls.map((call) => `${call.method} ${call.path}`);
