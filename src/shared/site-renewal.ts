/**
 * Renewal provisioning for built sites: deadlines, tokens, and the
 * provider pushes that carry them.
 */

/* jscpd:ignore-start */
import { siteClaimedByBuyer } from "#db/built-sites/claims.ts";
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
import {
  generateRenewalToken,
  type RenewalTokenData,
} from "#shared/renewal-token.ts";
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

/** Push a subset of site secrets to the hosting provider. Pure I/O — no DB writes. */
const pushSiteSecrets = async (
  site: BuiltSite,
  secrets: { readOnlyFrom?: string; renewalUrl?: string },
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

type RenewalStateUpdate = Parameters<typeof updateBuiltSiteRenewalState>[1];
type SiteSecrets = { readOnlyFrom?: string; renewalUrl?: string };

/**
 * Curried helper: push secrets and persist renewal state.
 * On push success, writes `onSuccess`. On failure, logs and leaves DB state
 * unchanged so an admin can retry from the unprovisioned state.
 */
const pushAndPersist =
  (site: BuiltSite, errorContext: string) =>
  async (
    secrets: SiteSecrets,
    onSuccess: RenewalStateUpdate,
  ): Promise<CdnPushResult> => {
    const pushResult = await pushSiteSecrets(site, secrets);
    if (pushResult.ok) {
      await updateBuiltSiteRenewalState(site.id, onSuccess);
    } else {
      logRenewalCdnError(errorContext, pushResult.error);
    }
    return pushResult;
  };

/** The new renewal token and whether pushing it to the site succeeded. */
type RenewalPushResult = { token: string; pushOk: boolean };

/**
 * Provision a site for renewals. The token is reserved before the push: the
 * reservation is a revision-fenced write that only lands while the row still
 * carries none, so exactly one of two concurrent attempts owns the token and
 * the other adopts it — both then push the same value. The confirm that
 * follows persists only the cutoff, and only while the row sits at the
 * revision it was read at: a token rotation landing mid-provision fails the
 * confirm, and the loop re-reads and re-pushes the rotated token, so the
 * hosting provider and the database can never end up holding different
 * tokens. On push failure the reservation stands and the cutoff stays empty,
 * so a retry re-pushes the reserved token instead of minting a second one.
 */
export const provisionSiteRenewal = async (
  site: BuiltSite,
  months: number,
  errorContext: string,
): Promise<RenewalPushResult & { cutoff: string }> => {
  await reserveRenewalToken(site);
  const cutoff = addMonthsIso(nowIso(), months);

  for (const _attempt of range(0, 2)) {
    const current = await findBuiltSiteByIdPrimary(site.id);
    // The reservation just wrote the pair, so the row and its token exist.
    const token = current!.renewalToken!;
    const pushResult = await pushSiteSecrets(current!, {
      readOnlyFrom: cutoff,
      renewalUrl: renewalUrlFor(token),
    });
    if (!pushResult.ok) {
      logRenewalCdnError(errorContext, pushResult.error);
      return { cutoff, pushOk: false, token };
    }
    const confirmed = await updateBuiltSiteIfUnchanged(
      site.id,
      current!.siteDataRevision,
      { readOnlyFrom: cutoff },
    );
    if (confirmed) return { cutoff, pushOk: true, token };
    // A rotation won the row mid-provision; loop again and push its token.
  }
  // Rotations kept landing; the cutoff stays empty and a retry resumes.
  logRenewalCdnError(errorContext, "the token kept rotating during provision");
  return { cutoff, pushOk: false, token: "" };
};

/** The token this site's renewals run on, reserved if none is yet. The
 * index is the pair's presence signal — token and index are always written
 * together, and only the index can resolve a renewal link. A row without
 * one gets a fresh pair written only while it still has none, so a
 * concurrent attempt that loses the write reads the winner's pair back. */
const reserveRenewalToken = async (
  site: BuiltSite,
): Promise<RenewalTokenData> => {
  if (site.renewalTokenIndex) {
    return { index: site.renewalTokenIndex, token: site.renewalToken! };
  }
  const candidate = await generateRenewalToken();
  const reserved = await updateBuiltSite(site.id, (existing) =>
    existing.renewalTokenIndex
      ? null
      : { renewalToken: candidate.token, renewalTokenIndex: candidate.index },
  );
  // The transaction just claimed this row, so the read back cannot miss it.
  return {
    index: reserved!.renewalTokenIndex!,
    token: reserved!.renewalToken!,
  };
};

/**
 * Rotate a site's renewal token. Pushes the new RENEWAL_URL only — the
 * READ_ONLY_FROM cutoff is independent of token identity and is not
 * re-pushed here. Persists the new token on push success.
 */
export const rotateRenewalToken = async (
  site: BuiltSite,
  errorContext: string,
): Promise<RenewalPushResult> => {
  const tokenData = await generateRenewalToken();
  const pushResult = await pushAndPersist(site, errorContext)(
    { renewalUrl: renewalUrlFor(tokenData.token) },
    { renewalToken: tokenData.token, renewalTokenIndex: tokenData.index },
  );
  return { pushOk: pushResult.ok, token: tokenData.token };
};

export const completeUnfinishedRenewal = async (
  attendeeId: number,
  listingIds: readonly number[],
  months: number,
): Promise<void> => {
  const claimed = await siteClaimedByBuyer(attendeeId, listingIds);
  // A set read-only cutoff marks a completed provisioning; without it the
  // push never confirmed, so the recovery re-pushes the reserved token.
  if (claimed !== null && !claimed.readOnlyFrom) {
    await provisionSiteRenewal(
      claimed,
      months,
      `Failed to push renewal secrets for site ${claimed.id}`,
    );
  }
};
