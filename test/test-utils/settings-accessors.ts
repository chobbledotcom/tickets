/** Checks for a settings value that a spec writes and then reads back. */

import { expect } from "@std/expect";
import { settings } from "#db/settings.ts";

/** One setting reached through its public getter and updater. */
export interface SettingAccess<T> {
  read: () => T;
  update: (value: T) => Promise<unknown>;
}

/** Write `value` through the updater, then pin what the getter reads back. */
export const expectStoredSetting = async <T>(
  { read, update }: SettingAccess<T>,
  value: T,
): Promise<void> => {
  await update(value);
  expect(read()).toBe(value);
};

/** Write `value`, write "", then pin what the getter falls back to. */
export const expectStoredThenCleared = async <T extends string>(
  setting: SettingAccess<T> & { update: (value: T | "") => Promise<unknown> },
  value: T,
  cleared: T,
): Promise<void> => {
  await expectStoredSetting(setting, value);
  await setting.update("");
  expect(setting.read()).toBe(cleared);
};

/** Drop the cached snapshot, then load `keys` back over it. The caller
 *  asserts what the getters read after the load. */
export const reloadSettings = async (
  keys: readonly string[],
): Promise<void> => {
  settings.invalidateCache();
  await settings.loadKeys(keys);
};
