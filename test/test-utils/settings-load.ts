/** Loading one raw setting value through the production load path. */

import { settings } from "#db/settings.ts";

/** Write a raw value, drop the cached snapshot, and load just that key. The
 * caller asserts what the getter reads after the load. */
export const loadRawSetting = async (
  key: string,
  value: string,
): Promise<void> => {
  await settings.setRaw(key, value);
  settings.invalidateCache();
  await settings.loadKeys([key]);
};
