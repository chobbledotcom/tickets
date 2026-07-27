/**
 * Reading a served page's own form controls, and deciding whether a visitor
 * could really send a value through one. Pure: markup in, answers out — no
 * browser, so the rules can be checked directly.
 */

/** The dropdown on the page for one field, split into the tag's attributes and
 * its options, or null when the field is not a dropdown at all (a typed-in name
 * or email). The name may sit anywhere among the attributes — an `id` often
 * comes first — so the opening tag is matched whole and read from. */
const chooserFor = (
  html: string,
  field: string,
): { attributes: string; options: string } | null => {
  for (const chooser of html.matchAll(
    /<select\s([^>]*)>([\s\S]*?)<\/select>/g,
  )) {
    if (chooser[1]!.includes(`name="${field}"`)) {
      return { attributes: chooser[1]!, options: chooser[2]! };
    }
  }
  return null;
};

/** The one option carrying this value, or null when the dropdown has none. */
const optionFor = (options: string, value: string): string | null => {
  for (const option of options.matchAll(/<option\s([^>]*)>/g)) {
    if (option[1]!.includes(`value="${value}"`)) return option[0];
  }
  return null;
};

/** The box the visitor types in for one field, if it is one — its opening tag,
 * so its attributes can be read. */
const boxFor = (html: string, field: string): string | null => {
  for (const box of html.matchAll(/<(?:input|textarea)\s([^>]*)>/g)) {
    if (box[1]!.includes(`name="${field}"`)) return box[0];
  }
  return null;
};

/** The values a dropdown on the page offers. Throws when the page has no such
 * dropdown, so "the option is missing" and "the control is missing" stay
 * separate failures. */
export const optionsOffered = (html: string, field: string): string[] => {
  const chooser = chooserFor(html, field);
  if (!chooser) throw new Error(`The page offers no ${field} to choose`);
  return [...chooser.options.matchAll(/value="([^"]*)"/g)].map(
    (option) => option[1]!,
  );
};

/** One attribute's value on a control, or null when it does not carry it. */
const attribute = (tag: string, named: string): string | null =>
  tag.match(new RegExp(`${named}="([^"]*)"`))?.[1] ?? null;

/** Why a number box will not take this number, or null when it will. A box that
 * only accepts 1 to 3 cannot send 5, however happily a post carrying 5 is
 * accepted. */
const whyNumberIsOutOfRange = (
  box: string,
  field: string,
  chosen: string,
): string | null => {
  const number = Number(chosen);
  // An empty box, or anything that is not a number, has no range to break.
  if (chosen === "" || !Number.isFinite(number)) return null;
  const least = attribute(box, "min");
  if (least !== null && number < Number(least)) {
    return `the ${field} box takes nothing below ${least}`;
  }
  const most = attribute(box, "max");
  if (most !== null && number > Number(most)) {
    return `the ${field} box takes nothing above ${most}`;
  }
  return null;
};

/** Every checkbox on the page for one field that a person could actually
 * tick — a switched-off one is not one of them. Each is given as the value it
 * would send and whether it is already ticked. */
const usableCheckboxes = (
  html: string,
  field: string,
): Array<{ ticked: boolean; value: string }> => {
  const boxes: Array<{ ticked: boolean; value: string }> = [];
  for (const box of html.matchAll(/<input\s([^>]*)>/g)) {
    const tag = box[1]!;
    const value = attribute(tag, "value");
    if (
      tag.includes('type="checkbox"') &&
      tag.includes(`name="${field}"`) &&
      !tag.includes("disabled") &&
      value !== null
    ) {
      boxes.push({ ticked: tag.includes("checked"), value });
    }
  }
  return boxes;
};

/** The value the page's own box for a field sends when ticked — what a person
 * ticking it would send, rather than a value the caller believes in. Throws
 * when the page offers no such box, so "the box is gone" and "the box sends
 * something else" stay separate failures. */
export const checkboxValueOffered = (html: string, field: string): string => {
  const box = usableCheckboxes(html, field)[0];
  if (!box) throw new Error(`The page offers no ${field} box to tick`);
  return box.value;
};

/** The values a page has already ticked for one field, counting only real
 * checkboxes a person could untick. A day carried by a hidden box instead is
 * left out, because nobody can untick that. */
export const tickedCheckboxes = (html: string, field: string): string[] =>
  usableCheckboxes(html, field)
    .filter(({ ticked }) => ticked)
    .map(({ value }) => value);

/**
 * Why a visitor could not send this value through the page's own control, or
 * null when they could. A control must be rendered, not switched off or
 * read-only, and able to carry the value: a dropdown has to offer it as a
 * usable option, a hidden box has to already hold it because the visitor cannot
 * type over one, and a number box has to accept it within its own limits.
 */
export const whyValueCannotBeSent = (
  html: string,
  field: string,
  chosen: string,
): string | null => {
  const chooser = chooserFor(html, field);
  if (chooser) {
    if (chooser.attributes.includes("disabled")) {
      return `the ${field} chooser is switched off`;
    }
    // Only the option being picked matters — a placeholder switched off
    // elsewhere in the list is normal and says nothing about this choice.
    const option = optionFor(chooser.options, chosen);
    if (!option) return `the ${field} chooser does not offer "${chosen}"`;
    if (option.includes("disabled")) {
      return `the ${field} option "${chosen}" is switched off`;
    }
    return null;
  }
  const box = boxFor(html, field);
  if (!box) return `the page has no ${field} to fill in`;
  if (box.includes("disabled")) return `the ${field} box is switched off`;
  if (box.includes("readonly")) return `the ${field} box cannot be changed`;
  if (box.includes('type="hidden"') && !box.includes(`value="${chosen}"`)) {
    return `the ${field} box is fixed at something other than "${chosen}"`;
  }
  return whyNumberIsOutOfRange(box, field, chosen);
};
