/**
 * Reading plain facts back off a served page: its words with the markup taken
 * out, and the links it offers. Nothing here touches a browser or a request —
 * markup goes in, answers come out.
 */

export const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Decode common HTML entities */
export const decodeEntities = (text: string): string =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&larr;/g, "\u2190")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&nbsp;/g, " ")
    .replace(/&times;/g, "\u00d7");

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
