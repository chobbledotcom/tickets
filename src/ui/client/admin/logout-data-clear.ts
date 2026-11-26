/// <reference lib="dom" />
// effects: pure

/** Clear the scanner's stored guest data when the login page loads. A door's
 * offline ticket list holds guest names, so a device that signed out must
 * not keep them. The queued check-ins stay: they carry no guest detail, and
 * the server still owes their replay. */

import {
  GUEST_KEY_PREFIXES,
  withStoreOr,
} from "#src/ui/client/scanner-storage.ts";

/** Remove every stored key that names a door's guests. A store's own keys
 * are the keys it holds. */
const clearGuestKeys = (store: Storage): void => {
  for (const key of Object.keys(store)) {
    if (GUEST_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      store.removeItem(key);
    }
  }
};

export const initLogoutDataClear = (): void => {
  if (!document.querySelector("[data-clears-scanner-storage]")) return;
  // A blocked store holds nothing to clear.
  withStoreOr(clearGuestKeys, undefined);
};
