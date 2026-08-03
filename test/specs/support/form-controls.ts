/**
 * Reading a served page's own form controls, and deciding whether a visitor
 * could really send a value through one. The deciding is pure — markup in,
 * answers out, no browser — so the rules can be checked directly. The one
 * `expect` helper at the foot sits on top of that, for the stories.
 */

import { expect } from "@std/expect";
import { t } from "#i18n";
import type { TestBrowser } from "#test-utils/test-browser.ts";

/** Why a field could not carry a value, or null when it could. Each rule below
 * answers the same question about a different piece of the page, so they share
 * one contract. */
type WhyFieldCannotCarry = (
  markup: string,
  field: string,
  chosen: string,
) => string | null;

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
  const chooser = chooserFor(html, field);
  if (!chooser) throw new Error(`The page offers no ${field} to choose`);
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

/** One attribute's value on a control, or null when it does not carry it. */
const attribute = (tag: string, named: string): string | null =>
  tag.match(new RegExp(`${named}="([^"]*)"`))?.[1] ?? null;

/** Whether a control carries a bare on/off attribute of its own, like
 * `required` or `disabled`. Quoted values are dropped first and the name has to
 * stand alone, so a box called `not_required`, an `aria-required="false"`, or a
 * hint that happens to say "required" is not mistaken for the real thing. */
const hasFlag = (tag: string, named: string): boolean =>
  new RegExp(`\\s${named}(?=[\\s/>])`).test(tag.replace(/="[^"]*"/g, ""));

/** Why a number box will not take this number, or null when it will. A box that
 * only accepts 1 to 3 cannot send 5, however happily a post carrying 5 is
 * accepted. */
const whyNumberIsOutOfRange: WhyFieldCannotCarry = (box, field, chosen) => {
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

/** One checkbox somebody could really tick: which field it belongs to, the
 * value ticking it would send, whether the page has ticked it already, and
 * whether the page insists on it being ticked at all. */
interface UsableCheckbox {
  field: string;
  insisted: boolean;
  ticked: boolean;
  value: string;
}

/** Every checkbox on the page a person could actually tick — a switched-off one
 * is not one of them. A box with no value of its own sends "on", the same word
 * a browser sends, so one is still a box somebody can tick. */
const usableCheckboxesOn = (html: string): UsableCheckbox[] => {
  const boxes: UsableCheckbox[] = [];
  for (const box of html.matchAll(/<input\s([^>]*)>/g)) {
    // The whole tag, closing bracket and all: the flag test needs something
    // after the name to know it stands alone.
    const tag = box[0];
    const field = attribute(tag, "name");
    if (
      tag.includes('type="checkbox"') &&
      !hasFlag(tag, "disabled") &&
      field !== null
    ) {
      boxes.push({
        field,
        insisted: hasFlag(tag, "required"),
        ticked: hasFlag(tag, "checked"),
        value: attribute(tag, "value") ?? "on",
      });
    }
  }
  return boxes;
};

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
const boxOffered = (html: string, field: string): UsableCheckbox => {
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

/**
 * Why a visitor could not send this value through the page's own control, or
 * null when they could. A control must be rendered, not switched off or
 * read-only, and able to carry the value: a dropdown has to offer it as a
 * usable option, a hidden box has to already hold it because the visitor cannot
 * type over one, and a number box has to accept it within its own limits.
 */
export const whyValueCannotBeSent: WhyFieldCannotCarry = (
  html,
  field,
  chosen,
) => {
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
  return whyBoxCannotCarry(box, field, chosen);
};

/** Why a box will not take this many characters, or null when it will. A box
 * that asks for at least eight cannot send five, however happily a post
 * carrying five is accepted. */
const whyTextIsTooShort: WhyFieldCannotCarry = (box, field, chosen) => {
  const least = attribute(box, "minlength");
  // An empty box is answered by the required rule, which says something more
  // useful than "too short".
  if (least === null || chosen === "" || chosen.length >= Number(least)) {
    return null;
  }
  return `the ${field} box takes nothing shorter than ${least} characters`;
};

/** Why one box on the page could not carry this value. */
const whyBoxCannotCarry: WhyFieldCannotCarry = (box, field, chosen) => {
  if (hasFlag(box, "disabled")) return `the ${field} box is switched off`;
  if (hasFlag(box, "readonly")) return `the ${field} box cannot be changed`;
  // A browser will not submit a form that leaves a required box empty, so
  // "send nothing here" is only a real answer when the box is optional.
  if (chosen === "" && hasFlag(box, "required")) {
    return `the ${field} box must be filled in`;
  }
  if (box.includes('type="hidden"') && !box.includes(`value="${chosen}"`)) {
    return `the ${field} box is fixed at something other than "${chosen}"`;
  }
  return (
    whyTextIsTooShort(box, field, chosen) ??
    whyNumberIsOutOfRange(box, field, chosen)
  );
};

/** Everything somebody is about to send has to be something they could really
 * type or pick on the page in front of them, so a story cannot post a value no
 * real browser would have offered. */
export const expectCanReallySend = (
  html: string,
  values: Record<string, string>,
): void => {
  for (const [field, chosen] of Object.entries(values)) {
    expect(whyValueCannotBeSent(html, field, chosen)).toBeNull();
  }
};

/** Every box somebody is about to tick — and every box they are about to leave
 * clear — has to be one the page really offers them. A field sent as an empty
 * list is a box deliberately left alone, so the page still has to have it: a
 * form that lost the box altogether would otherwise look the same as one whose
 * box was never ticked.
 *
 * Then every box the page insists on has to end up ticked, the ones the story
 * named and the ones it never mentioned alike. A browser will not send a form
 * with a required box clear, so a send that left one out is a send nobody could
 * have made, and a story allowed to make it would be proving the site accepts
 * something no visitor could give it. A field the story named says what is sent
 * for it; a field it did not leaves the page's own ticks standing. */
const expectCanReallyTick = (
  html: string,
  ticked: Record<string, string[]>,
): void => {
  for (const [field, values] of Object.entries(ticked)) {
    // Asked for its own sake: the answer is thrown away, the loud failure when
    // the page offers no such box is the whole point.
    if (values.length === 0) boxOffered(html, field);
    for (const value of values) requireCheckboxOffered(html, field, value);
  }
  for (const box of usableCheckboxesOn(html).filter((one) => one.insisted)) {
    const sending = ticked[box.field] ?? (box.ticked ? [box.value] : []);
    if (!sending.includes(box.value)) {
      throw new Error(`The ${box.field} box must be ticked to send the form`);
    }
  }
};

/** Somebody fills a page's form in and sends it. Every value they type or pick
 * is checked against the page they were served first, so a story can never
 * send something no real browser would have offered them.
 *
 * Boxes they tick come separately, because a tick is not a typed value: it
 * sends whatever the page's own box carries, several boxes can share one name,
 * and leaving one clear sends nothing at all. Those are checked against the
 * page too — a box the form stopped rendering, or one switched off, fails here
 * rather than going through as a send nobody could have made. */
export const fillInAndSend = async (
  browser: TestBrowser,
  values: Record<string, string>,
  buttonText: string,
  ticked: Record<string, string[]> = {},
): Promise<void> => {
  // The form this button belongs to, not the whole page: a control in some
  // other form is one this send could never carry, however present it looks.
  const form = browser.formBodyFor(buttonText, [
    ...Object.keys(values),
    ...Object.keys(ticked),
  ]);
  expectCanReallySend(form, values);
  expectCanReallyTick(form, ticked);
  await browser.submitForm({ ...values, ...ticked }, buttonText);
};

/** Somebody takes a thing down from its own admin page, typing its name to
 * confirm. Every way in is followed rather than built: the delete link lives
 * behind the page's Actions tab, so a thing whose page stopped offering either
 * one is a thing nobody could take down, and the story fails with them. */
export const takeDownFromActions = async (
  browser: TestBrowser,
  typed: string,
  labelled: { deleteLink: string; submit: string },
): Promise<string> => {
  await browser.clickLink(t("entity.tab.actions"));
  await browser.clickLink(labelled.deleteLink);
  await fillInAndSend(browser, { confirm_identifier: typed }, labelled.submit);
  return browser.pageText;
};
