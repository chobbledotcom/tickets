/**
 * Reading a served page's forms, and working out what pressing one of their
 * buttons would really send. All of it is markup in, answers out: which form a
 * button belongs to, whether pressing it sends anything at all, and the exact
 * entries a browser would put in the body.
 */

import {
  decodeEntities,
  regexCollect,
  stripTags,
} from "#test-utils/test-browser/parsing.ts";

export type FormEntry = [name: string, value: string];

/** One attribute's value on a control, or nothing when it does not carry it.
 * The name has to start the attribute — a word boundary is not enough, since
 * one sits inside `data-name` too — so a longer attribute ending in the name
 * being read is not mistaken for it. */
export const attrValue = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i"))?.[1];

/** Whether a control carries an attribute at all, by the same rule. */
const hasAttr = (tag: string, name: string): boolean =>
  new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|>|$)`, "i").test(tag);

const controlName = (tag: string): string | undefined => attrValue(tag, "name");

export const controlValue = (tag: string, fallback = ""): string =>
  decodeEntities(attrValue(tag, "value") ?? fallback);

export const isDisabled = (tag: string): boolean => hasAttr(tag, "disabled");

/** Whether pressing this button really sends its form. A `type="button"` or
 * `type="reset"` one is rendered and pressable but sends nothing, and a button
 * declaring no type of its own submits, as a browser has no other default. */
export const pressingSends = (attrs: string): boolean =>
  (attrValue(attrs, "type") ?? "submit").toLowerCase() === "submit";

const inputType = (tag: string): string =>
  (attrValue(tag, "type") ?? "text").toLowerCase();

const isSuccessfulInput = (tag: string): boolean => {
  if (isDisabled(tag)) return false;
  const type = inputType(tag);
  if (["button", "file", "image", "reset", "submit"].includes(type)) {
    return false;
  }
  if (["checkbox", "radio"].includes(type)) return hasAttr(tag, "checked");
  return true;
};

const formInputEntry = (tag: string): FormEntry | undefined => {
  const name = controlName(tag);
  if (!name || !isSuccessfulInput(tag)) return;
  const defaultValue = ["checkbox", "radio"].includes(inputType(tag))
    ? "on"
    : "";
  return [decodeEntities(name), controlValue(tag, defaultValue)];
};

const formTextareaEntry = (tag: string): FormEntry | undefined => {
  const openTag = tag.match(/^<textarea\b[^>]*>/i)![0];
  const name = controlName(openTag);
  if (!name || isDisabled(openTag)) return;
  const body = tag.match(/^<textarea\b[^>]*>([\s\S]*?)<\/textarea>$/i)![1]!;
  // HTML parsing drops the first newline directly after a `<textarea>` start
  // tag, so this is the value the browser would hold and submit: the body
  // without its one leading newline.
  const value = body.startsWith("\n") ? body.slice(1) : body;
  return [decodeEntities(name), decodeEntities(value)];
};

const optionEntry = (
  selectTag: string,
  optionTag: string,
): FormEntry | undefined => {
  const name = controlName(selectTag);
  if (!name || isDisabled(optionTag)) return;
  const text = stripTags(optionTag.match(/>([\s\S]*?)<\/option>$/i)![1]!);
  return [decodeEntities(name), controlValue(optionTag, decodeEntities(text))];
};

const formSelectEntries = (tag: string): FormEntry[] => {
  const openTag = tag.match(/^<select\b[^>]*>/i)![0];
  if (!controlName(openTag) || isDisabled(openTag)) return [];
  const options = regexCollect(
    /<option\b[^>]*>[\s\S]*?<\/option>/gi,
    tag,
    (m) => m[0],
  );
  const selected = options.filter((option) => hasAttr(option, "selected"));
  const submittedOptions = hasAttr(openTag, "multiple")
    ? selected
    : [selected[0] ?? options.find((option) => !isDisabled(option))].filter(
        (option): option is string => option !== undefined,
      );
  const entries: FormEntry[] = [];
  for (const option of submittedOptions) {
    const entry = optionEntry(openTag, option);
    if (entry) entries.push(entry);
  }
  return entries;
};

/** A switched-off group's own first legend, which stays usable. A legend
 * written inside a group within this one is that group's heading, not this
 * one's, so it is switched off with the rest of the insides. */
const ownFirstLegend = (inside: string): string => {
  const parts =
    /<fieldset[^>]*>|<\/fieldset>|<legend[^>]*>[\s\S]*?<\/legend>/gi;
  let depth = 0;
  for (const part of inside.matchAll(parts)) {
    const tag = part[0]!;
    if (tag.startsWith("</")) depth -= 1;
    else if (tag.toLowerCase().startsWith("<legend")) {
      if (depth === 0) return tag;
    } else depth += 1;
  }
  return "";
};

/** The markup with every switched-off group's insides taken out. A
 * `<fieldset disabled>` switches off every control inside it: a browser sends
 * none of them, none can be pressed, and no form is held up waiting for one.
 * Only the group's first legend stays, which is still usable.
 *
 * Nesting is counted rather than guessed, so a group written inside a
 * switched-off group does not end the reckoning early and leave the controls
 * after it looking usable. */
export const withoutSwitchedOffGroups = (html: string): string => {
  const groupTags = /<(\/?)fieldset([^>]*)>/gi;
  let kept = "";
  let copiedTo = 0;
  let depth = 0;
  let insideFrom = 0;
  let found = groupTags.exec(html);
  while (found !== null) {
    const closing = found[1] === "/";
    if (depth === 0 && !closing && hasAttr(found[2]!, "disabled")) {
      kept += html.slice(copiedTo, found.index);
      depth = 1;
      insideFrom = found.index + found[0].length;
    } else if (depth > 0) {
      depth += closing ? -1 : 1;
      if (depth === 0) {
        const inside = html.slice(insideFrom, found.index);
        kept += ownFirstLegend(inside);
        copiedTo = found.index + found[0].length;
      }
    }
    found = groupTags.exec(html);
  }
  return kept + html.slice(copiedTo);
};

/** Extract successful form controls in browser submission order. */
export const extractFormEntries = (form: string): FormEntry[] => {
  const formHtml = withoutSwitchedOffGroups(form);
  const entries: FormEntry[] = [];
  const controlRe =
    /<input\b[^>]*>|<select\b[^>]*>[\s\S]*?<\/select>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi;
  for (const tag of regexCollect(controlRe, formHtml, (m) => m[0])) {
    if (/^<input\b/i.test(tag)) {
      const entry = formInputEntry(tag);
      if (entry) entries.push(entry);
    } else if (/^<select\b/i.test(tag)) {
      entries.push(...formSelectEntries(tag));
    } else {
      const entry = formTextareaEntry(tag);
      if (entry) entries.push(entry);
    }
  }
  return entries;
};
