/**
 * Renewal provisioning for built sites: deadlines, tokens, and the
 * provider pushes that carry them.
 */

/* jscpd:ignore-start */
import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  findBuiltSiteByIdPrimary,
  updateBuiltSite,
  updateBuiltSiteIfUnchanged,
  updateBuiltSiteRenewalState,
} from "#db/built-sites.ts";
import { range } from "#fp";
import { getEffectiveDomain } from "#shared/config.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso, nowMs, parseDateMs } from "#shared/now.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { generateRenewalToken } from "#shared/renewal-token.ts";
import { resolveHostingProvider } from "#shared/site-hosting.ts";

/* jscpd:ignore-end */

export type CdnPushResult = { ok: true } | { ok: false; error: string };

/** Parse a site's stored read-only deadline as milliseconds, or null when empty/invalid. */
export const parseReadOnlyFromMs = (
  site: Pick<BuiltSite, "readOnlyFrom">,
): number | null => (site.readOnlyFrom ? parseDateMs(site.readOnlyFrom) : null);

/** Stack-forward base: max(now, existing deadline). Falls back to now when missing. */
export const renewalDeadlineBaseMs = (
  site: Pick<BuiltSite, "readOnlyFrom">,
): number => Math.max(nowMs(), parseReadOnlyFromMs(site) ?? 0);

export const addMonthsToRenewalDeadline = (
  site: Pick<BuiltSite, "readOnlyFrom">,
  months: number,
): string =>
  addMonthsIso(new Date(renewalDeadlineBaseMs(site)).toISOString(), months);

/** Build the renewal URL for a given token. */
export const renewalUrlFor = (token: string): string =>
  `https://${getEffectiveDomain()}/renew/?t=${encodeURIComponent(token)}`;

const logRenewalCdnError = (errorContext: string, error: string): void => {
  logError({
    code: ErrorCode.CDN_REQUEST,
    detail: `${errorContext}: ${error}`,
  });
  sendNtfyError("CDN_REQUEST");
};

/** The site secrets a renewal push may carry. */
type RenewalSecrets = { readOnlyFrom?: string; renewalUrl?: string };

/** Push a subset of site secrets to the hosting provider. Pure I/O — no DB writes. */
const pushSiteSecrets = async (
  site: BuiltSite,
  secrets: RenewalSecrets,
): Promise<CdnPushResult> => {
  if (!site.hostingId) return { error: "No hostingId", ok: false };
  const pairs: [string, string][] = [];
  if (secrets.renewalUrl !== undefined) {
    pairs.push(["RENEWAL_URL", secrets.renewalUrl]);
  }
  if (secrets.readOnlyFrom !== undefined) {
    pairs.push(["READ_ONLY_FROM", secrets.readOnlyFrom]);
  }
  return resolveHostingProvider(site.hostingProvider).setSecrets(
    site.hostingId,
    pairs,
  );
};

/**
 * Push READ_ONLY_FROM (and optionally re-push RENEWAL_URL) to the edge script
 * and persist the cutoff on success. Single DB write per call.
 */
export const syncReadOnlyFrom = async (
  site: BuiltSite,
  cutoffIso: string,
  renewalUrl?: string,
): Promise<CdnPushResult> => {
  const pushResult = await pushSiteSecrets(site, {
    readOnlyFrom: cutoffIso,
    ...(renewalUrl !== undefined ? { renewalUrl } : {}),
  });
  if (pushResult.ok) {
    await updateBuiltSiteRenewalState(site.id, { readOnlyFrom: cutoffIso });
  }
  return pushResult;
};

/** Push the given secrets. A failed push is logged. Returns whether the push
 * landed. */
const pushOrLogFailure = async (
  site: BuiltSite,
  secrets: RenewalSecrets,
  errorContext: string,
): Promise<boolean> => {
  const pushResult = await pushSiteSecrets(site, secrets);
  if (!pushResult.ok) logRenewalCdnError(errorContext, pushResult.error);
  return pushResult.ok;
};

/** Reserve a token for this site's renewals if it holds none yet. The index
 * is the pair's presence signal — token and index are always written
 * together, and only the index can resolve a renewal link. A row without
 * one gets a fresh pair written only while it still has none, so a
 * concurrent attempt that loses the write keeps the winner's pair. */
const reserveRenewalToken = async (site: BuiltSite): Promise<void> => {
  if (site.renewalTokenIndex) return;
  const candidate = await generateRenewalToken();
  await updateBuiltSite(site.id, (existing) =>
    existing.renewalTokenIndex
      ? null
      : { renewalToken: candidate.token, renewalTokenIndex: candidate.index },
  );
};

/**
 * Provision a site for renewals, and return whether the push landed. The
 * token is reserved first by a revision-fenced write, so of two concurrent
 * attempts one owns the token and the other pushes the same value. The
 * confirm stores the cutoff only while the row keeps the revision it was
 * read at. A rotation mid-provision fails the confirm, and the loop pushes
 * the rotated token, so the provider and the database hold one token. After
 * a failed push the reservation stands with no cutoff, so a retry re-pushes
 * the reserved token.
 */
export const provisionSiteRenewal = async (
  site: BuiltSite,
  months: number,
  errorContext: string,
): Promise<boolean> => {
  await reserveRenewalToken(site);
  const cutoff = addMonthsIso(nowIso(), months);
  for (const _attempt of range(0, 2)) {
    const current = await findBuiltSiteByIdPrimary(site.id);
    // The reservation just wrote the pair, so the row and its token exist.
    const pushed = await pushOrLogFailure(
      current!,
      {
        readOnlyFrom: cutoff,
        renewalUrl: renewalUrlFor(current!.renewalToken!),
      },
      errorContext,
    );
    if (!pushed) return false;
    const confirmed = await updateBuiltSiteIfUnchanged(
      site.id,
      current!.siteDataRevision,
      { readOnlyFrom: cutoff },
    );
    if (confirmed) return true;
    // A rotation won the row mid-provision; loop again and push its token.
  }
  // Rotations kept landing; the cutoff stays unset and a retry resumes.
  logRenewalCdnError(errorContext, "the token kept rotating during provision");
  return false;
};

/** Rotations serialize here: each reads the freshest token, pushes, and
 * persists before the next begins, so two concurrent rotations cannot land
 * out-of-order responses that leave the hosting provider and the database
 * holding different tokens. (Cross-isolate callers keep the whole-row
 * revision fence, which retries over a concurrent write rather than clobbering
 * its blob.) */
const rotationTail: { current: Promise<unknown> } = {
  current: Promise.resolve(),
};
const serializeRotation = <T>(run: () => Promise<T>): Promise<T> => {
  const result = (async () => {
    try {
      await rotationTail.current;
    } catch {
      // A failed rotation must not stop the queue behind it.
    }
    return run();
  })();
  rotationTail.current = result;
  return result;
};

/**
 * Rotate a site's renewal token. Pushes the new RENEWAL_URL only — the
 * READ_ONLY_FROM cutoff is independent of token identity and is not
 * re-pushed here. Persists the new token on push success, and returns
 * whether the push landed.
 */
export const rotateRenewalToken = (
  site: BuiltSite,
  errorContext: string,
): Promise<boolean> =>
  serializeRotation(async () => {
    const tokenData = await generateRenewalToken();
    const pushed = await pushOrLogFailure(
      site,
      { renewalUrl: renewalUrlFor(tokenData.token) },
      errorContext,
    );
    if (!pushed) return false;
    await updateBuiltSiteRenewalState(site.id, {
      renewalToken: tokenData.token,
      renewalTokenIndex: tokenData.index,
    });
    return true;
  });

export const completeUnfinishedRenewal = async (
  site: BuiltSite,
  months: number,
): Promise<void> => {
  // An empty read-only cutoff marks a provisioning whose push never
  // confirmed, so the recovery re-pushes the reserved token with the term
  // the buyer's plan states today.
  if (!site.readOnlyFrom) {
    await provisionSiteRenewal(
      site,
      months,
      `Failed to push renewal secrets for site ${site.id}`,
    );
  }
};
