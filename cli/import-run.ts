import { normalizeEntityName } from "#db/name-registry.ts";
import {
  type AdminApiTransport,
  adminApiChildCreate,
  adminApiList,
  adminApiWrite,
} from "#shared/admin-api-client.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiAttribute,
  type AdminApiGroup,
} from "#shared/admin-api-resources.ts";
import { requireValue } from "#shared/required-value.ts";
import { writeOut } from "./io.ts";
import type { CatalogProduct } from "./product-catalog/parse.ts";
import {
  attributeVocabulary,
  type CatalogFiles,
  type CategoryEntry,
  catalogFiles,
  ensureConsistentAttributeSpellings,
  ensureUniqueTitles,
  type PlannedAttribute,
  readCategoryEntries,
  readProducts,
} from "./product-catalog.ts";
import {
  conflictLine,
  ensureNamespaceFree,
  type ImportFlags,
  type ImportPlan,
  listingBody,
  matchedIds,
  optionKey,
  planLine,
  refuseChangedFile,
  resolveImportPlan,
  resolveOptionIds,
  storedTicketsId,
  withTicketsMeta,
} from "./product-plan.ts";

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
  updated: number;
};

/** One attribute's values: reuse the stored options, create the missing ones
 * (or, in plan mode, only say what would happen). */
const syncAttributeOptions = async (
  transport: AdminApiTransport,
  name: string,
  values: readonly string[],
  attribute: AdminApiAttribute | undefined,
  plan: boolean,
  report: Report,
  optionIds: Map<string, number>,
): Promise<void> => {
  for (const value of values) {
    // Two options with one text inside one attribute are indistinguishable:
    // the importer never attaches listings to an arbitrary one by API order.
    const matches = attribute?.options.filter(
      (item) => normalizeEntityName(item.text) === normalizeEntityName(value),
    );
    if (matches && matches.length > 1) {
      throw new Error(
        `attribute '${name}' has ${matches.length} options named '${value}'; delete all but one on the site and rerun`,
      );
    }
    const option = matches?.[0];
    if (option) {
      optionIds.set(optionKey(name, value), option.id);
      continue;
    }
    if (plan || !attribute) {
      await writeOut(`would create attribute ${name}: ${value}\n`);
      continue;
    }
    const created = await adminApiChildCreate(
      transport,
      ADMIN_API_RESOURCES.attributes,
      "options",
      attribute.id,
      { text: value },
    );
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
  transport: AdminApiTransport,
  planned: readonly PlannedAttribute[],
  plan: boolean,
  report: Report,
): Promise<Map<string, number>> => {
  const existing = (
    await adminApiList(transport, ADMIN_API_RESOURCES.attributes)
  ).attributes;
  const optionIds = new Map<string, number>();
  for (const { name, values } of planned) {
    // The server folds case and trims names: a same-named attribute under
    // another spelling is the same attribute. Two under one name are the
    // operator's to separate; the importer never picks one by API order.
    const matches = existing.filter(
      (item) => normalizeEntityName(item.name) === normalizeEntityName(name),
    );
    if (matches.length > 1) {
      throw new Error(
        `attribute '${name}' matches ${matches.length} existing attributes; rename all but one on the site and rerun`,
      );
    }
    let attribute = matches[0];
    if (!attribute && !plan) {
      const created = await adminApiWrite(
        transport,
        ADMIN_API_RESOURCES.attributes,
        "create",
        undefined,
        { name },
      );
      attribute = created.attribute;
      report.created.attributes += 1;
      await writeOut(`created attribute ${name}\n`);
    }
    await syncAttributeOptions(
      transport,
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

/** Create the groups the categories need; returns group id by slug. The
 * category names arrive preflighted, so no file is read here, and the group
 * list arrives from the same snapshot the namespace preflight read. */
const syncGroups = async (
  transport: AdminApiTransport,
  existing: readonly AdminApiGroup[],
  entries: readonly CategoryEntry[],
  plan: boolean,
  report: Report,
): Promise<Map<string, number>> => {
  const idsBySlug = new Map<string, number>();
  for (const { name, slug } of entries) {
    // The server folds case and trims names, so match the way it does: a
    // same-named group under another spelling is the same group.
    const matches = existing.filter(
      (item) => normalizeEntityName(item.name) === normalizeEntityName(name),
    );
    if (matches.length > 1) {
      throw new Error(
        `group '${name}' matches ${matches.length} existing groups; rename all but one on the site and rerun`,
      );
    }
    const group = matches[0];
    if (group) {
      // A package is a bookable bundle, not a category: attaching imported
      // products to it by name would change the package's contents.
      if (group.is_package) {
        throw new Error(
          `group '${name}' is a package; the catalog needs a separate category group; rename one and rerun`,
        );
      }
      idsBySlug.set(slug, group.id);
      continue;
    }
    if (plan) {
      await writeOut(`would create group ${name}\n`);
      continue;
    }
    const created = await adminApiWrite(
      transport,
      ADMIN_API_RESOURCES.groups,
      "create",
      undefined,
      {
        description: `Hire products for ${name} events.`,
        name,
      },
    );
    idsBySlug.set(slug, created.group.id);
    report.created.groups += 1;
    await writeOut(`created group ${name}\n`);
  }
  return idsBySlug;
};

/** Import one product from its decided plan, then write the tickets ids into
 * the file so a rerun skips it. The text is the snapshot every decision read,
 * so a file an editor touches mid-run is stamped from the same content the
 * listing was written from. */
const importProduct = async (
  transport: AdminApiTransport,
  product: CatalogProduct,
  text: string,
  plan: ImportPlan,
  files: CatalogFiles,
  optionIds: ReadonlyMap<string, number>,
  groupIdsBySlug: ReadonlyMap<string, number>,
  flags: ImportFlags,
  report: Report,
): Promise<void> => {
  const relative = `src/products/${product.filename}.md`;
  const file = await files.verify(`${files.root}/${relative}`);
  if (flags.plan) {
    await writeOut(planLine(plan, product));
    if (plan.action === "skip-imported") report.skipped += 1;
    if (plan.action === "skip-conflict" || plan.action === "skip-ambiguous") {
      report.conflicts += 1;
    }
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
  if (plan.action === "skip-ambiguous") {
    report.conflicts += 1;
    await writeOut(
      `skipped listing ${product.title}: the name matches listings ` +
        `${plan.listingIds.join(" and ")}; rename one on the site and rerun\n`,
    );
    return;
  }
  const body = listingBody(
    product,
    resolveOptionIds(product, optionIds),
    [...new Set(product.categories)].map((slug) =>
      requireValue(
        groupIdsBySlug.get(slug),
        `group '${slug}' has no id after the group sync`,
      ),
    ),
  );
  const saved =
    plan.action === "update"
      ? await adminApiWrite(
          transport,
          ADMIN_API_RESOURCES.listings,
          "update",
          plan.listingId,
          body,
        )
      : await adminApiWrite(
          transport,
          ADMIN_API_RESOURCES.listings,
          "create",
          undefined,
          body,
        );
  if (plan.action === "update") report.updated += 1;
  else report.created.listings += 1;
  await writeOut(
    `${
      plan.action === "update" ? "updated" : "created"
    } listing ${product.title} -> id ${saved.listing.id}\n`,
  );
  refuseChangedFile(
    file,
    text,
    await files.read(`${files.root}/${relative}`),
    saved.listing.id,
  );
  await Deno.writeTextFile(
    file,
    withTicketsMeta(text, {
      id: saved.listing.id,
      slug: saved.listing.slug,
    }),
  );
  report.filesUpdated += 1;
};

/** One import run against one API client: read the catalog, plan, sync, and
 *  report. Split from the entry point so tests can run it against a stubbed
 *  client. */
export const runImport = async (
  flags: ImportFlags & { dir: string },
  transport: AdminApiTransport,
): Promise<Report> => {
  const files = await catalogFiles(flags.dir);
  const catalog = await readProducts(files, `${flags.dir}/src/products`);
  ensureUniqueTitles(catalog.map(({ product }) => product));
  // The category titles must be the catalog's own before the import reads
  // anything from the site, so they resolve here; only the active products'
  // titles sync after the reads.
  await readCategoryEntries(
    files,
    `${flags.dir}/src/categories`,
    catalog.flatMap(({ product }) => product.categories),
  );
  const existing = (await adminApiList(transport, ADMIN_API_RESOURCES.listings))
    .listings;
  const existingGroups = (
    await adminApiList(transport, ADMIN_API_RESOURCES.groups)
  ).groups;
  // Every plan is decided before the first write: only products that will be
  // created or updated drive the attribute, option, and group syncs, so a
  // rerun cannot leave site records behind for products it then skips.
  const plans = new Map<string, ImportPlan>(
    catalog.map(({ product, text }) => {
      const storedId = storedTicketsId(product.filename, text);
      return [
        product.filename,
        resolveImportPlan(
          storedId === null
            ? null
            : {
                filename: product.filename,
                id: storedId,
                title: product.title,
              },
          matchedIds(product.title, existing),
          flags.update,
          existing,
        ),
      ];
    }),
  );
  const active = catalog.filter(({ product }) => {
    const plan = plans.get(product.filename)!;
    return plan.action === "create" || plan.action === "update";
  });
  const report: Report = {
    conflicts: 0,
    created: { attributes: 0, groups: 0, listings: 0, options: 0 },
    filesUpdated: 0,
    skipped: 0,
    updated: 0,
  };

  // Preflighted before syncAttributes: the names must exist before the
  // import changes anything on the site.
  const categoryEntries = await readCategoryEntries(
    files,
    `${flags.dir}/src/categories`,
    [...new Set(active.flatMap(({ product }) => product.categories))],
  );
  // Both preflights read nothing but the two name snapshots, and both must
  // pass before the first write: a refusal here leaves the site untouched.
  ensureNamespaceFree(
    active.map(({ product }) => product),
    categoryEntries,
    existing,
    existingGroups,
  );
  ensureConsistentAttributeSpellings(active.map(({ product }) => product));
  const optionIds = await syncAttributes(
    transport,
    attributeVocabulary(active.map(({ product }) => product)),
    flags.plan,
    report,
  );
  const groupIdsBySlug = await syncGroups(
    transport,
    existingGroups,
    categoryEntries,
    flags.plan,
    report,
  );
  for (const { product, text } of catalog) {
    await importProduct(
      transport,
      product,
      text,
      plans.get(product.filename)!,
      files,
      optionIds,
      groupIdsBySlug,
      flags,
      report,
    );
  }

  await writeOut(
    `\ndone${flags.plan ? " (plan)" : ""}: ` +
      `${report.created.attributes} attributes, ${report.created.options} options, ` +
      `${report.created.groups} groups, ${report.created.listings} listings created, ` +
      `${report.updated} listings updated, ${report.skipped} already imported, ` +
      `${report.conflicts} name conflicts, ${report.filesUpdated} files updated\n`,
  );
  return report;
};
