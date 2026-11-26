/**
 * Delete one branch's preview site: its payment webhooks, the script, its
 * pull zone, and the database. A resource that is already gone counts as done,
 * so a rerun after a failed delete finishes the work. The database goes last,
 * because it is the only resource a rerun cannot rebuild.
 */

import type { PreviewApi } from "#scripts/preview/bunny-api.ts";
import type { PreviewNames } from "#scripts/preview/names.ts";
import { inSequence } from "#scripts/preview/steps.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { siteFetchHosts } from "#shared/site-address.ts";

/** Delete what a lookup found. An empty answer means that nothing was there,
 * and that is a success. */
const whenFound = async <Item>(
  lookup: Promise<Result<Item | null>>,
  remove: (item: Item) => Promise<Result<string[]>>,
): Promise<Result<string[]>> => {
  const found = await lookup;
  if (!found.ok) return found;
  return found.value === null ? okResult([]) : remove(found.value);
};

/** What a delete reports when it worked, or its failure. */
const deleted = (what: string, result: Result<void>): Result<string[]> =>
  result.ok ? okResult([what]) : result;

/** Delete the webhooks that a payment provider holds for the hosts of a
 * site. The answer names what was deleted. */
export type RemoveWebhooks = (
  hosts: readonly string[],
) => Promise<Result<string[]>>;

/** Delete the webhooks, then the script, then its pull zone. The webhooks
 * go first, because the script is the only place that names the hosts of the
 * site. A pull zone that outlives its script has no name to find it by, so a
 * failure names the zone. */
const removeScript = (
  api: PreviewApi,
  scriptName: string,
  removeWebhooks: RemoveWebhooks,
): Promise<Result<string[]>> =>
  whenFound(api.scriptNamedOrNull(scriptName), async (script) => {
    const details = await api.getScript(script.id);
    if (!details.ok) return details;
    const { defaultHostname, pullZoneId } = details.value;
    const webhooks = await removeWebhooks(siteFetchHosts(defaultHostname));
    if (!webhooks.ok) return webhooks;
    const gone = deleted(
      `script ${script.id}`,
      await api.deleteScript(script.id),
    );
    if (!gone.ok) return gone;
    const zone = deleted(
      `pull zone ${pullZoneId}`,
      await api.deletePullZone(pullZoneId),
    );
    return zone.ok
      ? okResult([...webhooks.value, ...gone.value, ...zone.value])
      : errorResult(
          `${zone.error} Pull zone ${pullZoneId} must be deleted by hand.`,
        );
  });

const removeDatabase = (
  api: PreviewApi,
  databaseName: string,
): Promise<Result<string[]>> =>
  whenFound(api.databaseNamedOrNull(databaseName), async (database) =>
    deleted(`database ${database.id}`, await api.deleteDatabase(database.id)),
  );

/** The names of the resources this run deleted. An empty list means that
 * nothing was left to delete. */
export const removePreview = (
  api: PreviewApi,
  names: PreviewNames,
  removeWebhooks: RemoveWebhooks,
): Promise<Result<string[]>> =>
  inSequence([
    () => removeScript(api, names.scriptName, removeWebhooks),
    () => removeDatabase(api, names.databaseName),
  ]);
