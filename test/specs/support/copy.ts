/**
 * The site's own words, read from a step.
 *
 * A step runs outside a request, so nothing has pulled a page's copy in yet
 * and `t` throws rather than guessing at it. Any step that quotes the site
 * loads that copy's group through here first. Doing it at the moment of
 * reading, rather than in a hook, keeps a story that quotes nothing from
 * paying for copy it never uses.
 */

import { ensureMessageGroups, t } from "#i18n";
import type { MessageGroup } from "#locales/manifest.ts";

/** One group's copy, ready to be quoted. */
export const copyLoaded = (group: MessageGroup): Promise<void> =>
  ensureMessageGroups([group]);

/** One thing the site says, asked for by its key. */
export type ReadsCopy = (
  key: string,
  values?: Record<string, unknown>,
) => Promise<string>;

/** A reader for one group's words, curried on the group so a support module
 * names it once and every step below reads through that one name. */
export const copyFrom =
  (group: MessageGroup): ReadsCopy =>
  async (key, values) => {
    await copyLoaded(group);
    return t(key, values);
  };
