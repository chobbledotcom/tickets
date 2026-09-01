/**
 * Pure rules for the shape check: group bodies that share a shape, and say
 * which groups are worth reporting.
 */

import { shortHash } from "#scripts/checksum.ts";
import { mapTemplates } from "#scripts/quoted-run.ts";

/** One function, named by the file it lives in. */
export interface ShapeSite {
  /** The body as written. Two of these that match exactly are already
   * `deno task cpd`'s to report, so this check leaves them to it. */
  body: string;
  file: string;
  line: number;
  /** The body with its names and its JSX text masked, which is what gets
   * shaped. */
  masked: string;
  name: string;
  /** Whether this site is `#fp` itself. `.jscpd.json` skips `#fp`, so a group
   * holding one is nobody else's to report. */
  sharedMechanism: boolean;
}

/** Two or more functions that share one shape. */
export interface ShapeMatch {
  /** The durable name for this group, which the accepted list is keyed by. */
  key: string;
  sites: ShapeSite[];
  tokens: number;
}

/** A body's templates with their line breaks held, so the trim that follows
 * cannot touch them: a template's whitespace is data the function returns,
 * not layout. */
const heldTemplates = (body: string): string =>
  mapTemplates(body, (run) => run.replaceAll("\n", "\u0000"));

/**
 * A body's fingerprint: seven characters that change when the body's text
 * changes. Lines are read trimmed and blank lines drop out, so moving a
 * function into deeper nesting — which only re-indents its code — leaves the
 * fingerprint alone, while any edit to what the body says does not. What a
 * template says is part of the body's text, so its insides stay whole through
 * the trim.
 */
export const bodyFingerprint = (body: string): string =>
  shortHash(
    heldTemplates(body)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n")
      .replaceAll("\u0000", "\n"),
  );

/**
 * How a group is named, and how the accepted list finds it again: every site
 * as `path::name~fingerprint`, sorted, joined by a comma. The fingerprint
 * covers the body's text, so editing a listed function makes the entry stale —
 * which is when somebody has to read its note again.
 */
export const matchKey = (sites: readonly ShapeSite[]): string =>
  sites
    .map((site) => `${site.file}::${site.name}~${bodyFingerprint(site.body)}`)
    .sort()
    .join(",");

/** One site as a reader sees it in the report. */
const formatSite = (site: ShapeSite): string =>
  `    ${site.file}:${site.line}  ${site.name}`;

/** One group, ready to print: what it is, where each copy lives, and the line
 * to paste into the accepted list once somebody has written the note. */
export const formatMatch = (match: ShapeMatch): string =>
  [
    `${match.sites.length} functions share one shape (${match.tokens} tokens):`,
    ...match.sites.map(formatSite),
    `    to accept: ${match.key}  # why it stands`,
  ].join("\n");

/**
 * Group the bodies that share a shape. A group needs at least `minTokens`, so
 * a one-line wrapper is not a finding, and at least two spellings, because
 * two bodies written the same way are already `deno task cpd`'s to report.
 */
export const shapeMatches = (
  sites: readonly ShapeSite[],
  shapeOf: (body: string) => string[],
  minTokens: number,
): ShapeMatch[] => {
  const byShape = new Map<string, ShapeSite[]>();
  const sizes = new Map<string, number>();
  for (const site of sites) {
    const shape = shapeOf(site.masked);
    if (shape.length < minTokens) continue;
    const shapeKey = shape.join(" ");
    sizes.set(shapeKey, shape.length);
    const group = byShape.get(shapeKey);
    if (group === undefined) byShape.set(shapeKey, [site]);
    else group.push(site);
  }
  const matches: ShapeMatch[] = [];
  for (const [shapeKey, group] of byShape) {
    if (group.length < 2) continue;
    // Bodies that match exactly are `deno task cpd`'s to report — unless one is
    // `#fp`, which cpd never reads, so nobody else would report the pair.
    const seenByCpd = group.every((site) => !site.sharedMechanism);
    if (seenByCpd && new Set(group.map((site) => site.body)).size < 2) continue;
    matches.push({
      key: matchKey(group),
      sites: group,
      tokens: sizes.get(shapeKey) as number,
    });
  }
  return matches.sort((left, right) => left.key.localeCompare(right.key));
};

/**
 * Drops a group that sits entirely inside the shared mechanism. `#fp`'s curried
 * pairs match each other by design, and merging them would remove the helpers
 * everything else calls. A body outside `#fp` that matches one of them is still
 * a finding, because there the merge is to call the helper.
 */
export const outsideSharedMechanism = (
  matches: readonly ShapeMatch[],
): ShapeMatch[] =>
  matches.filter((match) => !match.sites.every((site) => site.sharedMechanism));
