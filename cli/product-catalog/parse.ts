/** Product catalog frontmatter parsing.
 *
 *  Turns one markdown file's text (frontmatter only) into the records the
 *  importer stores: the product's fields, its rental options, its filter
 *  attributes, and a category file's title. Pure data-in/data-out, so every
 *  rule is testable without the site. */

import { parse } from "jsr:@std/yaml@1";
import { errorMessage } from "#shared/error-message.ts";
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
  /** The product file name without its extension, e.g. "tumble-tower-hire". */
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

/** The text entries of one frontmatter list. A supplied container that is no
 *  list, or an entry that is no text, is malformed external data and stops
 *  the import naming the file and the field; a missing or empty container
 *  holds no entries. */
const asStringList = (
  filename: string,
  field: string,
  value: unknown,
): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${filename}: ${field} is not a list`);
  }
  return value
    .map((item) => {
      if (typeof item !== "string") {
        throw new Error(
          `${filename}: ${field} holds an entry that is not text`,
        );
      }
      return item.trim();
    })
    .filter((item) => item !== "");
};

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
  if (typeof value === "boolean") {
    throw new Error(`${filename}: order is not a number`);
  }
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
  let parsed: unknown;
  try {
    parsed = parse(block);
  } catch (error) {
    throw new Error(
      `${filename}: unparseable frontmatter: ${errorMessage(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object") return {};
  return parsed as Record<string, unknown>;
};

/** The entries of one frontmatter list. A supplied container that is no list,
 *  or an entry that holds no fields (null, a scalar, an array), is malformed
 *  external data and stops the import naming the file and the field; it must
 *  not read as an absent entry. */
const recordEntries = (
  filename: string,
  field: string,
  raw: unknown,
): Record<string, unknown>[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${filename}: ${field} is not a list`);
  }
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `${filename}: ${field} holds an entry that is not a name/value record`,
      );
    }
  }
  return raw as Record<string, unknown>[];
};

/** A product's rental options, validated: every supplied option carries a
 *  name, a price is required, two options that book one day count would
 *  silently replace each other's price in the day-price map, and an
 *  option-less product would write nonsense into the listing body. Each
 *  failure names the file. */
const parseOptions = (
  filename: string,
  raw: unknown,
): CatalogProduct["options"] => {
  const named = recordEntries(filename, "options", raw).map((option) => {
    const name = asString(option.name);
    // A supplied option without a name would silently drop a rental period
    // and its price from the listing.
    if (name === "") {
      throw new Error(`${filename}: an option needs a name`);
    }
    return { name, option };
  });
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
    categories: asStringList(filename, "categories", front.categories).map(
      (path) =>
        path
          .replace(/^src\//, "")
          .replace(/\.md$/, "")
          .replace(/^categories\//, ""),
    ),
    features: asStringList(filename, "features", front.features),
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

/** The site's own title of one category file's text, or the file path's slug
 * when the text has no usable title. An unparseable file stops the import:
 * a stale path must not quietly create a wrongly named group. */
export const parseCategoryTitle = (file: string, text: string): string => {
  const slug = file.replace(/\.md$/, "").replace(/.*\//, "");
  const front = frontmatterBlock(text);
  let parsed: unknown;
  try {
    parsed = front === null ? {} : parse(front);
  } catch (error) {
    throw new Error(`${file}: unparseable frontmatter: ${errorMessage(error)}`);
  }
  if (parsed === null || typeof parsed !== "object") return slug;
  const record = parsed as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  return title === "" ? slug : title;
};
