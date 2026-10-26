/**
 * Reference resolution for the bundle import: every name in a bundle resolves
 * against the document's own items first, then against the site's catalog.
 *
 * Names are unique across listings and groups, inside the document and on the
 * site, so a normalised name is an unambiguous key. A name referenced twice
 * inside one list is the same duplicate refusal the single import raises for
 * a repeated parent.
 */

import {
  matchName,
  type NameIndex,
  normalizeEntityName as nameKey,
} from "#db/name-registry.ts";
import { seenBefore } from "#shared/seen-before.ts";
import type { BundleRef } from "./bundle-plan.ts";

/** One resolved reference, or the reason it resolved to nothing. */
export type Resolved = BundleRef | { error: string };

/** The resolved references one listing item carries: the groups it joins and
 * the parents it names. */
export type ListingRefs = {
  groups: ReadonlyMap<string, Resolved>;
  parents: ReadonlyMap<string, Resolved>;
};

/** The refusal for a name the site does not hold: missing, or ambiguous. */
const unresolved = (
  siteIndex: NameIndex,
  name: string,
  noun: string,
): Resolved => {
  const match = matchName(siteIndex, name);
  if (match.ok) return { siteId: match.id };
  if (match.reason === "missing") {
    return {
      error: `No ${noun} named "${name}" exists — it must already exist to import this reference.`,
    };
  }
  return {
    error: `More than one ${noun} is named "${name}"; names must be unique to import by name.`,
  };
};

/** Resolve each name against the document first, then the site. */
export const resolveReferences = (
  names: readonly string[],
  bundleByName: ReadonlyMap<string, number>,
  siteIndex: NameIndex,
  noun: string,
): ReadonlyMap<string, Resolved> => {
  const resolved = new Map<string, Resolved>();
  const isRepeat = seenBefore();
  for (const name of names) {
    const key = nameKey(name);
    if (isRepeat(key)) {
      resolved.set(name, {
        error: `The ${noun} "${name}" is referenced more than once — remove the duplicate.`,
      });
    } else if (bundleByName.has(key)) {
      resolved.set(name, { bundleKey: key });
    } else {
      resolved.set(name, unresolved(siteIndex, name, noun));
    }
  }
  return resolved;
};

/** The reference a name resolved to, when it resolved at all. */
export const resolvedReference = (
  refs: ReadonlyMap<string, Resolved>,
  name: string,
): BundleRef | undefined => {
  const resolved = refs.get(name);
  return resolved !== undefined && !("error" in resolved)
    ? resolved
    : undefined;
};

/** The first failed reference in a resolved list, for the item's report. */
export const firstReferenceError = (
  resolved: ReadonlyMap<string, Resolved>,
) => {
  for (const reference of resolved.values()) {
    if ("error" in reference) return reference.error;
  }
  return null;
};

/** Every stored listing the document's items name as a parent. */
export const siteParentIdsOf = (
  listingRefs: ReadonlyMap<unknown, ListingRefs>,
): number[] =>
  [...listingRefs.values()].flatMap((refs) => siteIdsOf(refs.parents));

/** The site ids inside a resolved reference map. */
export const siteIdsOf = (resolved: ReadonlyMap<string, Resolved>): number[] =>
  [...resolved.values()].flatMap((reference) =>
    "siteId" in reference ? [reference.siteId] : [],
  );
