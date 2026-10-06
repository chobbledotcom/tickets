/** Product catalog reading and catalog-wide decisions.
 *
 *  Reads the product and category files of a catalog directory and holds the
 *  checks the importer runs over the whole catalog before it changes the
 *  site: the shared attribute vocabulary and the unique-title rule. The
 *  frontmatter rules themselves live in the pure module beside this one,
 *  product-catalog/parse.ts. */

import { isAbsolute, relative } from "@std/path";
import { normalizeEntityName } from "#db/name-registry.ts";
import {
  type CatalogProduct,
  parseCategoryTitle,
  parseProductFile,
} from "./product-catalog/parse.ts";

/** One product file: the parsed product and the exact text it was parsed
 * from, read once. Every later decision and the stamp use this snapshot, so
 * an edit that lands after the read cannot split what the importer writes
 * from what it stamps. */
export type CatalogFile = { product: CatalogProduct; text: string };

/** Read every product file of the directory, in the order the site shows
 * them. A linked entry refuses instead of being skipped, so a file the
 * operator believes went up never quietly stays home. */
export const readProducts = async (
  files: CatalogFiles,
  dir: string,
): Promise<CatalogFile[]> => {
  const products: CatalogFile[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isDirectory) continue;
    const text = await files.read(`${dir}/${entry.name}`);
    const product = parseProductFile(entry.name, text);
    if (product) products.push({ product, text });
  }
  return products.sort(
    (a, b) =>
      a.product.order - b.product.order ||
      a.product.filename.localeCompare(b.product.filename),
  );
};

/** One attribute and the distinct option texts its products carry, in
 * first-seen order. */
export type PlannedAttribute = {
  name: string;
  values: string[];
};

/** The attribute vocabulary the products share: every filter attribute name
 * with the distinct values seen for it, in the order the products introduce
 * them. */
export const attributeVocabulary = (
  products: readonly CatalogProduct[],
): PlannedAttribute[] => {
  const valuesByName = new Map<string, Set<string>>();
  for (const product of products) {
    for (const attribute of product.filterAttributes) {
      const values = valuesByName.get(attribute.name) ?? new Set<string>();
      values.add(attribute.value);
      valuesByName.set(attribute.name, values);
    }
  }
  return [...valuesByName].map(([name, values]) => ({
    name,
    values: [...values],
  }));
};

/** One catalog's verified file access. The catalog root's real path is taken
 *  once; every path the import reads must be a plain file whose real path
 *  stays inside that root. A linked file or folder must never widen what the
 *  import reads or move the trusted root. The resolved path is what the
 *  import reads and writes, so a link swapped in after the check cannot
 *  redirect a later call. */
export type CatalogFiles = {
  readonly root: string;
  read: (file: string) => Promise<string>;
  verify: (file: string) => Promise<string>;
};

export const catalogFiles = async (root: string): Promise<CatalogFiles> => {
  const realRoot = await Deno.realPath(root);
  const verify = async (file: string): Promise<string> => {
    const [realFile, entry] = await Promise.all([
      Deno.realPath(file),
      Deno.lstat(file),
    ]);
    // Containment by relative path: a prefix check would accept a POSIX
    // sibling named after the root plus a backslash.
    const rel = relative(realRoot, realFile);
    if (
      !entry.isFile ||
      rel === "" ||
      rel.startsWith("..") ||
      isAbsolute(rel)
    ) {
      throw new Error(
        `catalog file '${file}' must be a plain file inside the catalog`,
      );
    }
    return realFile;
  };
  return {
    read: async (file) => await Deno.readTextFile(await verify(file)),
    root,
    verify,
  };
};

/** The site's own title of one category file, or the slug when the file has
 * no usable title. A file that is missing, unreadable, unparseable, or a
 * link out of the catalog stops the import: a stale path must not quietly
 * create a wrongly named group. */
export const categoryTitle = async (
  files: CatalogFiles,
  categoriesDir: string,
  slug: string,
): Promise<string> => {
  const file = `${categoriesDir}/${slug}.md`;
  return parseCategoryTitle(file, await files.read(file));
};

/** One catalog category: its path slug and the site name its file carries. */
export type CategoryEntry = { name: string; slug: string };

/** The distinct category slugs of the catalog with their site names, resolved
 * before the first API call: a missing or unparseable category file stops the
 * import before it changes the site. */
export const readCategoryEntries = async (
  files: CatalogFiles,
  categoriesDir: string,
  slugs: readonly string[],
): Promise<CategoryEntry[]> => {
  const entries: CategoryEntry[] = [];
  for (const slug of slugs) {
    entries.push({
      name: await categoryTitle(files, categoriesDir, slug),
      slug,
    });
  }
  return entries;
};

/** The first spelling of a folded attribute name or option text, and the
 *  file that carried it. */
type FirstSpelling = { file: string; spelling: string };

/** The spellings already seen for one folded attribute name. */
type SeenAttribute = {
  first: FirstSpelling;
  values: Map<string, FirstSpelling>;
};

/** Record one product's attribute selection against the spellings already
 *  seen, and refuse a second spelling of one folded attribute name or option
 *  text: the site folds case and trims names, so both spellings are one
 *  record to it, the second spelling would create a duplicate, and the next
 *  import would fail the ambiguous-attribute check. */
const recordAttributeSpelling = (
  seen: Map<string, SeenAttribute>,
  product: CatalogProduct,
  name: string,
  value: string,
): void => {
  const nameKey = normalizeEntityName(name);
  let seenAttribute = seen.get(nameKey);
  if (seenAttribute === undefined) {
    seenAttribute = {
      first: { file: product.filename, spelling: name },
      values: new Map(),
    };
    seen.set(nameKey, seenAttribute);
  } else if (seenAttribute.first.spelling !== name) {
    throw new Error(
      `attribute '${seenAttribute.first.spelling}' and '${name}' are one attribute to the site (${seenAttribute.first.file} and ${product.filename}); use one spelling and rerun`,
    );
  }
  const valueKey = normalizeEntityName(value);
  const firstValue = seenAttribute.values.get(valueKey);
  if (firstValue !== undefined && firstValue.spelling !== value) {
    throw new Error(
      `attribute '${seenAttribute.first.spelling}' holds options '${firstValue.spelling}' and '${value}' (${firstValue.file} and ${product.filename}); they are one option to the site; use one spelling and rerun`,
    );
  }
  seenAttribute.values.set(valueKey, {
    file: product.filename,
    spelling: value,
  });
};

/** Refuse a catalog that spells one attribute name or option text two ways:
 * the site folds case and trims names, so two spellings are one attribute or
 * one option to it. The first import would create a duplicate under the
 * second spelling, and the next import would fail the ambiguous-attribute
 * check. */
export const ensureConsistentAttributeSpellings = (
  products: readonly CatalogProduct[],
): void => {
  const seen = new Map<string, SeenAttribute>();
  for (const product of products) {
    for (const { name, value } of product.filterAttributes) {
      recordAttributeSpelling(seen, product, name, value);
    }
  }
};

/** Refuse a catalog whose files share a title: the importer matches listings
 *  by title, so two files with one title would fight over the same listing. */
export const ensureUniqueTitles = (
  products: readonly CatalogProduct[],
): void => {
  // Keyed the way the server's name registry folds names: two titles that
  // differ only by case or surrounding whitespace are one listing to the
  // API, so both files would fight over the same create.
  const filesByTitle = new Map<string, string>();
  for (const product of products) {
    const key = normalizeEntityName(product.title);
    const seen = filesByTitle.get(key);
    if (seen !== undefined) {
      throw new Error(
        `duplicate product title '${product.title}' in ${seen} and ${product.filename}`,
      );
    }
    filesByTitle.set(key, product.filename);
  }
};
