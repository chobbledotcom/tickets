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

/**
 * Why a visitor could not send this value through the page's own control, or
 * null when they could. A control must be rendered, not switched off, and able
 * to carry the value: a dropdown has to offer it as a usable option, and a
 * hidden box has to already hold it, because the visitor cannot type over one.
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
  if (box.includes('type="hidden"') && !box.includes(`value="${chosen}"`)) {
    return `the ${field} box is fixed at something other than "${chosen}"`;
  }
  return null;
};
