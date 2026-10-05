#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net --allow-run
/** Import a markdown frontmatter catalog into a Tickets site.
 *
 *  One Tickets listing per product file in the catalog's src/products
 *  directory, with the product's filter attributes as site Attributes and
 *  its categories as groups. The listing ids and slugs are written back into
 *  the product files' frontmatter (tickets_id, tickets_slug), so the future
 *  integration can address them.
 *
 *  Reruns are safe: products whose frontmatter already carries a tickets_id
 *  are skipped, and attributes, options, and groups are matched by name before
 *  anything is created. A product whose title matches an existing listing is
 *  skipped until --update says otherwise. Use --plan to print what would
 *  happen and change nothing.
 *
 *  deno task cli:import-frontmatter [--plan] [--update] --dir <catalog>
 */

import { loadConfig } from "./config.ts";
import { type CurlOptions, curlJson } from "./curl.ts";
import { writeErr, writeOut } from "./io.ts";
import {
  attributeVocabulary,
  type CatalogProduct,
  categoryTitle,
  conflictLine,
  type ImportFlags,
  listingBody,
  optionKey,
  type PlannedAttribute,
  parseImportFlags,
  planLine,
  readProducts,
  resolveImportPlan,
  resolveOptionIds,
  storedTicketsId,
  withTicketsMeta,
} from "./product-catalog.ts";

const usage =
  "Usage: deno task cli:import-frontmatter [--plan] [--update] --dir <catalog directory>\n";

type ApiClient = <T>(options: CurlOptions) => Promise<T>;

type ApiAttribute = {
  id: number;
  name: string;
  options: { id: number; text: string }[];
};

type ApiNamed = { id: number; name: string; slug: string };

type Report = {
  conflicts: number;
  created: {
    attributes: number;
    groups: number;
    listings: number;
    options: number;
  };
  filesUpdated: number;
  skipped: number;
};

/** One attribute's values: reuse the stored options, create the missing ones
 * (or, in plan mode, only say what would happen). */
const syncAttributeOptions = async (
  api: ApiClient,
  name: string,
  values: readonly string[],
  attribute: ApiAttribute | undefined,
  plan: boolean,
  report: Report,
  optionIds: Map<string, number>,
): Promise<void> => {
  for (const value of values) {
    const option = attribute?.options.find((item) => item.text === value);
    if (option) {
      optionIds.set(optionKey(name, value), option.id);
      continue;
    }
    if (plan || !attribute) {
      await writeOut(`would create attribute ${name}: ${value}\n`);
      continue;
    }
    const created = await api<{ attribute: ApiAttribute }>({
      body: { text: value },
      method: "POST",
      path: `/api/admin/attributes/${attribute.id}/options`,
    });
    const newOption = created.attribute.options.find(
      (item) => item.text === value,
    );
    if (!newOption) throw new Error(`Option '${value}' missing after create`);
    optionIds.set(optionKey(name, value), newOption.id);
    report.created.options += 1;
    await writeOut(`created option ${name}: ${value}\n`);
  }
};

/** Create the site's attributes and options; returns option id by attribute
 * value. Existing attributes and options are matched by name and reused, so a
 * rerun never duplicates them. */
const syncAttributes = async (
  api: ApiClient,
  planned: readonly PlannedAttribute[],
  plan: boolean,
  report: Report,
): Promise<Map<string, number>> => {
  const existing = (
    await api<{ attributes: ApiAttribute[] }>({
      path: "/api/admin/attributes",
    })
  ).attributes;
  const optionIds = new Map<string, number>();
  for (const { name, values } of planned) {
    let attribute = existing.find((item) => item.name === name);
    if (!attribute && !plan) {
      const created = await api<{ attribute: ApiAttribute }>({
        body: { name },
        method: "POST",
        path: "/api/admin/attributes",
      });
      attribute = created.attribute;
      report.created.attributes += 1;
      await writeOut(`created attribute ${name}\n`);
    }
    await syncAttributeOptions(
      api,
      name,
      values,
      attribute,
      plan,
      report,
      optionIds,
    );
  }
  return optionIds;
};

/** Create the groups the categories need; returns group id by slug. */
const syncGroups = async (
  api: ApiClient,
  slugs: readonly string[],
  categoriesDir: string,
  plan: boolean,
  report: Report,
): Promise<Map<string, number>> => {
  const existing = (
    await api<{ groups: ApiNamed[] }>({
      path: "/api/admin/groups",
    })
  ).groups;
  const idsBySlug = new Map<string, number>();
  for (const slug of slugs) {
    const name = await categoryTitle(categoriesDir, slug);
    const group = existing.find((item) => item.name === name);
    if (group) {
      idsBySlug.set(slug, group.id);
      continue;
    }
    if (plan) {
      await writeOut(`would create group ${name}\n`);
      continue;
    }
    const created = await api<{ group: ApiNamed }>({
      body: { description: `Hire products for ${name} events.`, name },
      method: "POST",
      path: "/api/admin/groups",
    });
    idsBySlug.set(slug, created.group.id);
    report.created.groups += 1;
    await writeOut(`created group ${name}\n`);
  }
  return idsBySlug;
};

/** Import one product: skip it when its file already stores a tickets id,
 * skip a same-named listing until --update says otherwise, or create it; then
 * write the tickets ids into the file so a rerun skips it. */
const importProduct = async (
  api: ApiClient,
  product: CatalogProduct,
  productsDir: string,
  existing: readonly ApiNamed[],
  optionIds: ReadonlyMap<string, number>,
  groupIdsBySlug: ReadonlyMap<string, number>,
  flags: ImportFlags,
  report: Report,
): Promise<void> => {
  const file = `${productsDir}/${product.filename}.md`;
  const current = await Deno.readTextFile(file);
  const match = existing.find((listing) => listing.name === product.title);
  const plan = resolveImportPlan(
    storedTicketsId(current),
    match?.id,
    flags.update,
  );
  if (flags.plan) {
    await writeOut(planLine(plan, product));
    if (plan.action === "skip-imported") report.skipped += 1;
    if (plan.action === "skip-conflict") report.conflicts += 1;
    return;
  }
  if (plan.action === "skip-imported") {
    report.skipped += 1;
    return;
  }
  if (plan.action === "skip-conflict") {
    report.conflicts += 1;
    await writeOut(conflictLine(product, plan.listingId, false));
    return;
  }
  const body = listingBody(
    product,
    resolveOptionIds(product, optionIds),
    [...new Set(product.categories)]
      .map((slug) => groupIdsBySlug.get(slug))
      .filter((id): id is number => id !== undefined),
  );
  const saved = await api<{ listing: ApiNamed }>(
    plan.action === "update"
      ? { body, method: "PUT", path: `/api/admin/listings/${plan.listingId}` }
      : { body, method: "POST", path: "/api/admin/listings" },
  );
  report.created.listings += 1;
  await writeOut(
    `${plan.action === "update" ? "updated" : "created"} listing ${product.title} -> id ${saved.listing.id}\n`,
  );
  await Deno.writeTextFile(
    file,
    withTicketsMeta(current, {
      id: saved.listing.id,
      slug: saved.listing.slug,
    }),
  );
  report.filesUpdated += 1;
};

/** Run one listing action per product, then write the tickets ids into the
 * product file so a rerun skips it. A name conflict is the operator's choice. */
const importProducts = async (
  api: ApiClient,
  products: readonly CatalogProduct[],
  productsDir: string,
  optionIds: ReadonlyMap<string, number>,
  groupIdsBySlug: ReadonlyMap<string, number>,
  flags: ImportFlags,
  report: Report,
): Promise<void> => {
  const existing = (
    await api<{ listings: ApiNamed[] }>({
      path: "/api/admin/listings",
    })
  ).listings;
  for (const product of products) {
    await importProduct(
      api,
      product,
      productsDir,
      existing,
      optionIds,
      groupIdsBySlug,
      flags,
      report,
    );
  }
};

const main = async () => {
  const flags = parseImportFlags(Deno.args);
  if (!flags.dir) {
    await writeErr(usage);
    Deno.exit(2);
  }
  const config = await loadConfig(Deno.cwd());
  const api: ApiClient = <T>(options: CurlOptions) =>
    curlJson<T>(config, options);

  const productsDir = `${flags.dir}/src/products`;
  const products = await readProducts(productsDir);
  const report: Report = {
    conflicts: 0,
    created: { attributes: 0, groups: 0, listings: 0, options: 0 },
    filesUpdated: 0,
    skipped: 0,
  };

  const optionIds = await syncAttributes(
    api,
    attributeVocabulary(products),
    flags.plan,
    report,
  );
  const categorySlugs = [
    ...new Set(products.flatMap((product) => product.categories)),
  ];
  const groupIdsBySlug = await syncGroups(
    api,
    categorySlugs,
    `${flags.dir}/src/categories`,
    flags.plan,
    report,
  );
  await importProducts(
    api,
    products,
    productsDir,
    optionIds,
    groupIdsBySlug,
    flags,
    report,
  );

  await writeOut(
    `\ndone${flags.plan ? " (plan)" : ""}: ` +
      `${report.created.attributes} attributes, ${report.created.options} options, ` +
      `${report.created.groups} groups, ${report.created.listings} listings created, ` +
      `${report.skipped} already imported, ${report.conflicts} name conflicts, ` +
      `${report.filesUpdated} files updated\n`,
  );
};

try {
  await main();
} catch (error) {
  await writeErr(
    `frontmatter import failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  Deno.exit(1);
}
