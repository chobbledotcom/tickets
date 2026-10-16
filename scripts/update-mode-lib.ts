/**
 * The update-mode CLI the deploy workflows call around every site code
 * update:
 *
 *   begin <script-id> <site-url>  set UPDATE_IN_PROGRESS, then check the
 *                                 site at 10, 30, and 60 seconds until it
 *                                 serves its update page
 *   end <script-id> <site-url>    wait until the new build serves, then
 *                                 remove UPDATE_IN_PROGRESS
 *
 * `begin` runs before the code upload, `end` after it. The checks are
 * single hits, and the gaps between them stay quiet: the gap lets the old
 * app stop serving and the flag set, where immediate repeated checking
 * kept the old app online and raced the propagation. A begin run-out
 * removes UPDATE_IN_PROGRESS again, so the site accepts writes, and the
 * error says to re-run the deploy. Any other failure leaves
 * UPDATE_IN_PROGRESS set: a site stuck read-only is safer than a
 * half-migrated one, and a re-run of the same update lifts the flag on
 * success. The operator can also remove the variable by hand in the Bunny
 * dashboard (script -> Env Configuration -> Environment Secrets).
 *
 * `end` takes the release tag of the build the deploy just published and
 * waits until the served page names that build before it lifts the flag, so
 * an active page the old build still answers cannot lift it. The release
 * tag matches the build tag build-edge.ts bakes into the bundle.
 */

import { BUNNY_API_BASE, formatBunnyError } from "#scripts/deploy-edge-lib.ts";
import type { FetchText, FetchTextResult } from "#scripts/fetch-text.ts";
import { siteBaseUrl } from "#shared/site-address.ts";
import {
  fetchBoundedUpdatePage,
  UPDATE_FLAG_VALUE,
  UPDATE_IN_PROGRESS_VAR,
  type UpdateIoOptions,
  type UpdatePollIo,
  waitForBeginPropagation,
  waitForUpdatePage,
  waitOptionsFrom,
} from "#shared/update-guard.ts";

export const USAGE =
  "Usage: deno run scripts/update-mode.ts begin <script-id> <site-url>\n" +
  "       deno run scripts/update-mode.ts end <script-id> <site-url> <build-tag>";

export interface UpdateModeIo extends UpdateIoOptions {
  accessKey: string;
  fetchText: FetchText;
  log: (line: string) => void;
}

/** One resolved command: the base io plus the script and site it targets,
 * with the page fetch the wait polls. */
type ScopedIo = UpdateModeIo &
  UpdatePollIo & { scriptId: string; siteUrl: string };

/** The edge script's secrets endpoint, which every flag call shares. */
const secretsEndpoint = (io: ScopedIo): string =>
  `/compute/script/${encodeURIComponent(io.scriptId)}/secrets`;

/** One Bunny API call shape reused by the upsert, list, and delete below. */
const secretRequest = async (
  io: ScopedIo,
  path: string,
  method: string,
  body?: string,
): Promise<FetchTextResult> =>
  io.fetchText(`${BUNNY_API_BASE}${path}`, {
    ...(body === undefined ? {} : { body }),
    headers: {
      AccessKey: io.accessKey,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    method,
  });

/** Upsert the update flag. An empty value lifts update mode only on hosts
 * with no secret delete; this CLI deletes properly in `end`. */
const upsertUpdateSecret = async (
  io: ScopedIo,
  value: string,
): Promise<void> => {
  const response = await secretRequest(
    io,
    secretsEndpoint(io),
    "PUT",
    JSON.stringify({ Name: UPDATE_IN_PROGRESS_VAR, Secret: value }),
  );
  if (!response.ok) {
    throw new Error(formatBunnyError("Set UPDATE_IN_PROGRESS", response));
  }
};

/** The secret's numeric id, or null while the script holds no update flag. */
const findUpdateSecretId = async (io: ScopedIo): Promise<number | null> => {
  const response = await secretRequest(io, secretsEndpoint(io), "GET");
  if (!response.ok) {
    throw new Error(formatBunnyError("List edge script secrets", response));
  }
  const secrets = JSON.parse(response.text) as {
    Secrets: { Id: number; Name: string }[] | null;
  };
  const match = (secrets.Secrets ?? []).find(
    (secret) => secret.Name === UPDATE_IN_PROGRESS_VAR,
  );
  return match?.Id ?? null;
};

const deleteUpdateSecret = async (
  io: ScopedIo,
  secretId: number,
): Promise<void> => {
  const response = await secretRequest(
    io,
    `${secretsEndpoint(io)}/${secretId}`,
    "DELETE",
  );
  if (!response.ok) {
    throw new Error(formatBunnyError("Delete UPDATE_IN_PROGRESS", response));
  }
};

/** Remove the update flag: find it by name, then delete it. A script that
 * holds no flag is already lifted (a re-run after a manual clear, for
 * example). */
const liftUpdateFlag = async (io: ScopedIo): Promise<void> => {
  const secretId = await findUpdateSecretId(io);
  if (secretId !== null) await deleteUpdateSecret(io, secretId);
};

/** Fetch the site's read-only page. A non-200 answer throws so the wait
 * ends instead of reading a broken page as "unsupported". */
const fetchReadOnlyPage = async (site: {
  fetchText: FetchText;
  siteUrl: string;
}): Promise<string> => {
  const url = `${siteBaseUrl(site.siteUrl)}/read-only`;
  const response = await fetchBoundedUpdatePage(site.fetchText, url);
  if (!response.ok) {
    throw new Error(
      `The update page check failed (HTTP ${response.status}) for ${url}.`,
    );
  }
  return response.text;
};

export const runUpdateMode = async (
  args: string[],
  io: UpdateModeIo,
): Promise<number> => {
  const [command, scriptId, siteUrl, buildTag] = args;
  if (
    (command !== "begin" && command !== "end") ||
    scriptId === undefined ||
    siteUrl === undefined ||
    (command === "end" && buildTag === undefined)
  ) {
    io.log(USAGE);
    return 1;
  }
  // The deploy workflows pass the site URL from a JSON payload. A site
  // whose URL is missing arrives as the string "null" (jq's rendering of a
  // JSON null) or an empty argument. Either must fail here, before the
  // flag write, not become a https://null page request.
  if (siteUrl.trim() === "" || siteUrl.trim() === "null") {
    io.log(
      `The deploy passed no site URL for script ${scriptId}, so the update-mode wait has no page to check. Give the deploy the site's URL and re-run it.`,
    );
    return 1;
  }
  const scopedIo: ScopedIo = {
    ...io,
    fetchPage: () => fetchReadOnlyPage({ fetchText: io.fetchText, siteUrl }),
    scriptId,
    siteUrl,
  };

  if (command === "begin") {
    io.log(`Setting ${UPDATE_IN_PROGRESS_VAR} on script ${scriptId}..`);
    await upsertUpdateSecret(scopedIo, UPDATE_FLAG_VALUE);
    // The schedule checks at 10, 30, and 60 seconds and stays quiet
    // between them. A run-out reverts the flag, so the site accepts
    // writes again.
    await waitForBeginPropagation(waitOptionsFrom(scopedIo, true), () =>
      liftUpdateFlag(scopedIo),
    );
    return 0;
  }

  // Only the build this deploy published may answer: an active page the old
  // build still serves must not lift the flag before the new build serves.
  await waitForUpdatePage(waitOptionsFrom(scopedIo, false, buildTag));
  io.log(`Removing ${UPDATE_IN_PROGRESS_VAR} from script ${scriptId}..`);
  await liftUpdateFlag(scopedIo);
  return 0;
};
