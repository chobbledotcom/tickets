import type { MessageGroup } from "#locales/manifest.ts";
import { catalogWords } from "./catalog-words.ts";

/**
 * Page-text assertions bound to the key that renders their marker. The
 * helper names the message group and key, the gate verifies the key, and
 * the words always match what the app renders. Assert text the app builds
 * outside the catalog with the plain string methods instead.
 */

/** What one page-text assertion reads: the captured text, then the message. */
type PageTextArgs = [text: string, group: MessageGroup, key: string];

/** How many times the captured page text carries this message's words. */
export const pageTextCount = async (
  ...[text, group, key]: PageTextArgs
): Promise<number> => {
  const words = await catalogWords(group, key);
  return text.split(words).length - 1;
};

/** Does the captured page text carry this message's words? */
export const pageTextIncludes = async (
  ...args: PageTextArgs
): Promise<boolean> => (await pageTextCount(...args)) > 0;
