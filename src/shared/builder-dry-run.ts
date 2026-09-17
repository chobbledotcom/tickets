/**
 * Test-only dry run for the external calls a site build makes.
 *
 * With `SITE_BUILD_DRY_RUN` set, every site-build provider call answers from
 * a canned body: no network leaves the machine, the subrequest budget still
 * pays for the call with the label a real call would carry, and the canned
 * body flows through the same response parsers as a live provider answer.
 * A URL outside the mapped surface, or the flag off, performs the real call —
 * so a dry-run environment with no provider credentials fails loudly the
 * first time an unmapped call appears.
 */

import { getEnv } from "#shared/env.ts";
import { type FetchResult, fetchText } from "#shared/fetch.ts";
import { countExternalSubrequest } from "#shared/subrequest-budget.ts";

/** True when the site-build surface answers without network. */
export const siteBuildDryRunEnabled = (): boolean =>
  getEnv("SITE_BUILD_DRY_RUN") === "true";

/** Each canned build draws the next number, so no two dry-run sites share an
 * id, a hostname, or a database URL. */
const nextDryRunId = (() => {
  let issued = 0;
  return (): number => (issued += 1);
})();

/** A canned 200 for one endpoint's body text. */
const cannedResponse = (text: string): FetchResult => ({
  headers: new Headers(),
  ok: true,
  status: 200,
  text,
});

const okBody = (): string => "{}";

const BUNNY_DB_REGIONS = /^https:\/\/api\.bunny\.net\/database\/v1\/config$/;
const BUNNY_DB_CREATE = /^https:\/\/api\.bunny\.net\/database\/v2\/databases$/;
const BUNNY_DB_GET = /^https:\/\/api\.bunny\.net\/database\/v2\/databases\/.+$/;
const DB_GET_URL_PREFIX = "https://api.bunny.net/database/v2/databases/";
const BUNNY_DB_TOKEN =
  /^https:\/\/api\.bunny\.net\/database\/v2\/databases\/.+\/auth\/generate$/;
const BUNNY_SCRIPT_CREATE = /\/compute\/script$/;
const BUNNY_SCRIPT_ACTION = /\/compute\/script\/.+\/(code|publish|secrets)$/;
const BUNNY_PULL_ZONE = /\/pullzone\/\d+/;
/** The canned release's asset, so the build's bundle download dry-runs too. */
const DRY_RUN_RELEASE_ASSET = /^https:\/\/dry-run\.invalid\/bunny-script\.ts$/;

/** One mapped endpoint's canned body builder. */
type CannedBody = (url: string) => string;

/** The canned answers for the site-build surface, tried in order. */
const CANNED_BODIES: readonly (readonly [RegExp, CannedBody])[] = [
  [BUNNY_DB_TOKEN, () => JSON.stringify({ token: "dry-run-db-token" })],
  [
    BUNNY_DB_REGIONS,
    () =>
      JSON.stringify({
        primary_regions: [{ id: "eu-west-1" as const }],
        replica_regions: [{ id: "eu-west-1" as const }],
      }),
  ],
  [BUNNY_DB_CREATE, () => JSON.stringify({ db_id: String(nextDryRunId()) })],
  [
    BUNNY_DB_GET,
    (url) => {
      // The pattern matched, so the prefix is present and the tail is the id.
      const dbId = url.slice(DB_GET_URL_PREFIX.length);
      return JSON.stringify({
        db: {
          db_id: dbId,
          name: "Dry run",
          url: `libsql://dry-run-${dbId}.invalid`,
        },
      });
    },
  ],
  [
    BUNNY_SCRIPT_CREATE,
    () => {
      const id = nextDryRunId();
      return JSON.stringify({
        DefaultHostname: `dry-run-${id}.invalid`,
        Id: id,
        LinkedPullZones: [{ Id: id }],
      });
    },
  ],
  [BUNNY_SCRIPT_ACTION, okBody],
  [BUNNY_PULL_ZONE, okBody],
  [DRY_RUN_RELEASE_ASSET, () => "export {}; // dry-run site build"],
];

/** One site-build call: with the flag on and the URL mapped, the budget pays
 * for the call and the canned body answers; otherwise the real fetch runs
 * and `init` supplies its request exactly as before. */
export const dryRunOrFetchText = (
  url: string,
  init: () => RequestInit,
): Promise<FetchResult> => {
  if (!siteBuildDryRunEnabled()) return fetchText(url, init());
  const mapped = CANNED_BODIES.find(([pattern]) => pattern.test(url));
  if (mapped === undefined) return fetchText(url, init());
  countExternalSubrequest(`fetch ${new URL(url).origin}`);
  return Promise.resolve(cannedResponse(mapped[1](url)));
};
