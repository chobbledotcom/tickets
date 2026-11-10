/**
 * The command-line walk through rotating one built site's database key: show
 * the sites, take one, make the person type its name, then rotate.
 *
 * Rotation removes every key the database's provider issued for that database,
 * so the site cannot reach its database until it receives the new key. The
 * provider needs a short downtime to finish removing the old keys, so the walk
 * waits before it asks for the new one. That makes the typed confirmation the
 * point of the walk: one wrong pick would take a live site down.
 */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { databaseHostFor } from "#db/host.ts";
import { taskWithoutArguments } from "#scripts/no-argument-task.ts";
import type { ScriptIo } from "#scripts/script-runner.ts";
import { numberedLines, readMenuChoice } from "#scripts/site-migration/menu.ts";
import {
  DATABASE_KEY_PAUSE_SECONDS,
  databaseKeyRotationAccess,
} from "#shared/database-key-rotation.ts";
import { errorMessage } from "#shared/error-message.ts";
import type { Outcome, Result } from "#shared/result.ts";

const ROTATE_DATABASE_KEY_USAGE = "Usage: deno task rotate:db-key";

/** Everything the walk needs from the outside world, so a test can stand in. */
export interface RotateDatabaseKeyCliDeps extends ScriptIo {
  completeRotation: (site: BuiltSite, started: number) => Promise<Outcome>;
  listSites: () => Promise<BuiltSite[]>;
  prompt: (message: string) => string | null;
  startRotation: (site: BuiltSite) => Promise<Result<number>>;
  wait: (seconds: number) => Promise<void>;
}

/** Show the sites and let the person pick one, or stop. A closed prompt (the
 * person pressed Ctrl-D) stops the walk like `q` does. */
const chooseSite = (
  deps: RotateDatabaseKeyCliDeps,
  sites: BuiltSite[],
): BuiltSite | "quit" => {
  deps.stdout("\nSites:");
  const labels = sites.map(
    (site) =>
      `${site.name} — ${databaseHostFor(site.dbUrl)} database (script ${site.hostingId})`,
  );
  for (const line of numberedLines(labels)) deps.stdout(line);
  const answer = deps.prompt(
    "Choose a site to rotate the database key of (q to quit):",
  );
  if (answer === null) return "quit";
  const choice = readMenuChoice(answer, sites);
  return choice === "quit" ? "quit" : choice.chosen;
};

/** Make the person type the site name before anything is changed. */
const confirmSite = (deps: RotateDatabaseKeyCliDeps, site: BuiltSite): void => {
  deps.stdout(
    "The site cannot reach its database for about a minute, until it receives the new key. Run this when the site is quiet.",
  );
  const typed = deps.prompt(`Type the site name to confirm (${site.name}):`);
  if (typed === null) throw new Error("Cancelled.");
  if (!typed.trim()) throw new Error("Site name is required.");
  if (typed.trim() !== site.name) {
    throw new Error(
      "Site name does not match. Please type the exact name to confirm.",
    );
  }
};

/** One round: pick a site, confirm it, remove the old key, wait, then make and
 * send the new one. */
const rotateOneRound = async (
  deps: RotateDatabaseKeyCliDeps,
): Promise<number> => {
  const sites = await deps.listSites();
  if (sites.length === 0) throw new Error("No built sites recorded.");
  const site = chooseSite(deps, sites);
  if (site === "quit") return 0;
  const access = databaseKeyRotationAccess(site);
  // Refuse before the warning, so nobody confirms work this host cannot finish.
  if (!access.ok) throw new Error(access.error);
  confirmSite(deps, site);
  const started = await deps.startRotation(site);
  if (!started.ok) throw new Error(started.error);
  deps.stdout(
    `Waiting ${DATABASE_KEY_PAUSE_SECONDS} seconds for the database to remove every old key.`,
  );
  await deps.wait(DATABASE_KEY_PAUSE_SECONDS);
  const completed = await deps.completeRotation(site, started.value);
  if (!completed.ok) throw new Error(completed.error);
  deps.stdout(`${site.name} now uses a new database key.`);
  return 0;
};

const guardedTask = taskWithoutArguments<RotateDatabaseKeyCliDeps>(
  (deps, error) => {
    deps.stderr(errorMessage(error));
    return 1;
  },
);

/** Rotate one site's database key, and answer the shell's exit code. */
export const runRotateDatabaseKeyCli = (
  deps: RotateDatabaseKeyCliDeps,
): Promise<number> =>
  guardedTask(deps, ROTATE_DATABASE_KEY_USAGE, () => rotateOneRound(deps));
