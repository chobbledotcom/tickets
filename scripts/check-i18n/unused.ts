/**
 * Detection of catalog keys that no source file references: the rule behind
 * the unused-key check in test/scripts/i18n-coverage.test.ts.
 *
 * The scan reads text, not types. A key has a reference when the source
 * holds one of these:
 *   - the key as one quoted string;
 *   - a quoted string that is a parent of the key, because a helper can
 *     receive a parent and add the last part. The parent must hold a dot or
 *     end with one, so a bare word such as "terms" names no key;
 *   - a template string that the key fits, or whose result is a parent of
 *     the key;
 *   - a quoted start and a template ending that join into the key, because a
 *     helper can receive "site.home.text" and add "_hint".
 * The scan can thus accept a dead key that shares a parent or an ending with
 * a live one. It never reports a key that the source spells out.
 */

import { escapeRegExp } from "#shared/regexp.ts";

/** One quoted string that holds only key characters. */
const QUOTED = /["'`]([A-Za-z0-9_.-]+)["'`]/g;

/** One single-line template string that holds a substitution. */
const TEMPLATE = /`([^`\n]*\$\{[^`\n]*)`/g;

/** One substitution inside a template string. */
const SUBSTITUTION = /\$\{[^}]*\}/;

/** The fixed text of a key template: key characters only. */
const KEY_TEXT = /^[A-Za-z0-9_.-]*$/;

/** A template that adds one fixed ending, with no dot, to a value. */
const ENDING = /^\$\{[^}]*\}([A-Za-z0-9_-]+)$/;

/** The references one scan found. */
export type KeyReferences = {
  /** Every ending that a template adds to a quoted start. */
  endings: ReadonlySet<string>;
  /** Every quoted string that can be a parent or a start of a key. */
  parents: ReadonlySet<string>;
  /** Every quoted string. */
  quoted: ReadonlySet<string>;
  /** One pattern per key template. */
  templates: readonly RegExp[];
};

/** The count of letters in the text. A text with fewer than three letters is
 *  too short to name a key. */
const letterCount = (text: string): number =>
  text.replaceAll(/[^A-Za-z]/g, "").length;

/** The pattern for one template, or null when the template cannot build a
 *  key. A template with fewer than three fixed letters fits every key, so it
 *  names none. */
const templatePattern = (template: string): RegExp | null => {
  const parts = template.split(SUBSTITUTION);
  const fixed = parts.join("");
  if (!parts.every((part) => KEY_TEXT.test(part))) return null;
  if (letterCount(fixed) < 3 || !fixed.includes(".")) return null;
  return new RegExp(`^${parts.map(escapeRegExp).join(".+")}(\\..+)?$`);
};

/** The ending one template adds, or null when the template adds none. */
const templateEnding = (template: string): string | null => {
  const ending = ENDING.exec(template)?.[1];
  return ending === undefined || letterCount(ending) < 3 ? null : ending;
};

/** Collect the references that the given source texts hold. */
export const keyReferences = (sources: readonly string[]): KeyReferences => {
  const quoted = new Set<string>();
  const parents = new Set<string>();
  const endings = new Set<string>();
  const templates = new Map<string, RegExp>();
  // No pattern matches over a line break, so the join adds no match.
  const text = sources.join("\n");
  for (const match of text.matchAll(QUOTED)) {
    quoted.add(match[1]!);
    if (match[1]!.includes(".")) parents.add(match[1]!.replace(/\.$/, ""));
  }
  for (const match of text.matchAll(TEMPLATE)) {
    const pattern = templatePattern(match[1]!);
    if (pattern !== null) templates.set(pattern.source, pattern);
    const ending = templateEnding(match[1]!);
    if (ending !== null) endings.add(ending);
  }
  return { endings, parents, quoted, templates: [...templates.values()] };
};

/** Each dotted parent of the key, shortest first. */
const parentsOf = (key: string): string[] => {
  const parts = key.split(".");
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("."));
};

/** Whether a quoted start and this ending join into the key. */
const joinsInto =
  (key: string, references: KeyReferences) =>
  (ending: string): boolean =>
    key.endsWith(ending) &&
    references.parents.has(key.slice(0, -ending.length));

/** Whether the references hold this key. */
const isReferenced = (key: string, references: KeyReferences): boolean =>
  references.quoted.has(key) ||
  parentsOf(key).some((parent) => references.parents.has(parent)) ||
  references.templates.some((template) => template.test(key)) ||
  [...references.endings].some(joinsInto(key, references));

/** The catalog keys with no reference, in catalog order. */
export const unreferencedKeys = (
  keys: readonly string[],
  references: KeyReferences,
): string[] => keys.filter((key) => !isReferenced(key, references));
