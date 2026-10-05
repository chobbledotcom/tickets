/** Product catalog reading, mapping, and import decisions.
 *
 *  Reads the markdown product files (frontmatter only), builds the attribute
 *  vocabulary the products share, and maps one product to the listing body the
 *  admin JSON API accepts. Pure over its inputs: every function here is
 *  data-in/data-out so the import stays testable without the site. */

import { parse } from "jsr:@std/yaml@1";

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

/** Parse one product file's frontmatter, or null when it holds no product. */
export const parseProductFile = (
  filename: string,
  text: string,
): CatalogProduct | null => {
  if (!filename.endsWith(".md")) return null;
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return null;
  const front = parse(match[1]) as Record<string, unknown>;
  const title = asString(front.title);
  if (title === "") return null;
  const options = (Array.isArray(front.options) ? front.options : [])
    .map((raw) => {
      const option = raw as Record<string, unknown>;
      return {
        days: Number(option.days ?? 1),
        max_quantity: Number(option.max_quantity ?? 10),
        name: asString(option.name),
        unit_price: Number(option.unit_price ?? 0),
      };
    })
    .filter((option) => option.name !== "");
  // The listing body computes duration and quantity as the options' maximum,
  // so an option-less product would write nonsense. Fail before any API call,
  // naming the file.
  if (options.length === 0) {
    throw new Error(`${filename}: a product needs at least one rental option`);
  }
  const specs = (Array.isArray(front.specs) ? front.specs : [])
    .map((raw) => {
      const spec = raw as Record<string, unknown>;
      return { name: asString(spec.name), value: asString(spec.value) };
    })
    .filter((spec) => spec.name !== "");
  return {
    categories: asStringList(front.categories).map((path) =>
      path
        .replace(/^src\//, "")
        .replace(/\.md$/, "")
        .replace(/^categories\//, ""),
    ),
    features: asStringList(front.features),
    filename: filename.replace(/\.md$/, ""),
    filterAttributes: (Array.isArray(front.filter_attributes)
      ? front.filter_attributes
      : []
    )
      .map((raw) => {
        const attribute = raw as Record<string, unknown>;
        return {
          name: canonicalAttributeName(asString(attribute.name)),
          value: asString(attribute.value),
        };
      })
      .filter((attribute) => attribute.name !== "" && attribute.value !== ""),
    options,
    order: Number(front.order ?? 0),
    specs,
    subtitle: asString(front.subtitle),
    title,
  };
};

/** Read every product file of the directory, in the order the site shows them. */
export const readProducts = async (dir: string): Promise<CatalogProduct[]> => {
  const products: CatalogProduct[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isFile) continue;
    const text = await Deno.readTextFile(`${dir}/${entry.name}`);
    const product = parseProductFile(entry.name, text);
    if (product) products.push(product);
  }
  return products.sort(
    (a, b) => a.order - b.order || a.filename.localeCompare(b.filename),
  );
};

/** The flags the Markdown Frontmatter Importer accepts. */
export type ImportFlags = {
  dir: string | undefined;
  plan: boolean;
  update: boolean;
};

/** Read the importer's flags. `--dir` needs its own operand: a missing one or
 * one that reads as another flag is an error, not a silent default. */
export const parseImportFlags = (args: readonly string[]): ImportFlags => {
  const flags: ImportFlags = { dir: undefined, plan: false, update: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--plan") flags.plan = true;
    else if (arg === "--update") flags.update = true;
    else if (arg === "--dir") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--dir requires a directory");
      }
      flags.dir = value;
      index += 1;
    }
  }
  return flags;
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

/** Minor-unit price for a whole-pound hire price. */
export const minorUnits = (pounds: number): number => Math.round(pounds * 100);

/** The booking-page description: the site's own subtitle, spec list, and
 * what-is-included list, in that order. */
export const composeDescription = (product: CatalogProduct): string => {
  const parts: string[] = [];
  if (product.subtitle !== "") parts.push(product.subtitle);
  if (product.specs.length > 0) {
    parts.push(
      [
        "### Specifications",
        ...product.specs.map((spec) => `- ${spec.name}: ${spec.value}`),
      ].join("\n"),
    );
  }
  if (product.features.length > 0) {
    parts.push(
      [
        "### What's included",
        ...product.features.map((feature) => `- ${feature}`),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
};

/** The listing the admin JSON API accepts for one product. Prices are minor
 * units; the day-count prices carry the rental-period options. `optionIds`
 * and `groupIds` are the resolved ids of the product's attribute selection and
 * category memberships. */
export const listingBody = (
  product: CatalogProduct,
  optionIds: readonly number[],
  groupIds: readonly number[],
) => {
  const maxDays = Math.max(...product.options.map((option) => option.days));
  const dayPrices = Object.fromEntries(
    product.options.map((option) => [
      String(option.days),
      minorUnits(option.unit_price),
    ]),
  );
  const maxQuantity = Math.max(
    ...product.options.map((option) => option.max_quantity),
  );
  return {
    attribute_option_ids: [...optionIds],
    customisable_days: true,
    day_prices: dayPrices,
    description: composeDescription(product),
    duration_days: maxDays,
    fields: "email,phone,address",
    group_ids: [...groupIds],
    hidden: true,
    listing_type: "daily" as const,
    max_attendees: 1,
    max_quantity: maxQuantity,
    name: product.title,
  };
};

/** Insert or replace the tickets ids in a product file's frontmatter, before
 * the closing fence. A stored placeholder (`tickets_id:` with no value) is
 * replaced like any stored value, so a partly stamped file still stamps. */
export const withTicketsMeta = (
  text: string,
  meta: { id: number; slug: string },
): string => {
  const stripped = text
    .replace(/^tickets_id:.*\n?/m, "")
    .replace(/^tickets_slug:.*\n?/m, "");
  const closing = stripped.indexOf("\n---", 4);
  if (closing === -1) return text;
  const insertion = `tickets_id: ${meta.id}\ntickets_slug: ${meta.slug}`;
  return `${stripped.slice(0, closing)}\n${insertion}${stripped.slice(closing)}`;
};

/** The option id of one attribute value, keyed "AttributeName\nOptionText". */
export const optionKey = (name: string, value: string): string =>
  `${name}\n${value}`;

/** The option ids a product selects, in the order its file lists them. The
 * importer creates every option the catalog vocabulary plans, so a missing id
 * names a real gap and stops the import. */
export const resolveOptionIds = (
  product: CatalogProduct,
  optionIds: ReadonlyMap<string, number>,
): number[] =>
  product.filterAttributes.map((attribute) => {
    const id = optionIds.get(optionKey(attribute.name, attribute.value));
    if (id === undefined) {
      throw new Error(
        `${product.filename}: no option id for ${attribute.name}: ${attribute.value}`,
      );
    }
    return id;
  });

/** The tickets id a product file already stores, when it has one. */
export const storedTicketsId = (text: string): number | null => {
  const match = text.match(/^tickets_id: (\d+)$/m);
  return match ? Number(match[1]) : null;
};

/** What the importer may do with one product file. A skip-conflict or update
 * plan carries the matched listing's id, because only those actions need it. */
export type ImportPlan =
  | { action: "create" }
  | { action: "skip-conflict"; listingId: number }
  | { action: "skip-imported" }
  | { action: "update"; listingId: number };

/** Decide one product's action. A file that stores a tickets id is imported.
 * A title that matches an existing listing is the operator's choice: the
 * importer never overwrites an unrelated listing without --update. */
export const resolveImportPlan = (
  storedId: number | null,
  matchedId: number | undefined,
  update: boolean,
): ImportPlan => {
  if (storedId !== null) return { action: "skip-imported" };
  if (matchedId === undefined) return { action: "create" };
  return update
    ? { action: "update", listingId: matchedId }
    : { action: "skip-conflict", listingId: matchedId };
};

/** The line a skipped name conflict prints; both modes tell the operator how
 * to go ahead. */
export const conflictLine = (
  product: CatalogProduct,
  listingId: number,
  plan: boolean,
): string =>
  `${plan ? "would skip" : "skipped"} listing ${product.title}: the name matches listing ${listingId}; rerun with --update to overwrite it\n`;

/** The line plan mode prints for one product. The attribute count is the
 * product's own selection: a real run attaches every filter attribute, whether
 * or not the plan has created their options yet. */
export const planLine = (plan: ImportPlan, product: CatalogProduct): string => {
  const summary =
    `listing ${product.title} ` +
    `(${product.options.length} rental options, ${product.filterAttributes.length} attributes)`;
  switch (plan.action) {
    case "create":
      return `would create ${summary}\n`;
    case "skip-conflict":
      return conflictLine(product, plan.listingId, true);
    case "skip-imported":
      return `already imported: ${product.title}\n`;
    case "update":
      return `would update ${summary}\n`;
  }
};

/** The site's own title of one category file, or the slug when the file has
 * no usable title. A file that exists but cannot be read or parsed stops the
 * import: a silently wrong group name is worse than a loud failure. */
export const categoryTitle = async (
  categoriesDir: string,
  slug: string,
): Promise<string> => {
  let text: string;
  try {
    text = await Deno.readTextFile(`${categoriesDir}/${slug}.md`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return slug;
    throw error;
  }
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  const front = match?.[1] ? (parse(match[1]) as Record<string, unknown>) : {};
  const title = typeof front.title === "string" ? front.title.trim() : "";
  return title === "" ? slug : title;
};
