import { ensureMessageGroups, t } from "#i18n";
import type { MessageGroup } from "#locales/manifest.ts";

/**
 * The words one catalog message renders, for the driver to click, count, or
 * match. The label gate verifies the key, so a rename travels with the spec
 * instead of breaking the schedule-only nightly run.
 */
export const catalogWords = async (
  group: MessageGroup,
  key: string,
  values?: Record<string, unknown>,
): Promise<string> => {
  await ensureMessageGroups([group]);
  return t(key, values);
};
