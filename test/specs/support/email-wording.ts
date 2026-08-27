/**
 * The owner replacing the wording of the emails the site sends.
 *
 * Two templates, one per email, each with a subject and two bodies. The site
 * has wording of its own for both, which shows through the empty boxes until
 * the owner writes something in them.
 */

// jscpd:ignore-start

import { settings } from "#db/settings.ts";
import {
  buildTemplateData,
  renderEmailContent,
} from "#shared/email-renderer.ts";
import type { EmailContent } from "#templates/email/shared.ts";
import {
  openAdminPage,
  organiserSendsTheFormAt,
} from "#test/specs/support/browser.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { makeTestEntry } from "#test-utils/factories.ts";
import { settingsAsStored } from "#test-utils/settings.ts";
import { decodeEntities } from "#test-utils/test-browser/parsing.ts";
import type { EmailTemplateType } from "#types";

// jscpd:ignore-end

const ADVANCED_PATH = "/admin/settings-advanced";

/** Somewhere for a rendered email to point at. Nothing reads it back. */
const A_TICKET_PAGE = "https://example.test/t/ABC";

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

/** An email's three parts, taken from wherever this reader finds them. Every
 * reader below answers in the same shape, so one place decides what "the
 * wording" is and none of them can leave a part out. */
const threeParts = (
  of: (part: keyof EmailContent) => string,
): EmailContent => ({
  html: of("html"),
  subject: of("subject"),
  text: of("text"),
});

/** A reader of one email's three parts, taken after the settings are read
 * back off disk. The two readers below differ only in where they look, so
 * the reload and the shaping live here once. */
const readsAnEmail =
  (source: (which: EmailTemplateType) => Promise<EmailContent>) =>
  async (which: EmailTemplateType): Promise<EmailContent> => {
    await settingsAsStored();
    const found = await source(which);
    return threeParts((part) => found[part]);
  };

/** What the site would send for one email right now, read back out of the
 * store so a story proves the wording was kept rather than merely echoed. */
export const wordingKeptFor = readsAnEmail((which) =>
  Promise.resolve(settings.email.templateSet(which)),
);

/** Nothing of the owner's own on file, so the site falls back to its own
 * wording. Every part empty, not just the subject: one part left behind would
 * be the owner's words mixed into the site's. */
export const SITES_OWN_WORDING: EmailContent = threeParts(() => "");

/** What every box on one template's form would send right now, read the way a
 * browser submits it. The claim is that the boxes are empty: a page that
 * prefilled one with the site's own wording would store that wording as the
 * owner's the first time they pressed Save. */
export const wordingTheBoxesWouldSend = async (
  world: TicketsWorld,
  which: EmailTemplateType,
): Promise<EmailContent> => {
  const page = await openAdminPage(world, ADVANCED_PATH);
  return threeParts((part) => {
    const sent = page.wouldSendAt(savePathFor(which), part);
    // A missing box is not an empty one. Without this the caller compares
    // three absent controls against three empty strings and passes.
    if (sent === null) throw new Error(`No ${part} box for the ${which} email`);
    return sent;
  });
};

/** What the site would really send for one email right now, rendered. A story
 * about the owner's wording is about the email that goes out, not the shape of
 * the row behind it. */
export const emailTheSiteWouldSend = readsAnEmail(async (which) =>
  renderEmailContent(
    which,
    await buildTemplateData([makeTestEntry()], "GBP", A_TICKET_PAGE),
  ),
);

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
