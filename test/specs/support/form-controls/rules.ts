/**
 * Deciding whether a visitor could really send a value through a served form.
 * All pure — markup in, answers out — so the rules can be checked directly.
 * Reading the page's controls is `reading.ts`'s job; this file judges what
 * somebody is about to send against what those controls offer.
 */

import { expect } from "@std/expect";
// jscpd:ignore-start
import {
  attribute,
  boxFor,
  boxOffered,
  choicesForQuestion,
  chooserFor,
  hasFlag,
  optionFor,
  optionMarkedChosen,
  requireCheckboxOffered,
  usableCheckboxesOn,
  usableInputsOfKind,
} from "#test/specs/support/form-controls/reading.ts";
import { withoutSwitchedOffGroups } from "#test-utils/test-browser/forms.ts";

// jscpd:ignore-end

/** Why a field could not carry a value, or null when it could. Each rule below
 * answers the same question about a different piece of the page, so they share
 * one contract. */
type WhyFieldCannotCarry = (
  markup: string,
  field: string,
  chosen: string,
) => string | null;

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
  if (
    attribute(box, "type") === "hidden" &&
    attribute(box, "value") !== chosen
  ) {
    return `the ${field} box is fixed at something other than "${chosen}"`;
  }
  return (
    whyTextIsTooShort(box, field, chosen) ??
    whyNumberIsOutOfRange(box, field, chosen)
  );
};

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
    if (hasFlag(chooser.attributes, "disabled")) {
      return `the ${field} chooser is switched off`;
    }
    // Only the option being picked matters — a placeholder switched off
    // elsewhere in the list is normal and says nothing about this choice.
    const option = optionFor(chooser.options, chosen);
    if (!option) return `the ${field} chooser does not offer "${chosen}"`;
    if (hasFlag(option, "disabled")) {
      return `the ${field} option "${chosen}" is switched off`;
    }
    return null;
  }
  // A question is picked from, not typed into, so the answer has to be one of
  // the choices really on offer — otherwise a story could keep answering with
  // a choice the page stopped rendering, or switched off.
  const choices = choicesForQuestion(html, field);
  if (choices.length > 0) {
    return choices.includes(chosen)
      ? null
      : `the ${field} question does not offer "${chosen}" (offered: ${choices.join(", ")})`;
  }
  const box = boxFor(html, field);
  if (!box) return `the page has no ${field} to fill in`;
  return whyBoxCannotCarry(box, field, chosen);
};

/** One rule about a send: the markup somebody was served and the values they
 * are about to type into it, checked together. Throws when the two make a send
 * nobody could really have made. */
type ChecksASend = (html: string, values: Record<string, string>) => void;

/** Everything somebody is about to send has to be something they could really
 * type or pick on the page in front of them, so a story cannot post a value no
 * real browser would have offered. */
export const expectCanReallySend: ChecksASend = (html, values) => {
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
export const expectCanReallyTick = (
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

/** One control the page insists on: which field it belongs to, and what it
 * already holds if nobody types anything into it. */
interface InsistedControl {
  field: string;
  holds: string;
}

/** What a dropdown sends when nobody touches it: the option marked selected —
 * or, for one that picks a single answer, the first option, since a browser
 * shows that one. A list that picks many starts with nothing picked at all
 * unless the page says otherwise, so it sends nothing. */
const chosenByDefault = (options: string, picksMany: boolean): string => {
  const marked = optionMarkedChosen(options);
  if (marked !== null) return attribute(marked, "value") ?? "";
  if (picksMany) return "";
  const first = options.match(/<option\s([^>]*)>/);
  return attribute(first?.[1] ?? "", "value") ?? "";
};

/** Radios sharing one name are one question, so the page is asked about it
 * once: marking any of them required makes the whole question required, and
 * what it holds is whichever choice the page has already picked. A switched-off
 * choice is one nobody could pick, so it answers nothing. */
const insistedQuestionsOn = (html: string): InsistedControl[] => {
  const picked = new Map<string, string>();
  const asked = new Map<string, boolean>();
  for (const { field, tag } of usableInputsOfKind(html, "radio")) {
    asked.set(field, (asked.get(field) ?? false) || hasFlag(tag, "required"));
    if (hasFlag(tag, "checked")) {
      picked.set(field, attribute(tag, "value") ?? "on");
    }
  }
  return [...asked]
    .filter(([, insisted]) => insisted)
    .map(([field]) => ({ field, holds: picked.get(field) ?? "" }));
};

/** Every control the page insists on, other than its checkboxes — ticking has
 * a rule of its own, because it is not typing. A switched-off control sends
 * nothing and a browser does not hold up a form for one, and a hidden box is
 * never checked either, so neither counts here. */
const insistedControlsOn = (page: string): InsistedControl[] => {
  const html = withoutSwitchedOffGroups(page);
  const controls: InsistedControl[] = [];
  // Only the control's own attributes are read, never what it wraps: a chooser
  // holding a switched-off placeholder is not itself switched off, and a word
  // in an option's label is not a flag.
  const add = (attributes: string, holds: string) => {
    const field = attribute(attributes, "name");
    if (
      !field ||
      !hasFlag(attributes, "required") ||
      hasFlag(attributes, "disabled")
    ) {
      return;
    }
    controls.push({ field, holds });
  };
  for (const box of html.matchAll(/<input\s([^>]*)>/g)) {
    const kind = attribute(box[0], "type");
    // A tick, a picked choice, and a fixed value are each somebody else's rule.
    if (kind === "checkbox" || kind === "radio" || kind === "hidden") continue;
    add(box[0], attribute(box[0], "value") ?? "");
  }
  for (const area of html.matchAll(
    /<textarea\s([^>]*)>([\s\S]*?)<\/textarea>/g,
  )) {
    add(area[1]!, area[2]!.trim());
  }
  for (const chooser of html.matchAll(
    /<select\s([^>]*)>([\s\S]*?)<\/select>/g,
  )) {
    add(
      chooser[1]!,
      chosenByDefault(chooser[2]!, hasFlag(chooser[1]!, "multiple")),
    );
  }
  return [...controls, ...insistedQuestionsOn(html)];
};

/** Every control the page insists on has to end up carrying something, the ones
 * the story filled in and the ones it never mentioned alike. A browser will not
 * send a form with a required box empty, so a send that left one blank is a send
 * nobody could have made. A field the story named says what is sent for it; a
 * field it did not leaves whatever the page itself put there. */
export const expectNothingInsistedIsEmpty: ChecksASend = (html, values) => {
  for (const control of insistedControlsOn(html)) {
    const sending = values[control.field] ?? control.holds;
    if (sending === "") {
      throw new Error(
        `The ${control.field} box must be filled in to send the form`,
      );
    }
  }
};
