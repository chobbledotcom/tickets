/**
 * The owner replacing the wording of the emails the site sends.
 *
 * Two templates, one per email, each with a subject and two bodies. The site
 * has wording of its own for both, which shows through the empty boxes until
 * the owner writes something in them.
 */

// jscpd:ignore-start

import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import type { EmailContent } from "#templates/email/shared.ts";
import { organiserSendsTheFormAt } from "#test/specs/support/browser.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { decodeEntities } from "#test-utils/test-browser/parsing.ts";
import type { EmailTemplateType } from "#types";

// jscpd:ignore-end

const ADVANCED_PATH = "/admin/settings-advanced";

/** Where each template's form posts. The advanced page carries a dozen forms,
 * so each is reached by where it posts rather than by what its button says. */
const savePathFor = (which: EmailTemplateType): string =>
  `/admin/settings/email-templates/${which}`;

/** The owner writes one email's wording and saves it, through the form the
 * page really serves. */
export const ownerWrites = async (
  world: TicketsWorld,
  which: EmailTemplateType,
  wording: EmailContent,
): Promise<void> => {
  await organiserSendsTheFormAt(world, ADVANCED_PATH, savePathFor(which), {
    ...wording,
  });
  world.wordingWritten = wording;
};

/** What the site would send for one email right now, read back out of the
 * store so a story proves the wording was kept rather than merely echoed. */
export const wordingKeptFor = async (
  which: EmailTemplateType,
): Promise<EmailContent> => {
  settings.invalidateCache();
  await settings.loadKeys(ALL_SETTINGS_KEYS);
  const kept = settings.email.templateSet(which);
  return { html: kept.html, subject: kept.subject, text: kept.text };
};

/** Nothing of the owner's own on file, so the site falls back to its own
 * wording. Every part empty, not just the subject: one part left behind would
 * be the owner's words mixed into the site's. */
export const SITES_OWN_WORDING: EmailContent = {
  html: "",
  subject: "",
  text: "",
};

/** Every box the owner can start from the site's own wording, and the wording
 * each one must offer. Reading the boxes one at a time is the point: a page
 * that carried the right wording on one box and nothing on the other three
 * would still hold the words somewhere. */
export const BOXES_WITH_A_DEFAULT = [
  { box: "confirmation_html", part: "html", which: "confirmation" },
  { box: "confirmation_text", part: "text", which: "confirmation" },
  { box: "admin_html", part: "html", which: "admin" },
  { box: "admin_text", part: "text", which: "admin" },
] as const satisfies ReadonlyArray<{
  box: string;
  part: "html" | "text";
  which: EmailTemplateType;
}>;

/** The wording one box carries for the link that fills it in, or null when
 * the page renders no such box. The site's own wording is written onto the
 * box itself, because the link only copies what is already there. */
export const defaultTheBoxOffers = (
  page: string,
  box: string,
): string | null => {
  const tag = page.match(
    new RegExp(`<textarea\\b[^>]*\\bid="${box}"[^>]*>`, "i"),
  )?.[0];
  const carried = tag?.match(/\bdata-default-tpl="([^"]*)"/)?.[1];
  return carried === undefined ? null : decodeEntities(carried);
};

/** Wording the owner saved before the scenario started. */
export const ownerAlreadyWrote = async (
  which: EmailTemplateType,
  wording: EmailContent,
): Promise<void> => {
  await Promise.all([
    settings.update.email.template(which, "subject", wording.subject),
    settings.update.email.template(which, "html", wording.html),
    settings.update.email.template(which, "text", wording.text),
  ]);
  settings.invalidateCache();
};
