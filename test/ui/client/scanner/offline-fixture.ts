// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate
// a trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical
// mode.

/**
 * The offline suites' shared wiring: one door's storage keys, the digests
 * the saved list holds, the server answer the token list gives, and the
 * waits the direct suites need. The suites drive the built bundle;
 * `fixture.ts` builds the pages.
 */

import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { hmacHex } from "#crypto/sha256.ts";
import {
  type QueuedCheckIn,
  queuedCheckIns,
} from "#src/ui/client/scanner-door-store.ts";

export const HASHES_KEY = "scanner:hashes:group-5";

/** The digest the device stores for one token: the keyed digest the door's
 * cache key makes, the same construction the token list endpoint and the
 * page's own scan digest use. The key digests under the same door the
 * fixture page's `data-door-cache-key` names. */
export const digestOf = (token: string): Promise<string> =>
  hmacHex(deriveDoorCacheKey("group:5"), token);

/** The door's scope the fixtures wire: group 5, as the tokens path names
 * it. */
const SCOPE = { id: 5, kind: "group" } as const;

/** The door's queued deliveries, read the way the page reads them:
 * through the store's own reader. */
export const readQueue = (): QueuedCheckIn[] =>
  queuedCheckIns(localStorage, SCOPE);

/** Drain the promise hops the stubbed fetch and its render chain need —
 * the same bound-drain idiom `whenTextShows` uses, with no clock. */
export const settle = async (): Promise<void> => {
  for (let hops = 0; hops < 100; hops++) {
    await Promise.resolve();
  }
};

/** The reply the door's token list endpoint gives, digests only. */
export const hashesReply = async (...tokens: string[]): Promise<Response> =>
  Response.json({
    hashes: (await Promise.all(tokens.map(digestOf))).sort(),
  });

/** The door's saved list, once the refresh lands the expected digest in
 * storage: the refresh saves on its own hops, so the test waits for the
 * list instead of counting hops. */
export const whenListIs = async (digest: string): Promise<string> => {
  const savedHashes = (): string | null => localStorage.getItem(HASHES_KEY);
  for (let hop = 0; hop < 50; hop++) {
    await Promise.resolve();
    const saved = savedHashes();
    if (saved?.includes(digest)) {
      return saved;
    }
    await digestOf("warmup");
  }
  const finalSaved = savedHashes();
  return finalSaved ?? "";
};
