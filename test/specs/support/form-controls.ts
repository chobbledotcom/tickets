/**
 * Somebody filling a page's form in and sending it. What the page offers is
 * read by `form-controls/reading.ts`, and whether a value could really be sent
 * is judged by `form-controls/rules.ts`; this file is the sending itself, for
 * the stories.
 */

import { t } from "#i18n";
import {
  expectCanReallySend,
  expectCanReallyTick,
  expectNothingInsistedIsEmpty,
} from "#test/specs/support/form-controls/rules.ts";

/** The parts of a browser that filling a form in really touches: the form one
 * button belongs to, and the sending of it. Named as those parts rather than as
 * the whole browser, so a test can stand in for it with just these. */
export interface FillsInForms {
  formBodyFor(buttonText: string, fieldNames?: string[]): string;
  submitForm(
    values: Record<string, string | string[]>,
    buttonText?: string,
  ): Promise<void>;
}

/** Taking a thing down needs those, plus a way in and the words it lands on. */
export interface TakesThingsDown extends FillsInForms {
  clickLink(text: string): Promise<void>;
  readonly pageText: string;
}

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
  browser: FillsInForms,
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
  expectNothingInsistedIsEmpty(form, values);
  await browser.submitForm({ ...values, ...ticked }, buttonText);
};

/** Somebody takes a thing down from its own admin page, typing its name to
 * confirm. Every way in is followed rather than built: the delete link lives
 * behind the page's Actions tab, so a thing whose page stopped offering either
 * one is a thing nobody could take down, and the story fails with them. */
export const takeDownFromActions = async (
  browser: TakesThingsDown,
  typed: string,
  labelled: { deleteLink: string; submit: string },
): Promise<string> => {
  await browser.clickLink(t("entity.tab.actions"));
  await browser.clickLink(labelled.deleteLink);
  await fillInAndSend(browser, { confirm_identifier: typed }, labelled.submit);
  return browser.pageText;
};
