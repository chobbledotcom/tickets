import { normalizeEntityName } from "#db/name-registry.ts";
import {
  type CatalogProduct,
  frontmatterBlock,
} from "./product-catalog/parse.ts";

/** A row the importer matches by name: the listing list the API returns. */
export type ApiNamedLike = { id: number; name: string };

/** The ids of the listings the site considers the same name as the title: the
 * server's name registry trims and folds case, so the importer matches the
 * same way instead of failing a create with a duplicate. */
export const matchedIds = (
  title: string,
  existing: readonly ApiNamedLike[],
): number[] =>
  existing
    .filter(
      (listing) =>
        normalizeEntityName(listing.name) === normalizeEntityName(title),
    )
    .map((listing) => listing.id);

/** The flags the Markdown Frontmatter Importer accepts. */
export type ImportFlags = {
  dir: string | undefined;
  plan: boolean;
  update: boolean;
};

/** Read the importer's flags. `--dir` needs its own operand: a missing one or
 *  one that reads as another flag is an error, not a silent default. Any
 *  other argument is an error too, so a mistyped flag cannot silently change
 *  nothing. */
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
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return flags;
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
  // The listing's own cap is the strictest option's: one selector governs
  // every day count, so the loosest option's limit must not override a
  // tighter one.
  const maxQuantity = Math.min(
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
 *  the closing fence. A stored placeholder (`tickets_id:` with no value) is
 *  replaced like any stored value, so a partly stamped file still stamps.
 *  Only the frontmatter block is touched: a body that mentions tickets_id
 *  stays as it is. */
export const withTicketsMeta = (
  text: string,
  meta: { id: number; slug: string },
): string => {
  // The file keeps its own line endings: a stamp must stay a two-line
  // change, not rewrite every body line of a CRLF file.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = text.replaceAll("\r\n", "\n");
  const [full, frontBlock] = /^---\n([\s\S]*?)\n---/.exec(normalized) ?? [];
  if (full === undefined || frontBlock === undefined) return text;
  const front = frontBlock
    .split("\n")
    .filter((line) => !/^tickets_(id|slug):/.test(line))
    .join("\n");
  const insertion = `tickets_id: ${meta.id}\ntickets_slug: ${meta.slug}`;
  return `---\n${front}\n${insertion}\n---${normalized.slice(full.length)}`.replaceAll(
    "\n",
    eol,
  );
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
export const storedTicketsId = (
  filename: string,
  text: string,
): number | null => {
  // Only the frontmatter block counts: a body line that repeats the field
  // name must not make the importer skip a product it never imported.
  const block = frontmatterBlock(text);
  if (block === null) return null;
  const blank = block.match(/^tickets_id:\s*$/m);
  if (blank) return null;
  const match = block.match(/^tickets_id: (.+)$/m);
  if (!match || match[1] === undefined) return null;
  const id = Number(match[1]);
  // A stored id names one listing; anything that cannot be one must stop the
  // import instead of reading as absent and creating a duplicate.
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(
      `${filename}: tickets_id must be a positive whole number, not ${match[1].trim()}`,
    );
  }
  return id;
};

/** What the importer may do with one product file. A skip-conflict,
 *  skip-ambiguous, or update plan carries the matched listing's ids, because
 *  only those actions need them. */
export type ImportPlan =
  | { action: "create" }
  | { action: "skip-ambiguous"; listingIds: number[] }
  | { action: "skip-conflict"; listingId: number }
  | { action: "skip-imported" }
  | { action: "update"; listingId: number };

/** Decide one product's action. A file that stores a tickets id is imported.
 *  A title that matches one existing listing is the operator's choice: the
 *  importer never overwrites an unrelated listing without --update. A title
 *  that matches several is always skipped: the operator renames one first. */
export const resolveImportPlan = (
  storedId: number | null,
  matchedIds: readonly number[],
  update: boolean,
): ImportPlan => {
  if (storedId !== null) return { action: "skip-imported" };
  const [firstMatch] = matchedIds;
  if (firstMatch === undefined) return { action: "create" };
  if (matchedIds.length > 1) {
    return { action: "skip-ambiguous", listingIds: [...matchedIds] };
  }
  return update
    ? { action: "update", listingId: firstMatch }
    : { action: "skip-conflict", listingId: firstMatch };
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
    case "skip-ambiguous":
      return (
        `would skip listing ${product.title}: the name matches listings ` +
        `${plan.listingIds.join(" and ")}; rename one on the site and rerun\n`
      );
    case "skip-conflict":
      return conflictLine(product, plan.listingId, true);
    case "skip-imported":
      return `already imported: ${product.title}\n`;
    case "update":
      return `would update ${summary}\n`;
  }
};
