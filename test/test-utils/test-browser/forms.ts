/**
 * Reading a served page's forms, and working out what pressing one of their
 * buttons would really send. All of it is markup in, answers out: which form a
 * button belongs to, whether pressing it sends anything at all, and the exact
 * entries a browser would put in the body.
 */

import { escapeForRegex } from "#test-utils/regex.ts";
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

const controlValue = (tag: string, fallback = ""): string =>
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
  const value = tag.match(/^<textarea\b[^>]*>([\s\S]*?)<\/textarea>$/i)![1]!;
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

/** Extract successful form controls in browser submission order. */
export const extractFormEntries = (formHtml: string): FormEntry[] => {
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

/** One form on the page: where it sends, what it carries, and how it sends —
 * the method it declares, or the `get` a browser falls back to without one. */
export type FormInfo = { action: string; body: string; method: string };

/** Find all forms in HTML, returning where each sends, how, and what it holds */
export const findForms = (html: string): FormInfo[] =>
  regexCollect(
    /<form\s([^>]*action="([^"]*)"[^>]*)>([\s\S]*?)<\/form>/gi,
    html,
    (m) => ({
      action: decodeEntities(m[2]!),
      body: m[3]!,
      method: (attrValue(m[1]!, "method") ?? "get").toLowerCase(),
    }),
  );

/** Extract all checkbox values for a given field name from form HTML */
const extractCheckboxValues = (formHtml: string, fieldName: string): string[] =>
  regexCollect(
    new RegExp(
      `<input\\b[^>]*\\sname="${escapeForRegex(fieldName)}"[^>]*>`,
      "gi",
    ),
    formHtml,
    (m) => m[0],
  )
    .filter((tag) => !isDisabled(tag))
    .map((tag) => controlValue(tag, "on"));

/** Sentinel value that tells `appendFormValue` to auto-select every checkbox value. */
export const ALL_CHECKBOXES = "__ALL_CHECKBOXES__";

/**
 * Append a single user-provided form value, first removing any prior entry for
 * the same key. Array values spread across multiple entries; the
 * `__ALL_CHECKBOXES__` sentinel pulls every matching checkbox value from the
 * form HTML (mirroring a user ticking all of them).
 */
export const appendFormValue = (
  params: URLSearchParams,
  key: string,
  value: string | string[],
  body: string,
): void => {
  params.delete(key);
  if (Array.isArray(value)) {
    for (const v of value) params.append(key, v);
  } else if (value === ALL_CHECKBOXES) {
    for (const v of extractCheckboxValues(body, key)) {
      params.append(key, v);
    }
  } else {
    params.append(key, value);
  }
};

/** The button on this form a person would press, and what pressing it sends
 * (routes that dispatch on `action` read the button's own name and value).
 * "switched off" when the only buttons with that text cannot be pressed, and
 * nothing when the form has no button with that text at all — plenty of forms
 * are found by their body text instead. */
const buttonToPress = (
  body: string,
  lower: string,
):
  | {
      buttonAction?: string | undefined;
      buttonName?: string | undefined;
      buttonValue?: string;
    }
  | "switched off"
  | "sends nothing" => {
  const buttonRe = /<button\b([^>]*?)>([\s\S]*?)<\/button>/gi;
  let switchedOff = false;
  let sendsNothing = false;
  for (const m of regexCollect(buttonRe, body, (x) => x)) {
    if (!stripTags(m[2]!).toLowerCase().trim().includes(lower)) continue;
    const attrs = m[1]!;
    if (isDisabled(attrs)) {
      switchedOff = true;
      continue;
    }
    if (!pressingSends(attrs)) {
      sendsNothing = true;
      continue;
    }
    return {
      // A button may aim the form somewhere else, as a real browser honours.
      buttonAction: attrValue(attrs, "formaction"),
      buttonName: attrValue(attrs, "name"),
      buttonValue: attrValue(attrs, "value") ?? "",
    };
  }
  if (switchedOff) return "switched off";
  return sendsNothing ? "sends nothing" : {};
};

/** Find a form whose body contains the given button text, or throw. Also
 * returns the matching button's name/value attributes when present, so the
 * caller can include them in the submission (mirrors how a real browser submits
 * a `<button name="…" value="…">` only when clicked). */
export const findFormByButton = (
  forms: FormInfo[],
  buttonText: string,
  fieldNames: string[] = [],
): {
  action: string;
  body: string;
  buttonName?: string | undefined;
  buttonValue?: string | undefined;
} => {
  const lower = buttonText.toLowerCase();
  // A page can serve two forms behind one button wording; the one rendering
  // every field being sent is the one a person filling them in would submit,
  // so it wins whenever any form renders them all. The whitespace before
  // name= keeps a longer attribute like data-name from counting as a field.
  const rendersEveryField = (body: string): boolean =>
    fieldNames.every((field) =>
      new RegExp(`\\sname="${escapeForRegex(field)}"`).test(body),
    );
  const preferred = forms.filter((f) => rendersEveryField(f.body));
  const candidates = preferred.length > 0 ? preferred : forms;
  let unusable: "switched off" | "sends nothing" | null = null;
  for (const f of candidates) {
    if (!stripTags(f.body).toLowerCase().includes(lower)) continue;
    const pressed = buttonToPress(f.body, lower);
    // A button nobody could send with here does not settle it: a later form may
    // carry a usable button with the same words, and a real person could press
    // that one. Only give up once every form has been looked at.
    if (pressed === "switched off" || pressed === "sends nothing") {
      unusable = pressed;
      continue;
    }
    const { buttonAction, ...button } = pressed;
    return { action: buttonAction ?? f.action, body: f.body, ...button };
  }
  // Nothing usable anywhere, and at least one button could not send the form.
  // Submitting anyway would let a test do something nobody could do.
  if (unusable === "switched off") {
    throw new Error(`The "${buttonText}" button is switched off`);
  }
  if (unusable === "sends nothing") {
    throw new Error(`The "${buttonText}" button sends nothing`);
  }
  const available = forms.map((f) => `  action="${f.action}"`);
  throw new Error(
    `No form found with button text "${buttonText}". Available forms:\n${available.join(
      "\n",
    )}`,
  );
};

/** Always throws — used as a fallback in ?? chains to satisfy the type checker */
export const throwNoForm = (): never => {
  throw new Error("No forms found on the current page");
};
