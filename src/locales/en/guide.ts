/**
 * The admin guide's translations, split out of the eager `en` merge.
 *
 * `guide.json` is ~120KB — by far the largest locale file — and its keys are
 * only used by the two guide routes (the admin guide page and the markdown
 * formatting-help page). Keeping it out of `src/locales/en/index.ts` (the map
 * built at module load) keeps that weight off the cold-boot path. This module is
 * imported only dynamically (by `ensureGuideMessages`), so esbuild leaves it in a
 * lazy chunk the server entry never parses eagerly.
 */

import guide from "./guide.json" with { type: "json" };

export default guide as Record<string, string>;
