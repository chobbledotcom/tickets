/**
 * Cross-table slug uniqueness. A slug must be unique across **listings, groups,
 * and site_pages** — they share the public URL namespace and the same blind-index
 * hash — so all three entity validators delegate here. Centralising it closes the
 * one-directional gap where a per-entity check only looked at a subset (letting a
 * later listing/group reuse a page's slug, or vice versa).
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import { execute } from "#shared/db/client.ts";

/** The slug-owning tables. A fixed constant list — never user input. */
export type SlugTable = "listings" | "groups" | "site_pages";
const SLUG_TABLES: readonly SlugTable[] = ["listings", "groups", "site_pages"];

/**
 * Is `slug` already used by any listing, group, or page? `exclude` skips one row
 * (the entity being edited) so it can keep its own slug.
 */
export const isSlugTakenAnywhere = async (
  slug: string,
  exclude?: { table: SlugTable; id: number },
): Promise<boolean> => {
  const slugIndex = await hmacHash(slug);
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  for (const table of SLUG_TABLES) {
    if (exclude?.table === table) {
      clauses.push(
        `EXISTS (SELECT 1 FROM ${table} WHERE slug_index = ? AND id != ?)`,
      );
      args.push(slugIndex, exclude.id);
    } else {
      clauses.push(`EXISTS (SELECT 1 FROM ${table} WHERE slug_index = ?)`);
      args.push(slugIndex);
    }
  }
  const result = await execute(`SELECT 1 WHERE ${clauses.join(" OR ")}`, args);
  return result.rows.length > 0;
};
