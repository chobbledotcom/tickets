/**
 * Filling a page's form in and sending it. Every value typed and every box
 * ticked has to be one the page really offered, and nothing the page insists
 * on may be left empty.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";

// jscpd:ignore-end

describe("filling a form in and sending it", () => {
  /** A browser stand-in: it holds the page it was served and remembers what
   * was sent, so the helper's own two jobs can be seen separately. */
  const pageOffering = (html: string) => {
    const sent: Array<{
      button: string;
      values: Record<string, string | string[]>;
    }> = [];
    return {
      browser: {
        currentHtml: html,
        // The stand-in serves one form, so the body a button would send is
        // the whole of it. Which form a button belongs to is the browser's
        // own job, and is checked against real markup in its own tests.
        formBodyFor: () => html,
        submitForm: (
          values: Record<string, string | string[]>,
          button: string,
        ) => {
          sent.push({ button, values });
          return Promise.resolve();
        },
      },
      sent,
    };
  };

  /** Fill in and send the page the stand-in is serving. Its browser is only
   * the handful of parts this helper touches, named as those parts. */
  const sendOn = (
    page: ReturnType<typeof pageOffering>,
    values: Record<string, string>,
    ticked?: Record<string, string[]>,
  ): Promise<void> => fillInAndSend(page.browser, values, "Invite", ticked);

  const NAME_BOX = '<input name="username" value="">';
  const dayBox = (insisted = "") =>
    `<input type="checkbox" name="days" value="Monday"${insisted}>`;
  const DAY_BOX = dayBox();

  /** The same person typing and ticking the same thing throughout, so each
   * example below differs only in what the page offered them. */
  const TYPED = { username: "sam" };
  const TICKED = { days: ["Monday"] };

  /** Ticking the day and typing the name, and both going through. Two
   * examples below share it, because a ticked box goes through whether or not
   * the page insisted on it. */
  const TICKS_AND_TYPES = {
    sends: { ...TICKED, ...TYPED },
    ticked: TICKED,
    typed: TYPED,
  };

  /** One filling-in: what the page offers, what is typed and ticked into it,
   * and what comes of it — the one send it makes, or the words it is refused
   * with. A refusal must also leave nothing sent, which is checked for every
   * one of them. */
  const FILLINGS: Array<{
    offering: string;
    refusedWith?: string;
    sends?: Record<string, string | string[]>;
    ticked?: Record<string, string[]>;
    typed: Record<string, string>;
    what: string;
  }> = [
    {
      offering: NAME_BOX,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends the values, naming the button that was pressed",
    },
    {
      ...TICKS_AND_TYPES,
      offering: `${NAME_BOX}${DAY_BOX}`,
      what: "sends the boxes that were ticked alongside what was typed",
    },
    {
      offering: `${NAME_BOX}${DAY_BOX}`,
      sends: { days: [] },
      ticked: { days: [] },
      typed: {},
      what: "sends a box left clear as nothing at all",
    },
    {
      offering: '<input name="username" value="" disabled>',
      refusedWith: "the username box is switched off",
      typed: TYPED,
      what: "sends nothing when a value could not really be sent",
    },
    {
      offering: NAME_BOX,
      refusedWith: 'The page offers no days box sending "Monday"',
      ticked: TICKED,
      typed: TYPED,
      what: "sends nothing when the page offers no such box to tick",
    },
    {
      offering: NAME_BOX,
      refusedWith: "The page offers no days box to tick",
      ticked: { days: [] },
      typed: TYPED,
      what: "sends nothing when the box left clear is not on the page",
    },
    {
      offering: `${NAME_BOX}${dayBox(" required")}`,
      refusedWith: "The days box must be ticked to send the form",
      ticked: { days: [] },
      typed: TYPED,
      what: "sends nothing when the box left clear is one the page insists on",
    },
    {
      ...TICKS_AND_TYPES,
      offering: `${NAME_BOX}${dayBox(" required")}`,
      what: "sends a box the page insists on once it is ticked",
    },
    {
      offering: `${NAME_BOX}<input type="checkbox" name="terms" value="yes" required>`,
      refusedWith: "The terms box must be ticked to send the form",
      typed: TYPED,
      what: "sends nothing when the page insists on a box nobody mentioned",
    },
    {
      offering: `${NAME_BOX}<input type="checkbox" name="terms" value="yes" required checked>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when the page has already ticked the box it insists on",
    },
    {
      // A box with no value of its own still insists on being ticked, and a
      // browser would refuse to send the form without it.
      offering: `${NAME_BOX}<input type="checkbox" name="terms" required>`,
      refusedWith: "The terms box must be ticked to send the form",
      typed: TYPED,
      what: "sends nothing when the insisted box has no value of its own",
    },
    {
      offering: `${NAME_BOX}<input type="checkbox" name="terms" required>`,
      sends: { terms: ["on"], ...TYPED },
      ticked: { terms: ["on"] },
      typed: TYPED,
      what: 'ticks a box with no value of its own by sending "on"',
    },
    {
      // The story types a name and never mentions the reference box, but a
      // browser would not send the form while that box sits empty.
      offering: `${NAME_BOX}<input name="reference" required>`,
      refusedWith: "The reference box must be filled in to send the form",
      typed: TYPED,
      what: "sends nothing when a box the page insists on is left empty",
    },
    {
      offering: `${NAME_BOX}<input name="reference" value="AB-1" required>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when the page has already filled the box it insists on",
    },
    {
      offering: `${NAME_BOX}<textarea name="reason" required></textarea>`,
      refusedWith: "The reason box must be filled in to send the form",
      typed: TYPED,
      what: "sends nothing when a writing space the page insists on is empty",
    },
    {
      // No option is marked, so a browser would leave the empty first one
      // showing — which is no answer at all for a chooser it insists on.
      offering: `${NAME_BOX}<select name="tier" required><option value=""></option><option value="gold">Gold</option></select>`,
      refusedWith: "The tier box must be filled in to send the form",
      typed: TYPED,
      what: "sends nothing when an insisted chooser starts on no answer",
    },
    {
      offering: `${NAME_BOX}<select name="tier" required><option value=""></option><option value="gold" selected>Gold</option></select>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when an insisted chooser already has an answer picked",
    },
    {
      // Nothing switched off is sent, and a browser holds no form up for it.
      offering: `${NAME_BOX}<input name="reference" value="" required disabled>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when the only empty insisted box is switched off",
    },
    {
      offering: `${NAME_BOX}<select name="tier" required></select>`,
      refusedWith: "The tier box must be filled in to send the form",
      typed: TYPED,
      what: "sends nothing when an insisted chooser offers no answers at all",
    },
    {
      // A chooser that starts on a switched-off placeholder is the ordinary
      // way of saying "pick something" — the placeholder is switched off, the
      // chooser is not, and it still has no answer.
      offering: `${NAME_BOX}<select name="tier" required><option value="" disabled selected>Choose a tier</option><option value="gold">Gold</option></select>`,
      refusedWith: "The tier box must be filled in to send the form",
      typed: TYPED,
      what: "sends nothing when an insisted chooser sits on its placeholder",
    },
    {
      // The words on an option are what somebody reads, not flags on the
      // chooser holding it — this one is not insisted on at all, so sitting
      // on its empty first choice is nobody's problem.
      offering: `${NAME_BOX}<select name="tier"><option value="">Not required </option><option value="gold">Gold</option></select>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "does not read a word on an option as a flag on its chooser",
    },
    {
      // A tick, a fixed value, and a control with no name to send under are
      // each somebody else's rule, so none of them holds this form up.
      offering: `${NAME_BOX}<input type="checkbox" name="agree" value="yes"><input type="hidden" name="token" value="" required><input value="" required>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when the only empty insisted controls are not typed in",
    },
    {
      // Radios sharing a name are one question. Marking any of them required
      // makes the question required, and nothing here answers it.
      offering: `${NAME_BOX}<input type="radio" name="pick" value="a" required><input type="radio" name="pick" value="b">`,
      refusedWith: "The pick box must be filled in to send the form",
      typed: TYPED,
      what: "sends nothing when an insisted question has no choice picked",
    },
    {
      offering: `${NAME_BOX}<input type="radio" name="pick" value="a" required><input type="radio" name="pick" value="b" checked>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when the page has already picked a choice for the question",
    },
    {
      // A choice with no value of its own sends "on", the same word a browser
      // sends, so the question counts as answered.
      offering: `${NAME_BOX}<input type="radio" name="pick" required checked>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when the picked choice has no value of its own",
    },
    {
      // Answering with a choice the page does not offer is answering with
      // something nobody could have picked.
      offering: `${NAME_BOX}<input type="radio" name="pick" value="a"><input type="radio" name="pick" value="b">`,
      refusedWith: 'the pick question does not offer "z" (offered: a, b)',
      typed: { ...TYPED, pick: "z" },
      what: "sends nothing when the answer is not one the question offers",
    },
    {
      offering: `${NAME_BOX}<input type="radio" name="pick" value="a"><input type="radio" name="pick" value="b">`,
      sends: { pick: "b", ...TYPED },
      typed: { ...TYPED, pick: "b" },
      what: "sends an answer the question really offers",
    },
    {
      // A switched-off choice is no longer on offer, so answering with it is
      // answering with something nobody could pick.
      offering: `${NAME_BOX}<input type="radio" name="pick" value="a" disabled><input type="radio" name="pick" value="b">`,
      refusedWith: 'the pick question does not offer "a" (offered: b)',
      typed: { ...TYPED, pick: "a" },
      what: "sends nothing when the answer picked has been switched off",
    },
    {
      // A group switched off as a whole takes everything in it with it: nobody
      // could tick this box, so the form is not held up waiting for it.
      offering: `${NAME_BOX}<fieldset disabled><legend>Extras</legend><input type="checkbox" name="terms" value="yes" required></fieldset>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when the box it insists on sits in a switched-off group",
    },
    {
      // The same box in a group that is not switched off still holds it up.
      offering: `${NAME_BOX}<fieldset><legend>Extras</legend><input type="checkbox" name="terms" value="yes" required></fieldset>`,
      refusedWith: "The terms box must be ticked to send the form",
      typed: TYPED,
      what: "sends nothing when that group is not switched off after all",
    },
    {
      // A group with nothing switched off about it holds nothing back, whatever
      // else it carries.
      offering: `${NAME_BOX}<fieldset class="checkboxes"><legend>Extras</legend><input type="checkbox" name="terms" value="yes" required></fieldset>`,
      refusedWith: "The terms box must be ticked to send the form",
      typed: TYPED,
      what: "sends nothing when a group with other words on it is not switched off",
    },
    {
      // A switched-off group with no heading takes everything with it.
      offering: `${NAME_BOX}<fieldset disabled><input type="checkbox" name="terms" value="yes" required></fieldset>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when the switched-off group has no heading of its own",
    },
    {
      // Nobody could type into a box in a switched-off group either, so a story
      // filling one in is filling in something that is not there to fill.
      offering: `${NAME_BOX}<fieldset disabled><legend>Extras</legend><input name="reference"></fieldset>`,
      refusedWith: "the page has no reference to fill in",
      typed: { ...TYPED, reference: "AB-1" },
      what: "sends nothing when the box typed into sits in a switched-off group",
    },
    {
      // A group written inside a switched-off group does not end it: the box
      // after the inner group closes is still switched off by the outer one.
      offering: `${NAME_BOX}<fieldset disabled><legend>Extras</legend><fieldset><legend>Inner</legend></fieldset><input type="checkbox" name="terms" value="yes" required></fieldset>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when a group inside the switched-off one does not end it",
    },
    {
      // Only a switched-off group's own heading stays usable. The heading here
      // belongs to the group written inside it, so the box in that heading is
      // switched off like everything else the outer group holds.
      offering: `${NAME_BOX}<fieldset disabled><fieldset><legend><input type="checkbox" name="terms" value="yes" required></legend></fieldset></fieldset>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when the only heading belongs to a group written inside",
    },
    {
      // A choice with no value of its own is answered with "on", the same word
      // a browser sends, so that is what the question offers.
      offering: `${NAME_BOX}<input type="radio" name="pick" required>`,
      sends: { pick: "on", ...TYPED },
      typed: { ...TYPED, pick: "on" },
      what: "answers a question whose choice has no value of its own",
    },
    {
      // A list that picks many starts with nothing picked, so a browser would
      // hold the form up rather than send its first option.
      offering: `${NAME_BOX}<select name="tiers" multiple required><option value="gold">Gold</option></select>`,
      refusedWith: "The tiers box must be filled in to send the form",
      typed: TYPED,
      what: "sends nothing when an insisted many-answer list has none picked",
    },
    {
      offering: `${NAME_BOX}<select name="tiers" multiple required><option value="gold" selected>Gold</option></select>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when a many-answer list already has an answer picked",
    },
    {
      // Nobody could pick a switched-off choice, so the question is left
      // unanswered even though one of its radios says it is required.
      offering: `${NAME_BOX}<input type="radio" name="pick" value="a" required disabled checked>`,
      sends: { ...TYPED },
      typed: TYPED,
      what: "sends when the only choice on an insisted question is switched off",
    },
  ];

  for (const example of FILLINGS) {
    test(example.what, async () => {
      const page = pageOffering(example.offering);
      const filledIn = sendOn(page, example.typed, example.ticked);
      if (example.refusedWith === undefined) {
        await filledIn;
        expect(page.sent).toEqual([
          { button: "Invite", values: example.sends },
        ]);
        return;
      }
      await expect(filledIn).rejects.toThrow(example.refusedWith);
      expect(page.sent).toEqual([]);
    });
  }
});
