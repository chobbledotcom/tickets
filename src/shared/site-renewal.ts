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

/** The new renewal token and whether pushing it to the site succeeded. */
type RenewalPushResult = { token: string; pushOk: boolean };

/** A reserved-term push outcome: the stamped term it carried. */
type ReservedRenewalPush = RenewalPushResult & { cutoff: string };

/** Push the given secrets and fold a failure into a logged failed push
 * result naming `token`. Returns undefined when the push landed. */
const pushOrLogFailure = async (
  site: BuiltSite,
  secrets: RenewalSecrets,
  errorContext: string,
  token: string,
): Promise<RenewalPushResult | undefined> => {
  const pushResult = await pushSiteSecrets(site, secrets);
  if (!pushResult.ok) {
    logRenewalCdnError(errorContext, pushResult.error);
    return { pushOk: false, token };
  }
  return;
};

/** Reserve the site's renewal token pair and its intended cutoff in one
 * revision-fenced write. A row that already carries a token adopts it — and
 * its stamped cutoff — instead of minting a second one; a row without a token
 * gets the pair plus the cutoff the caller's months state (an admin
 * provisioning an unclaimed site), unless a claim stamped a term already. */
const reserveRenewalTerm = async (
  site: BuiltSite,
  months: number,
): Promise<RenewalTokenData> => {
  if (site.renewalTokenIndex) {
    return { index: site.renewalTokenIndex, token: site.renewalToken! };
  }
  const candidate = await generateRenewalToken();
  const reserved = await updateBuiltSite(site.id, (existing) =>
    existing.renewalTokenIndex
      ? existing.pendingRenewalCutoff || existing.renewalUrlConfirmed
        ? // Another provision owns the token and its term; adopt both.
          null
        : // A rotation persisted a token nobody confirmed: stamp this
          // provision's term on it.
          { pendingRenewalCutoff: addMonthsIso(nowIso(), months) }
      : {
          pendingRenewalCutoff:
            existing.pendingRenewalCutoff || addMonthsIso(nowIso(), months),
          renewalToken: candidate.token,
          renewalTokenIndex: candidate.index,
        },
  );
  // The transaction just claimed this row, so the read back cannot miss it.
  return {
    index: reserved!.renewalTokenIndex!,
    token: reserved!.renewalToken!,
  };
};

/** Push the stamped cutoff and the current token's renewal URL, and confirm
 * the pair in one revision-fenced write. A stamped cutoff is work to do even
 * on a confirmed site — a claim stamped it after that confirmation — so the
 * push supersedes it. On push failure the reservation stands, so a retry
 * re-pushes the same term instead of minting a second token. */
const pushReservedRenewal = async (
  site: BuiltSite,
  errorContext: string,
): Promise<ReservedRenewalPush> => {
  for (const _attempt of range(0, 2)) {
    const current = await findBuiltSiteByIdPrimary(site.id);
    // The reservation wrote the pair, so the row and its token exist.
    const token = current!.renewalToken!;
    const cutoff = current!.pendingRenewalCutoff;
    if (cutoff === "") {
      // Settled: a confirmed provisioning with nothing stamped awaits.
      if (current!.renewalUrlConfirmed) {
        return { cutoff: current!.readOnlyFrom, pushOk: true, token };
      }
      throw new Error(`No renewal cutoff stamped for site ${site.id}`);
    }
    const failed = await pushOrLogFailure(
      current!,
      { readOnlyFrom: cutoff, renewalUrl: renewalUrlFor(token) },
      errorContext,
      token,
    );
    if (failed) return { cutoff, ...failed };
    const confirmed = await updateBuiltSiteIfUnchanged(
      site.id,
      current!.siteDataRevision,
      {
        pendingRenewalCutoff: "",
        readOnlyFrom: cutoff,
        renewalUrlConfirmed: true,
      },
    );
    if (confirmed) return { cutoff, pushOk: true, token };
    // A rotation won the row mid-provision; loop again and push its token.
  }
  // Rotations kept landing; the cutoff stays stamped and a retry resumes.
  logRenewalCdnError(errorContext, "the token kept rotating during provision");
  return { cutoff: "", pushOk: false, token: "" };
};

/**
 * Provision a site for renewals. The token is reserved before the push: the
 * reservation is a revision-fenced write that only lands while the row still
 * carries none, so exactly one of two concurrent attempts owns the token and
 * the other adopts it — both then push the same value. The cutoff comes from
 * the stamped term (a claim stamps the buyer's paid months); the caller's
 * months only matter when nothing is stamped yet. On push failure the
 * reservation stands and the cutoff stays stamped, so a retry re-pushes the
 * reserved token and term instead of minting a second one.
 */
export const provisionSiteRenewal = async (
  site: BuiltSite,
  months: number,
  errorContext: string,
): Promise<ReservedRenewalPush> => {
  await reserveRenewalTerm(site, months);
  return pushReservedRenewal(site, errorContext);
};

/** Rotations serialize here: each reads the freshest token, pushes, and
 * persists before the next begins, so two concurrent rotations cannot land
 * out-of-order responses that leave the hosting provider and the database
 * holding different tokens. (Cross-isolate callers keep the whole-row
 * revision fence, which retries over a concurrent write rather than clobbering
 * its blob.) */
let rotationTail: Promise<unknown> = Promise.resolve();
const serializeRotation = <T>(run: () => Promise<T>): Promise<T> => {
  const result = rotationTail.catch(() => undefined).then(run);
  rotationTail = result;
  return result;
};

/**
 * Rotate a site's renewal token. Pushes the new RENEWAL_URL only — the
 * READ_ONLY_FROM cutoff is independent of token identity and is not
 * re-pushed here. Persists the new token on push success.
 */
export const rotateRenewalToken = (
  site: BuiltSite,
  errorContext: string,
): Promise<RenewalPushResult> =>
  serializeRotation(async () => {
    const tokenData = await generateRenewalToken();
    const failed = await pushOrLogFailure(
      site,
      { renewalUrl: renewalUrlFor(tokenData.token) },
      errorContext,
      tokenData.token,
    );
    if (failed) return failed;
    await updateBuiltSiteRenewalState(site.id, {
      renewalToken: tokenData.token,
      renewalTokenIndex: tokenData.index,
    });
    return { pushOk: true, token: tokenData.token };
  });

export const completeUnfinishedRenewal = async (
  site: BuiltSite,
): Promise<void> => {
  // A stamped cutoff is unfinished provisioning — a claim stamped the buyer's
  // term and its push never confirmed. The recovery re-pushes exactly that
  // term; a confirmed provisioning with nothing stamped needs nothing.
  if (site.pendingRenewalCutoff !== "") {
    await pushReservedRenewal(
      site,
      `Failed to push renewal secrets for site ${site.id}`,
    );
  }
};
