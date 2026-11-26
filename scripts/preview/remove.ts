/**
 * Delete one branch's preview site: the script, its pull zone, and the
 * database. A resource that is already gone counts as done, so a rerun after
 * a failed delete finishes the work. The database goes last, because it is the
 * only resource a rerun cannot rebuild.
 */

import type { PreviewApi } from "#scripts/preview/bunny-api.ts";
import type { PreviewNames } from "#scripts/preview/names.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

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

/** Delete the script, then its pull zone. A pull zone that outlives its
 * script has no name to find it by, so a failure names the zone. */
const removeScript = (
  api: PreviewApi,
  scriptName: string,
): Promise<Result<string[]>> =>
  whenFound(api.scriptNamedOrNull(scriptName), async (script) => {
    const details = await api.getScript(script.id);
    if (!details.ok) return details;
    const { pullZoneId } = details.value;
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
      ? okResult([...gone.value, ...zone.value])
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
export const removePreview = async (
  api: PreviewApi,
  names: PreviewNames,
): Promise<Result<string[]>> => {
  const script = await removeScript(api, names.scriptName);
  if (!script.ok) return script;
  const database = await removeDatabase(api, names.databaseName);
  return database.ok
    ? okResult([...script.value, ...database.value])
    : database;
};
