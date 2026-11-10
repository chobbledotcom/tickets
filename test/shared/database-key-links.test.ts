/** Direct tests for the signed links that finish a database key rotation: the
 *  second each link names, and the window it opens in. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  DATABASE_KEY_PAUSE_SECONDS,
  databaseKeyIssueUrl,
  databaseKeyLinkStartOrNull,
} from "#shared/database-key-rotation.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

/** A subsecond start must receive the full pause. */
const START_MS = 1_700_000_000_499;

/** The pause a link waits out before it opens. */
const PAUSE_MS = DATABASE_KEY_PAUSE_SECONDS * 1000;

/** Seconds a rotation link stays open, counted from its start. */
const LINK_SECONDS = 600;

describe("database key rotation links", () => {
  /** The signed link's query fields for one start. */
  const signedLink = async (siteId = 7, started = START_MS) => {
    const params = new URL(
      `http://x${await databaseKeyIssueUrl(siteId, started)}`,
    ).searchParams;
    return { sig: params.get("sig"), start: params.get("start") };
  };

  /** The start one link names, through the completion route's check. */
  const namedStart = (
    siteId: number,
    link: { sig: string | null; start: string | null },
  ): Promise<number | null> =>
    databaseKeyLinkStartOrNull(siteId, link.start, link.sig);

  test("signs the site's own completion route with the second the rotation began", async () => {
    setupTestEncryptionKey();
    const url = await databaseKeyIssueUrl(7, START_MS);
    expect(
      url.startsWith("/admin/built-sites/7/rotate-database-key/complete?sig="),
    ).toBe(true);
    expect((await signedLink()).start).toBe(String(START_MS));
  });

  test("names its start once the pause has passed, for its own site", async () => {
    setupTestEncryptionKey();
    using time = new FakeTime(START_MS);
    const link = await signedLink();
    time.tick(PAUSE_MS);
    expect(await namedStart(7, link)).toBe(START_MS);
    expect(await namedStart(8, link)).toBeNull();
  });

  test("names no rotation before the pause ends", async () => {
    setupTestEncryptionKey();
    using time = new FakeTime(START_MS);
    const link = await signedLink();
    time.tick(PAUSE_MS - 1000);
    expect(await namedStart(7, link)).toBeNull();
    time.tick(1000);
    expect(await namedStart(7, link)).toBe(START_MS);
  });

  test("names no rotation after ten minutes", async () => {
    setupTestEncryptionKey();
    using time = new FakeTime(START_MS);
    const link = await signedLink();
    time.tick((LINK_SECONDS + 1) * 1000);
    expect(await namedStart(7, link)).toBeNull();
  });

  test("names no rotation when a field is missing", async () => {
    setupTestEncryptionKey();
    const { sig, start } = await signedLink();
    expect(await databaseKeyLinkStartOrNull(7, null, sig)).toBeNull();
    expect(await databaseKeyLinkStartOrNull(7, start, null)).toBeNull();
  });

  test("names no rotation for an altered link", async () => {
    setupTestEncryptionKey();
    using _time = new FakeTime(START_MS);
    const { sig, start } = await signedLink();
    expect(
      await databaseKeyLinkStartOrNull(7, String(START_MS + 1), sig),
    ).toBeNull();
    expect(await databaseKeyLinkStartOrNull(7, "notanumber", sig)).toBeNull();
    expect(await databaseKeyLinkStartOrNull(7, "0", sig)).toBeNull();
    expect(
      await databaseKeyLinkStartOrNull(7, start, `${sig ?? ""}XXXX`),
    ).toBeNull();
  });
});
