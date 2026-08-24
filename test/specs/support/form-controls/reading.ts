/**
 * Reading what a served page offers, without touching a browser — markup in,
 * answers out. One half reads a form's own controls: the dropdowns, boxes,
 * checkboxes, and questions somebody could really use. The other reads a list
 * into its rows, so a story asks one row what it offers rather than searching
 * the whole page — a control rendered beside somebody else's row never counts
 * as this one's.
 */

import { withoutSwitchedOffGroups } from "#test-utils/test-browser/forms.ts";
import { findAllLinks } from "#test-utils/test-browser/parsing.ts";

/** One attribute's value on a control, or null when it does not carry it. The
 * name has to start the attribute, so a `data-type="checkbox"` is not read as
 * the `type`. */
export const attribute = (tag: string, named: string): string | null =>
  tag.match(new RegExp(`(?:^|\\s)${named}="([^"]*)"`))?.[1] ?? null;

/** Whether a control carries a bare on/off attribute of its own, like
 * `required` or `disabled`. Quoted values are dropped first and the name has to
 * stand alone, so a box called `not_required`, an `aria-required="false"`, or a
 * hint that happens to say "required" is not mistaken for the real thing. */
export const hasFlag = (tag: string, named: string): boolean =>
  new RegExp(`(?:^|\\s)${named}(?=[\\s/>]|$)`).test(
    tag.replace(/="[^"]*"/g, ""),
  );

/** The dropdown on the page for one field, split into the tag's attributes and
 * its options, or null when the field is not a dropdown at all (a typed-in name
 * or email). The name may sit anywhere among the attributes — an `id` often
 * comes first — so the opening tag is matched whole and read from. */
export const chooserFor = (
  page: string,
  field: string,
): { attributes: string; options: string } | null => {
  const html = withoutSwitchedOffGroups(page);
  for (const chooser of html.matchAll(
    /<select\s([^>]*)>([\s\S]*?)<\/select>/g,
  )) {
    if (attribute(chooser[1]!, "name") === field) {
      return { attributes: chooser[1]!, options: chooser[2]! };
    }
  }
  return null;
};

/** The first option in a dropdown's markup that passes the test: its whole
 * tag and its attributes, or null when none does. */
const optionWhere = (
  options: string,
  test: (tag: string, attributes: string) => boolean,
): { attributes: string; tag: string } | null => {
  for (const option of options.matchAll(/<option\s([^>]*)>/g)) {
    if (test(option[0], option[1]!)) {
      return { attributes: option[1]!, tag: option[0] };
    }
  }
  return null;
};

/** The one option carrying this value, or null when the dropdown has none. */
export const optionFor = (options: string, value: string): string | null =>
  optionWhere(
    options,
    (_tag, attributes) => attribute(attributes, "value") === value,
  )?.tag ?? null;

/** The dropdown the page must offer for one field, or a loud failure — so
 * "the choice is missing" and "the control is missing" stay separate
 * failures. */
const chooserOffered = (
  html: string,
  field: string,
): NonNullable<ReturnType<typeof chooserFor>> => {
  const chooser = chooserFor(html, field);
  if (!chooser) throw new Error(`The page offers no ${field} to choose`);
  return chooser;
};

/** The box the visitor types in for one field, if it is one — its opening tag,
 * so its attributes can be read. */
export const boxFor = (page: string, field: string): string | null => {
  for (const box of withoutSwitchedOffGroups(page).matchAll(
    /<(?:input|textarea)\s([^>]*)>/g,
  )) {
    if (attribute(box[1]!, "name") === field) return box[0];
  }
  return null;
};

/** One choice a dropdown offers: the words somebody reads on the page, and the
 * value picking it sends. */
export interface ChoiceOffered {
  label: string;
  value: string;
}

/** Every choice a dropdown on the page offers, in the order it renders them.
 * Both halves come off the page itself, so a story can name a choice by the
 * words in front of the person making it. Throws when the page has no such
 * dropdown, so "the choice is missing" and "the control is missing" stay
 * separate failures. */
export const choicesOffered = (
  html: string,
  field: string,
): ChoiceOffered[] => {
  const chooser = chooserOffered(html, field);
  return [
    ...chooser.options.matchAll(/<option\s([^>]*)>([\s\S]*?)<\/option>/g),
  ].map((option) => ({
    label: option[2]!.replace(/<[^>]*>/g, "").trim(),
    value: attribute(option[1]!, "value") ?? "",
  }));
};

/** The values a dropdown on the page offers. */
export const optionsOffered = (html: string, field: string): string[] =>
  choicesOffered(html, field).map(({ value }) => value);

/** The attributes of the option a dropdown has marked as picked, or null when
 * it marks none. */
export const optionMarkedChosen = (options: string): string | null =>
  optionWhere(options, (tag) => hasFlag(tag, "selected"))?.attributes ?? null;

/** The value a dropdown on the page has already picked, or null when it has
 * picked nothing. Throws when the page has no such dropdown, so "nothing is
 * picked" and "the control is missing" stay separate failures. */
export const optionChosen = (html: string, field: string): string | null => {
  const marked = optionMarkedChosen(chooserOffered(html, field).options);
  return marked === null ? null : (attribute(marked, "value") ?? "");
};

/** The answer a question on the page has already picked, or null when none
 * is. A choice with no value of its own sends "on", as a browser does. */
export const answerTicked = (html: string, field: string): string | null => {
  for (const { field: name, tag } of usableInputsOfKind(html, "radio")) {
    if (name === field && hasFlag(tag, "checked")) {
      return attribute(tag, "value") ?? "on";
    }
  }
  return null;
};

/** One checkbox somebody could really tick: which field it belongs to, the
 * value ticking it would send, whether the page has ticked it already, and
 * whether the page insists on it being ticked at all. */
export interface UsableCheckbox {
  field: string;
  insisted: boolean;
  ticked: boolean;
  value: string;
}

/** Every input on the page of one kind that somebody could really use, given as
 * the field it sends under and its whole tag — closing bracket and all, because
 * the flag test needs something after a name to know it stands alone. A
 * switched-off one is left out, and so is one with no name, since neither
 * reaches the site. */
export const usableInputsOfKind = (
  page: string,
  kind: string,
): Array<{ field: string; tag: string }> => {
  const found: Array<{ field: string; tag: string }> = [];
  for (const box of withoutSwitchedOffGroups(page).matchAll(
    /<input\s([^>]*)>/g,
  )) {
    const tag = box[0];
    const field = attribute(tag, "name");
    if (attribute(tag, "type") !== kind || field === null) continue;
    if (hasFlag(tag, "disabled")) continue;
    found.push({ field, tag });
  }
  return found;
};

/** Every checkbox on the page a person could actually tick. A box with no value
 * of its own sends "on", the same word a browser sends, so one is still a box
 * somebody can tick. */
export const usableCheckboxesOn = (html: string): UsableCheckbox[] =>
  usableInputsOfKind(html, "checkbox").map(({ field, tag }) => ({
    field,
    insisted: hasFlag(tag, "required"),
    ticked: hasFlag(tag, "checked"),
    value: attribute(tag, "value") ?? "on",
  }));

/** The answers a question on the page really offers, in the order it renders
 * them. A choice with no value of its own sends "on", as a browser does. */
export const choicesForQuestion = (html: string, field: string): string[] =>
  usableInputsOfKind(html, "radio")
    .filter((choice) => choice.field === field)
    .map(({ tag }) => attribute(tag, "value") ?? "on");

/** Every checkbox on the page for one field that a person could actually
 * tick. */
const usableCheckboxes = (html: string, field: string): UsableCheckbox[] =>
  usableCheckboxesOn(html).filter((box) => box.field === field);

/** Confirm the page offers a box for this field sending exactly this value —
 * ticking a box nobody is shown would prove nothing. Throws otherwise. */
export const requireCheckboxOffered = (
  html: string,
  field: string,
  value: string,
): void => {
  const offered = usableCheckboxes(html, field).map((box) => box.value);
  if (!offered.includes(value)) {
    throw new Error(
      `The page offers no ${field} box sending "${value}" (offered: ${offered.join(", ") || "none"})`,
    );
  }
};

/** The first box the page offers for one field, or a loud failure — ticking or
 * clearing a box nobody is shown would prove nothing either way. */
export const boxOffered = (html: string, field: string): UsableCheckbox => {
  const box = usableCheckboxes(html, field)[0];
  if (!box) throw new Error(`The page offers no ${field} box to tick`);
  return box;
};

/** The value the page's own box for a field sends when ticked — what a person
 * ticking it would send, rather than a value the caller believes in. Throws
 * when the page offers no such box, so "the box is gone" and "the box sends
 * something else" stay separate failures. */
export const checkboxValueOffered = (html: string, field: string): string =>
  boxOffered(html, field).value;

/** The values a page has already ticked for one field, counting only real
 * checkboxes a person could untick. A day carried by a hidden box instead is
 * left out, because nobody can untick that. */
export const tickedCheckboxes = (html: string, field: string): string[] =>
  usableCheckboxes(html, field)
    .filter(({ ticked }) => ticked)
    .map(({ value }) => value);

/** One row of a list, known by the link that names it: the words on that link,
 * the number in its address, the address itself, and the row's own markup.
 * Anything the row offers — an arrow, a marker, a way in — is read off that
 * markup alone, so a control rendered beside somebody else's row never counts
 * as this one's. */
export interface RowOnList {
  id: number;
  name: string;
  row: string;
  wayIn: string;
}

/** Every row of a list whose name links into it, in the order the page shows
 * them. `wayIn` says what such a link's address looks like, with the row's
 * number as its one captured group. A row rendering no such link is one the
 * person has no way into, so it is not a row they could act on at all. */
export const rowsOnList = (html: string, wayIn: RegExp): RowOnList[] => {
  const rows: RowOnList[] = [];
  for (const segment of html.split("<tr").slice(1)) {
    // Only up to the row's own closing tag: the last row's segment otherwise
    // runs to the end of the page, and anything rendered after the table
    // would read as that row's.
    const closed = segment.indexOf("</tr>");
    const row = closed === -1 ? segment : segment.slice(0, closed);
    for (const link of findAllLinks(row)) {
      const into = link.href.match(wayIn);
      if (into?.[1]) {
        // The name comes back as the page spells it, so "&amp;" is read as
        // the "&" the person typed — otherwise a row they can see could not
        // be found.
        rows.push({
          id: Number(into[1]),
          name: link.text.trim(),
          row,
          wayIn: link.href,
        });
        break;
      }
    }
  }
  return rows;
};
