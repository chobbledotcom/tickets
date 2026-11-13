/**
 * Detection of catalog keys that no source file references: the rule behind
 * the unused-key checks in test/scripts/i18n-coverage.test.ts.
 *
 * The scan reads text, not types. A key has a reference when the source
 * holds one of these:
 *   - the key as one quoted string;
 *   - a quoted string that is a parent of the key, because a helper can
 *     receive a parent and add the last part. The parent must hold a dot or
 *     end with one, so a bare word such as "terms" names no key;
 *   - a template string that the key fits, or whose result is a parent of
 *     the key.
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

/** The references one scan found. */
export type KeyReferences = {
  /** Every quoted string that can be a parent of a key. */
  parents: ReadonlySet<string>;
  /** Every quoted string. */
  quoted: ReadonlySet<string>;
  /** One pattern per key template. */
  templates: readonly RegExp[];
};

/** The pattern for one template, or null when the template cannot build a
 *  key. A template with fewer than three fixed letters fits every key, so it
 *  names none. */
const templatePattern = (template: string): RegExp | null => {
  const parts = template.split(SUBSTITUTION);
  const fixed = parts.join("");
  const letters = fixed.replaceAll(/[^A-Za-z]/g, "");
  if (!parts.every((part) => KEY_TEXT.test(part))) return null;
  if (letters.length < 3 || !fixed.includes(".")) return null;
  return new RegExp(`^${parts.map(escapeRegExp).join(".+")}(\\..+)?$`);
};

/** Collect the references that the given source texts hold. */
export const keyReferences = (sources: readonly string[]): KeyReferences => {
  const quoted = new Set<string>();
  const parents = new Set<string>();
  const templates = new Map<string, RegExp>();
  for (const source of sources) {
    for (const match of source.matchAll(QUOTED)) {
      const text = match[1]!;
      quoted.add(text);
      if (text.includes(".")) parents.add(text.replace(/\.$/, ""));
    }
    for (const match of source.matchAll(TEMPLATE)) {
      const pattern = templatePattern(match[1]!);
      if (pattern !== null) templates.set(pattern.source, pattern);
    }
  }
  return { parents, quoted, templates: [...templates.values()] };
};

/** Each dotted parent of the key, shortest first. */
const parentsOf = (key: string): string[] => {
  const parts = key.split(".");
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("."));
};

/** Whether the references hold this key. */
const isReferenced = (key: string, references: KeyReferences): boolean =>
  references.quoted.has(key) ||
  parentsOf(key).some((parent) => references.parents.has(parent)) ||
  references.templates.some((template) => template.test(key));

/** The catalog keys with no reference, in catalog order. */
export const unreferencedKeys = (
  keys: readonly string[],
  references: KeyReferences,
): string[] => keys.filter((key) => !isReferenced(key, references));

/** The two ways a recorded list of unused keys can disagree with a scan. */
export type UnusedKeyFindings = {
  /** Keys with no reference that the list does not record. */
  added: string[];
  /** Recorded keys that now have a reference or left the catalog. */
  stale: string[];
};

/** Compare the keys a scan found with the recorded list. */
export const unusedKeyFindings = (
  unreferenced: readonly string[],
  recorded: readonly string[],
): UnusedKeyFindings => {
  const found = new Set(unreferenced);
  const accepted = new Set(recorded);
  return {
    added: unreferenced.filter((key) => !accepted.has(key)),
    stale: recorded.filter((key) => !found.has(key)),
  };
};
