/**
 * The booking page's note about how many days each booking reserves, worded
 * exactly as the message catalog words it, so tests never hardcode copy.
 */

import { t } from "#i18n";

/** The length note as the site words it for one length of booking. */
export const reservesHint = (days: number): string =>
  t("public.ticket.date_duration_hint", { durationDays: days });

/** The words two phrasings share from the start. Refuses phrasings that
 * share no words, because a check built on an empty start would reject
 * every page. */
export const sharedStartOfPhrases = (one: string, two: string): string => {
  let shared = 0;
  while (shared < one.length && one[shared] === two[shared]) shared++;
  const start = one.slice(0, shared);
  if (start.trim() === "") {
    throw new Error(`"${one}" and "${two}" share no wording to check by`);
  }
  return start;
};

/** The words the length note opens with whatever the number is, taken from
 * where two differently-numbered notes stop agreeing. Rejecting this start
 * rejects the note for every length — a page wired to the wrong listing
 * would word it for that listing's own days, not for 1. */
export const reservesHintStart = (): string =>
  sharedStartOfPhrases(reservesHint(1), reservesHint(2));
