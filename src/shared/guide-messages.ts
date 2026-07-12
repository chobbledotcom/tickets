/**
 * Load the admin guide's translations on demand and merge them into the `en`
 * locale.
 *
 * The guide bundle is the single largest locale file (~120KB) and is only needed
 * by the two guide routes (the admin guide page and the markdown formatting-help
 * page), so it is kept out of the eager `en` merge (see `src/locales/en/index.ts`)
 * and off the cold-boot path. Those routes await this before rendering; loading
 * is dynamic so the bundle stays in a lazy chunk. `once` makes the merge happen a
 * single time per isolate. A guide key requested before this resolves still
 * throws in `t()`, exactly as a typo would.
 */

import { once } from "#fp";
import { registerMessages } from "#i18n";

export const ensureGuideMessages = once(async (): Promise<void> => {
  const { default: guide } = await import("#locales/en/guide.ts");
  registerMessages("en", guide);
});
