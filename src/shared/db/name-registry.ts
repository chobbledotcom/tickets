/**
 * A name must be unique across **both** tables. A listing may not share one
 * with another listing *or* with a group. That is what lets catalog transfer
 * reference either by name alone. Names are stable across installs, ids are not.
 *
 * Names are field-level encrypted with no blind index, so this matches in
 * memory over the already-cached sets rather than querying. The catalog is
 * bounded and admin-scale, so the scan is cheap and needs no schema column.
 */

import { groups } from "#db/groups.ts";
import { getAllListings } from "#db/listings/records.ts";
import type { SitePageItemType } from "#types";

/** The two entity kinds that share the catalog name namespace. Derived from
 *  {@link SitePageItemType} (the slug-owning union) by excluding `"page"` —
 *  pages never participate in name uniqueness — so adding a new slug-owning
 *  entity here is a compile error against the canonical type. */
export type NamedEntityKind = Exclude<SitePageItemType, "page">;

/** One entity that owns a name — used to exclude the row being edited from its
 * own uniqueness check. */
export type NameOwner = { kind: NamedEntityKind; id: number };

/**
 * Normalise a display name for uniqueness comparison and name-keyed lookup:
 * trimmed and case-folded. Two names that differ only in surrounding whitespace
 * or letter case are treated as the same name, so an import that resolves a
 * parent/group by name is never ambiguous between "Weekend" and "weekend ".
 */
export const normalizeEntityName = (name: string): string =>
  name.trim().toLowerCase();

/** Normalised-name → ids for one entity kind. A name maps to several ids only on
 * legacy data that predates the uniqueness rule (new writes can't create one). */
export type NameIndex = Map<string, number[]>;

/** Build a {@link NameIndex} from decrypted `{id, name}` rows, dropping empty
 * names (an unnamed row never participates in uniqueness or name lookup). */
const buildIndex = (
  entities: ReadonlyArray<{ id: number; name: string }>,
): NameIndex => {
  const index: NameIndex = new Map();
  for (const entity of entities) {
    const key = normalizeEntityName(entity.name);
    if (key === "") continue;
    const ids = index.get(key);
    if (ids) ids.push(entity.id);
    else index.set(key, [entity.id]);
  }
  return index;
};

/** Both entity kinds' name indexes, loaded once so an import can resolve every
 * parent/group/member reference against a single snapshot. */
export type CatalogNameIndex = {
  listing: NameIndex;
  group: NameIndex;
};

/** Load the listing and group name indexes from the (cached) decrypted catalog. */
export const loadCatalogNameIndex = async (): Promise<CatalogNameIndex> => {
  const [listings, allGroups] = await Promise.all([
    getAllListings(),
    groups.cache.getAll(),
  ]);
  return { group: buildIndex(allGroups), listing: buildIndex(listings) };
};

/** The result of resolving a single name against a {@link NameIndex}: the unique
 * id, or the reason it could not be resolved. `ambiguous` only occurs on legacy
 * duplicate-named data; both reasons yield an intelligible import error. */
export type NameMatch =
  | { ok: true; id: number }
  | { ok: false; reason: "missing" | "ambiguous" };

/** Resolve one name to its unique owning id within a single entity kind. */
export const matchName = (index: NameIndex, name: string): NameMatch => {
  const ids = index.get(normalizeEntityName(name)) ?? [];
  if (ids.length === 0) return { ok: false, reason: "missing" };
  if (ids.length > 1) return { ok: false, reason: "ambiguous" };
  return { id: ids[0]!, ok: true };
};

/**
 * Is `name` already used by any listing or group? `exclude` skips one row (the
 * entity being edited) so it keeps its own name. An empty/whitespace name is
 * never "taken" — the required-field validation handles blank names, and an
 * unnamed legacy row must not block every new save.
 */
export const isNameTakenAnywhere = async (
  name: string,
  exclude?: NameOwner,
): Promise<boolean> => {
  const key = normalizeEntityName(name);
  if (key === "") return false;
  const { group, listing } = await loadCatalogNameIndex();
  const ownedByOther = (index: NameIndex, kind: NamedEntityKind): boolean =>
    (index.get(key) ?? []).some(
      (id) => !(exclude && exclude.kind === kind && exclude.id === id),
    );
  return ownedByOther(listing, "listing") || ownedByOther(group, "group");
};
