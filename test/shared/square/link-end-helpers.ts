/** Shared row fixtures for the Square link-end queue and its expiry run. */

import { expect } from "@std/expect";
import { hmacHash } from "#crypto/hashing.ts";
/* jscpd:ignore-start -- imports */
import { execute, queryOne } from "#db/client.ts";
import {
  type DueSquareLinkEnd,
  getDueSquareLinkEnds,
  stageSquareLinkEnd,
} from "#db/square-link-ends.ts";
import type { FetchResult } from "#shared/fetch.ts";
import { nowIso } from "#shared/now.ts";

/* jscpd:ignore-end */

export const PAST = "2020-01-01T00:00:00Z";
export const WINDOW_END = "2999-01-01T13:00:00Z";

export interface StoredRow {
  readonly next_attempt_at: string;
  readonly sealed_handle: string;
  readonly state: string;
}

export const storedRow = async (sessionId: string): Promise<StoredRow | null> =>
  queryOne<StoredRow>(
    "SELECT state, sealed_handle, next_attempt_at FROM square_link_ends WHERE session_index = ?",
    [await hmacHash(sessionId)],
  );

/** Stage a row and make it due now. */
export const stageDue = async (
  sessionId: string,
  linkId = `link_${sessionId}`,
): Promise<void> => {
  await stageSquareLinkEnd(sessionId, linkId, WINDOW_END);
  await backdateAttempt(sessionId);
};

/** Move one row's attempt time to the past, so it reads due again. */
export const backdateAttempt = async (sessionId: string): Promise<void> => {
  await execute(
    "UPDATE square_link_ends SET next_attempt_at = ? WHERE session_index = ?",
    [PAST, await hmacHash(sessionId)],
  );
};

export const theAnswer = (status: number, body: string): FetchResult => ({
  headers: new Headers(),
  ok: status >= 200 && status < 300,
  status,
  text: body,
});

/** Assert a row sits pending and due again, ready for a fresh claim. */
export const expectBackToQueue = async (sessionId: string): Promise<void> => {
  const stored = await storedRow(sessionId);
  expect(stored?.state).toBe("pending");
  expect(new Date(stored!.next_attempt_at).getTime()).toBeLessThanOrEqual(
    Date.parse(nowIso()),
  );
};

/** The rows currently due, in queue order. */
export const dueRows = async (): Promise<DueSquareLinkEnd[]> =>
  getDueSquareLinkEnds();
