// effects: pure

/** Clear the scanner's stored guest data when the login page loads. A door's
 * offline ticket list holds guest names, so a device that signed out must
 * not keep them. The queued check-ins stay: they carry no guest detail, and
 * the server still owes their replay. */

/** The prefixes of the scanner's per-door storage. */
const TICKETS_KEY_PREFIX = "scanner-tickets-";
const MODE_KEY_PREFIX = "scanner-offline-mode-";

/** Remove every stored key that starts with `prefix`. */
const removeKeysWithPrefix = (storage: Storage, prefix: string): void => {
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) {
      storage.removeItem(key);
    }
  }
};

export const initLogoutDataClear = (): void => {
  if (!document.querySelector("[data-clears-scanner-storage]")) return;
  let storage: Storage;
  try {
    storage = localStorage;
  } catch {
    // Site data is blocked for this page, so nothing is stored to clear.
    return;
  }
  removeKeysWithPrefix(storage, TICKETS_KEY_PREFIX);
  removeKeysWithPrefix(storage, MODE_KEY_PREFIX);
};
