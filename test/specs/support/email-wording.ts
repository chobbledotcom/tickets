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
import {
  organiserReads,
  organiserSendsTheFormAt,
} from "#test/specs/support/browser.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import type { EmailTemplateType } from "#types";

// jscpd:ignore-end

const ADVANCED_PATH = "/admin/settings-advanced";

/** Where each template's form posts. The advanced page carries a dozen forms,
 * so each is reached by where it posts rather than by what its button says. */
const savePathFor = (which: EmailTemplateType): string =>
  `/admin/settings/email-templates/${which}`;

/** The owner opens their advanced settings and keeps what the page said. */
export const ownerOpensAdvancedSettings = organiserReads(() => ADVANCED_PATH);

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
