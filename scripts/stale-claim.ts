/**
 * A claim on a shared job, kept as a file whose owner can walk away.
 *
 * The plain file locks in #scripts/lock-file.ts end the moment their holder's
 * process ends, and a waiter cannot tell a busy holder from a dead one. Some
 * jobs need exactly that told apart: an install another runner should take
 * over if its downloader died, a run folder that must not be cleared while
 * its supervisor lives. So a claim is a file naming its owner and when that
 * owner last checked in. The holder keeps touching the file while it works; a
 * claim untouched for long enough counts as walked away from, and the next
 * taker removes it and claims in its place.
 *
 * The database migration lock (src/shared/db/migrations/lock.ts) is this same
 * shape written into a settings row — an owner token, a freshness cutoff, a
 * steal of anything older, a release only of your own claim. This module is
 * the file version, shared by the stripe-mock install and mutation runs.
 */

import {
  type LockBody,
  type PathLockHolder,
  withFileLock,
} from "#scripts/lock-file.ts";
import { nullIfNotFound, rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { delay } from "#shared/now.ts";

/** How a claim is kept fresh, and when it counts as walked away from. */
export type StaleClaimSettings = {
  /** A claim untouched for this long may be removed and taken over. */
  staleMs: number;
  /** How often the holder rewrites its check-in time while it works. */
  touchMs: number;
};

/** How long to keep asking for a busy claim, and what to call it on giving up. */
export type ClaimWait = {
  /** Names the claim in the giving-up error, e.g. "stripe-mock install lock". */
  name: string;
  retryMs: number;
  timeoutMs: number;
};

/** A claim this caller holds: release it once the work is done. */
type HeldClaim = {
  owner: string;
  release: () => Promise<void>;
};

type ClaimRecord = {
  owner?: string;
  writtenAt: number;
};

const CLAIM_GUARD_SUFFIX = ".guard";

/**
 * Takers serialize through a plain file lock beside the claim, so two of them
 * cannot both judge a claim stale and both believe they created its successor.
 */
const claimGuardPath = (path: string): string => `${path}${CLAIM_GUARD_SUFFIX}`;

/**
 * Hold the takers' guard for the claim at `path` while `body` runs, so a
 * decision made about the claim — is it fresh, may what it protects go —
 * cannot interleave with somebody in the middle of taking it.
 */
export const withClaimGuard: PathLockHolder = (path, body) =>
  withFileLock(claimGuardPath(path), body);

const formatClaimRecord = (owner: string): string => `${owner}\n${Date.now()}`;

const parseClaimRecord = (text: string): ClaimRecord => {
  // Splitting always yields at least one part, so first is always a string.
  const [first, second] = text.split("\n") as [string, string?];
  const writtenAt = Number(second ?? first);
  return second === undefined ? { writtenAt } : { owner: first, writtenAt };
};

const readClaimRecord = async (path: string): Promise<ClaimRecord> => {
  const record = parseClaimRecord(await Deno.readTextFile(path));
  if (record.writtenAt > 0) return record;

  const stat = await Deno.stat(path);
  return { ...record, writtenAt: stat.mtime!.getTime() };
};

const writeClaimTime = (path: string, owner: string): Promise<void> =>
  Deno.writeTextFile(path, formatClaimRecord(owner));

const claimAgeMs = async (path: string): Promise<number> =>
  Date.now() - (await readClaimRecord(path)).writtenAt;

/**
 * Is somebody's claim here, touched recently enough to still be theirs? A
 * missing claim is nobody's, which is the expected way for one to be absent.
 */
export const claimIsFresh = async (
  path: string,
  staleMs: number,
): Promise<boolean> => {
  const age = await nullIfNotFound(claimAgeMs(path));
  return age !== null && age < staleMs;
};

/** Remove the claim, treating one already cleared by another taker as gone. */
const removeClaim = async (path: string): Promise<void> => {
  try {
    await Deno.remove(path);
  } catch (error) {
    rethrowUnlessNotFound(error);
  }
};

const removeClaimIfOwned = async (
  path: string,
  owner: string,
): Promise<void> => {
  try {
    if ((await readClaimRecord(path)).owner === owner) {
      await Deno.remove(path);
    }
  } catch (error) {
    rethrowUnlessNotFound(error);
  }
};

/** Stops touching a claim, and throws if the holding was not kept safe. */
export type StopTouching = () => Promise<void>;

const startClaimTouching = (
  path: string,
  owner: string,
  { staleMs, touchMs }: StaleClaimSettings,
): StopTouching => {
  let stopped = false;
  let timeout = setTimeout(touchClaim, touchMs);
  let latestTouch: Promise<void> = Promise.resolve();
  let failingSince: number | null = null;
  let wentUnfreshed = false;

  const scheduleNextTouch = () => {
    if (stopped) return;
    timeout = setTimeout(touchClaim, touchMs);
  };

  const touchLanded = () => {
    failingSince = null;
    scheduleNextTouch();
  };

  // Touches failing for a whole stale window leave the file reading as
  // walked away from, so another taker may hold the claim now. That cannot
  // be made safe after the fact — only reported, once the holder stops.
  const touchFailed = () => {
    failingSince ??= Date.now();
    if (Date.now() - failingSince >= staleMs) wentUnfreshed = true;
    scheduleNextTouch();
  };

  function touchClaim() {
    // A timer can fire in the very moment of the stop; a touch that went
    // ahead then could re-create the claim file after release removed it.
    if (stopped) return;
    latestTouch = writeClaimTime(path, owner).then(touchLanded, touchFailed);
  }

  return async (): Promise<void> => {
    stopped = true;
    clearTimeout(timeout);
    // A touch already under way finishes without booking another, because
    // both writing and scheduling check the flag above.
    await latestTouch;
    if (
      wentUnfreshed ||
      (failingSince !== null && Date.now() - failingSince >= staleMs)
    ) {
      throw new Error(
        `The claim at ${path} could not be kept fresh: its file went unwritten for longer than ${staleMs}ms, so another taker may have removed it and done the same work.`,
      );
    }
  };
};

const createClaim = async (path: string, owner: string): Promise<void> => {
  const file = await Deno.open(path, { createNew: true, write: true });
  file.close();
  await writeClaimTime(path, owner);
};

const heldClaim = (
  path: string,
  owner: string,
  settings: StaleClaimSettings,
): HeldClaim => {
  const stopTouching = startClaimTouching(path, owner, settings);
  return {
    owner,
    release: async () => {
      try {
        await stopTouching();
      } finally {
        await removeClaimIfOwned(path, owner);
      }
    },
  };
};

/**
 * Take the claim at `path` if it is free or walked away from, and start
 * keeping it fresh. `null` means somebody else's claim is still fresh.
 */
const tryTakeClaim = (
  path: string,
  settings: StaleClaimSettings,
): Promise<HeldClaim | null> =>
  withFileLock(claimGuardPath(path), async () => {
    const owner = crypto.randomUUID();
    try {
      await createClaim(path, owner);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      if (await claimIsFresh(path, settings.staleMs)) return null;
      await removeClaim(path);
      await createClaim(path, owner);
    }
    return heldClaim(path, owner, settings);
  });

/**
 * Keep somebody else's claim at `path` fresh on their behalf, starting with a
 * touch right now, until the returned stop is called. For a helper working
 * under a claim its parent took — the mutation child inside its snapshot —
 * so the claim outlives a parent that was killed without cleaning up.
 * Stopping never removes the claim: that stays the owner's to release.
 */
export const keepClaimFresh = async (
  path: string,
  settings: StaleClaimSettings,
): Promise<StopTouching> => {
  const { owner } = await readClaimRecord(path);
  if (owner === undefined) {
    throw new Error(
      `The claim at ${path} names no owner to keep it fresh for.`,
    );
  }
  await writeClaimTime(path, owner);
  return startClaimTouching(path, owner, settings);
};

/**
 * Take the claim at `path`, waiting out a fresh holder until `timeoutMs` runs
 * out. Whoever holds it keeps touching it, so a wait that ends without the
 * claim means a live holder, not an abandoned one.
 */
const takeClaim = async (
  path: string,
  settings: StaleClaimSettings & ClaimWait,
): Promise<HeldClaim> => {
  const startedAt = Date.now();
  while (true) {
    const claim = await tryTakeClaim(path, settings);
    if (claim) return claim;

    if (Date.now() - startedAt >= settings.timeoutMs) {
      throw new Error(`Timed out waiting for ${settings.name}`);
    }
    await delay(settings.retryMs);
  }
};

/** Take the claim, do the work, and let the claim go — even on failure. */
export const withClaim = async <Result>(
  path: string,
  settings: StaleClaimSettings & ClaimWait,
  body: LockBody<Result>,
): Promise<Result> => {
  const claim = await takeClaim(path, settings);
  try {
    return await body();
  } finally {
    await claim.release();
  }
};
