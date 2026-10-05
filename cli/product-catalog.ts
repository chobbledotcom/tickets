/** Product catalog reading, mapping, and import decisions.
 *
 *  Reads the markdown product files (frontmatter only), builds the attribute
 *  vocabulary the products share, and maps one product to the listing body the
 *  admin JSON API accepts. Pure over its inputs: every function here is
 *  data-in/data-out so the import stays testable without the site. */

import { parse } from "jsr:@std/yaml@1";
import { normalizeEntityName } from "#db/name-registry.ts";
import { MAX_DURATION_DAYS } from "#types";

/** One rental-period option as the site stores it. */
export type CatalogOption = {
  days: number;
  max_quantity: number;
  name: string;
  unit_price: number;
};

export type CatalogFilterAttribute = { name: string; value: string };

export type CatalogProduct = {
  categories: string[];
  features: string[];
  /** The product file name without its extension, e.g. "batak-lite". */
  filename: string;
  filterAttributes: CatalogFilterAttribute[];
  order: number;
  options: CatalogOption[];
  specs: { name: string; value: string }[];
  subtitle: string;
  title: string;
};

/** Attribute names that mean the same thing; the first name wins. */
const ATTRIBUTE_NAME_ALIASES: Record<string, string> = {
  "Mains power required": "Power Required",
};

const canonicalAttributeName = (name: string): string =>
  ATTRIBUTE_NAME_ALIASES[name] ?? name;

const asString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(asString).filter((item) => item !== "") : [];

/** The frontmatter block of a markdown file, or null when the file opens with
 *  no closing fence. Windows line endings read like Unix ones. */
export const frontmatterBlock = (text: string): string | null => {
  const normalized = text.replaceAll("\r\n", "\n");
  return /^---\n([\s\S]*?)\n---/.exec(normalized)?.[1] ?? null;
};

/** One option number, read strictly: a missing field falls back only where a
 *  fallback is given, a price never defaults, and anything non-numeric stops
 *  the import naming the file and the option. */
const optionNumber = (
  filename: string,
  optionName: string,
  field: string,
  raw: unknown,
  fallback: number | undefined,
): number => {
  if (raw === undefined || raw === null || raw === "") {
    if (fallback === undefined) {
      throw new Error(`${filename}: option '${optionName}' needs a ${field}`);
    }
    return fallback;
  }
  if (typeof raw === "boolean") {
    throw new Error(
      `${filename}: option '${optionName}' has a non-numeric ${field}`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `${filename}: option '${optionName}' has a non-numeric ${field}`,
    );
  }
  // A day count or a quantity below one, or a negative price, would book
  // nonsense; days and max_quantity count whole days and whole bookings.
  if (field === "unit_price") {
    if (parsed < 0) {
      throw new Error(
        `${filename}: option '${optionName}' has a negative ${field}`,
      );
    }
    return parsed;
  }
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${filename}: option '${optionName}' has a ${field} that is not a positive whole number`,
    );
  }
  // The application clamps bookings to MAX_DURATION_DAYS and silently drops
  // day prices past it, so a longer catalog option would import half-lost.
  if (field === "days" && parsed > MAX_DURATION_DAYS) {
    throw new Error(
      `${filename}: option '${optionName}' books ${parsed} days, above the maximum of ${MAX_DURATION_DAYS}`,
    );
  }
  return parsed;
};

/** The product's site order: a missing field sorts first, and anything
 * non-numeric stops the import naming the file. */
const orderNumber = (filename: string, value: unknown): number => {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${filename}: order is not a number`);
  }
  return parsed;
};

/** The frontmatter mapping of one file, or an empty one when the file holds
 * none. A YAML error names its file: the importer stops before it writes. */
const parseFrontmatter = (
  filename: string,
  block: string,
): Record<string, unknown> => {
  try {
    const parsed = parse(block);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    throw new Error(
      `${filename}: unparseable frontmatter: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

/** The entries of one frontmatter list. A supplied entry that holds no fields
 * (null, a scalar, an array) is malformed external data and stops the import
 * naming the file and the field; it must not read as an absent entry. */
const recordEntries = (
  filename: string,
  field: string,
  raw: unknown,
): Record<string, unknown>[] => {
  if (!Array.isArray(raw)) return [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `${filename}: ${field} holds an entry that is not a name/value record`,
      );
    }
  }
  return raw as Record<string, unknown>[];
};

/** A product's rental options, validated: a price is required, two options
 * that book one day count would silently replace each other's price in the
 * day-price map, and an option-less product would write nonsense into the
 * listing body. Each failure names the file. */
const parseOptions = (
  filename: string,
  raw: unknown,
): CatalogProduct["options"] => {
  const named = recordEntries(filename, "options", raw)
    .map((option) => ({ name: asString(option.name), option }))
    .filter((entry) => entry.name !== "");
  if (named.length === 0) {
    throw new Error(`${filename}: a product needs at least one rental option`);
  }
  const options = named.map(({ name, option }) => ({
    days: optionNumber(filename, name, "days", option.days, 1),
    max_quantity: optionNumber(
      filename,
      name,
      "max_quantity",
      option.max_quantity,
      10,
    ),
    name,
    unit_price: optionNumber(
      filename,
      name,
      "unit_price",
      option.unit_price,
      undefined,
    ),
  }));
  const seenDays = new Set<number>();
  for (const option of options) {
    if (seenDays.has(option.days)) {
      throw new Error(`${filename}: two options book ${option.days} day(s)`);
    }
    seenDays.add(option.days);
  }
  return options;
};

/** Parse one product file's frontmatter, or null when it holds no product. */
export const parseProductFile = (
  filename: string,
  text: string,
): CatalogProduct | null => {
  if (!filename.endsWith(".md")) return null;
  const block = frontmatterBlock(text);
  if (block === null) return null;
  const front = parseFrontmatter(filename, block);
  const title = asString(front.title);
  if (title === "") return null;
  return {
    categories: asStringList(front.categories).map((path) =>
      path
        .replace(/^src\//, "")
        .replace(/\.md$/, "")
        .replace(/^categories\//, ""),
    ),
    features: asStringList(front.features),
    filename: filename.replace(/\.md$/, ""),
    filterAttributes: recordEntries(
      filename,
      "filter_attributes",
      front.filter_attributes,
    )
      .map((attribute) => {
        const name = canonicalAttributeName(asString(attribute.name));
        const value = asString(attribute.value);
        // A half-filled entry (a misspelled field, say `values:`) must not
        // read as no selection: the import would lose the attribute quietly.
        if ((name === "") !== (value === "")) {
          throw new Error(
            `${filename}: a filter attribute needs both a name and a value`,
          );
        }
        return { name, value };
      })
      .filter((attribute) => attribute.name !== ""),
    options: parseOptions(filename, front.options),
    order: orderNumber(filename, front.order),
    specs: recordEntries(filename, "specs", front.specs)
      .map((spec) => ({
        name: asString(spec.name),
        value: asString(spec.value),
      }))
      .filter((spec) => spec.name !== ""),
    subtitle: asString(front.subtitle),
    title,
  };
};

/** One product file: the parsed product and the exact text it was parsed
 * from, read once. Every later decision and the stamp use this snapshot, so
 * an edit that lands after the read cannot split what the importer writes
 * from what it stamps. */
export type CatalogFile = { product: CatalogProduct; text: string };

/** Read every product file of the directory, in the order the site shows
 * them. */
export const readProducts = async (dir: string): Promise<CatalogFile[]> => {
  const files: CatalogFile[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isFile) continue;
    const text = await Deno.readTextFile(`${dir}/${entry.name}`);
    const product = parseProductFile(entry.name, text);
    if (product) files.push({ product, text });
  }
  return files.sort(
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

export const categoryTitle = async (
  categoriesDir: string,
  slug: string,
): Promise<string> => {
  const text = await Deno.readTextFile(`${categoriesDir}/${slug}.md`);
  const front = frontmatterBlock(text);
  let parsed: unknown;
  try {
    parsed = front === null ? {} : parse(front);
  } catch (error) {
    throw new Error(
      `${categoriesDir}/${slug}.md: unparseable frontmatter: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const record =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const title = typeof record.title === "string" ? record.title.trim() : "";
  return title === "" ? slug : title;
};

/** One catalog category: its path slug and the site name its file carries. */
export type CategoryEntry = { name: string; slug: string };

/** The site's own title of one category file, or the slug when the file has
 *  no usable title. A file that is missing, unreadable, or unparseable stops
 *  the import: a stale path must not quietly create a wrongly named group. */
/** The distinct category slugs of the catalog with their site names, resolved
 * before the first API call: a missing or unparseable category file stops the
 * import before it changes the site. */
export const readCategoryEntries = async (
  categoriesDir: string,
  slugs: readonly string[],
): Promise<CategoryEntry[]> => {
  const entries: CategoryEntry[] = [];
  for (const slug of slugs) {
    entries.push({ name: await categoryTitle(categoriesDir, slug), slug });
  }
  return entries;
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
