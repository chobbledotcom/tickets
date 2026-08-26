/**
 * Reading plain facts back off a served page: its words with the markup taken
 * out, and the links it offers. Nothing here touches a browser or a request —
 * markup goes in, answers come out.
 */

import { requiredMapValue } from "#fp";

export const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The entities our templates emit, and the character a reader sees for each. */
const ENTITIES = new Map<string, string>([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&larr;", "\u2190"],
  ["&mdash;", "\u2014"],
  ["&nbsp;", " "],
  ["&times;", "\u00d7"],
]);

/** One pattern built from the table above, so the two cannot drift apart. */
const ANY_ENTITY = new RegExp([...ENTITIES.keys()].join("|"), "g");

/**
 * What a reader sees: one decoding pass, the way a browser does it, so nothing
 * the pass produces is decoded again. That keeps `&amp;times;` reading as the
 * literal "&times;" a browser shows, rather than as the "×" a single
 * `&times;` means — a page escaped twice must not read as if it were right.
 */
export const decodeEntities = (text: string): string =>
  text.replace(ANY_ENTITY, (entity) =>
    requiredMapValue(ENTITIES, entity, `No character for ${entity}`),
  );

/** Collect all capture-group matches for a regex against a string */
export const regexCollect = <T>(
  re: RegExp,
  html: string,
  transform: (m: RegExpExecArray) => T,
): T[] => {
  const results: T[] = [];
  let m = re.exec(html);
  while (m !== null) {
    results.push(transform(m));
    m = re.exec(html);
  }
  return results;
};

/** Match info for a found link */
export type LinkMatch = { href: string; text: string };

/** Find all links in HTML */
export const findAllLinks = (html: string): LinkMatch[] =>
  regexCollect(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, html, (m) => ({
    href: decodeEntities(m[1]!),
    text: decodeEntities(stripTags(m[2]!)),
  }));

/** Find a link whose visible text contains the search string (case-insensitive) */
export const findLinkByText = (
  html: string,
  text: string,
): LinkMatch | null => {
  const lower = text.toLowerCase();
  return (
    findAllLinks(html).find((l) => l.text.toLowerCase().includes(lower)) ?? null
  );
};
