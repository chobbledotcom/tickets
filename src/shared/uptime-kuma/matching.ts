import { filter, pipe } from "#fp";
import { t } from "#i18n";
import { MAINTENANCE_REQUEST_DEADLINE_MS } from "#shared/maintenance/definition.ts";
import { normalizePath } from "#shared/path.ts";
import { UPTIME_KUMA_GROUP_NAME } from "./monitor-input.ts";
import type { UptimeKumaMonitor } from "./schemas.ts";

/**
 * Pure predicates for finding a built site's scheduled monitor among the
 * monitors Kuma has pushed.
 *
 * A monitor drives a site's `/scheduled` request safely when it is the right
 * kind of check (HTTP POST to the site's scheduled URL, with the right bearer
 * token, accepting the 204 success response) and when its configuration
 * cannot make the request go stale or fail — not upside-down, no custom
 * conditions, and a timeout that gives the request time to finish.
 */

export type ScheduledMatchContext = {
  authorization: string;
  groupIds: number[];
  target: string;
};

/**
 * The checks a monitor must pass to be treated as the site's scheduled
 * monitor. Each entry carries its own predicate so adding a new rule is
 * adding one line here, not a new arm on an `if` chain.
 */
type ScheduledMonitorRule = {
  holds: (
    monitor: UptimeKumaMonitor,
    context: ScheduledMatchContext,
  ) => boolean;
};

const inSharedGroup: ScheduledMonitorRule["holds"] = (monitor, context) =>
  monitor.parent !== null && context.groupIds.includes(monitor.parent);

const targetsScheduledUrl: ScheduledMonitorRule["holds"] = (monitor, context) =>
  monitor.url !== null && scheduledTarget(monitor.url) === context.target;

const carriesAuthorization: ScheduledMonitorRule["holds"] = (
  monitor,
  context,
) => monitor.authorization === context.authorization;

const SCHEDULED_MONITOR_RULES: ScheduledMonitorRule[] = [
  { holds: (monitor) => monitor.type === "http" },
  { holds: inSharedGroup },
  { holds: (monitor) => monitor.method.toUpperCase() === "POST" },
  { holds: targetsScheduledUrl },
  { holds: (monitor) => acceptsScheduledResponse(monitor.acceptedStatusCodes) },
  { holds: (monitor) => !monitor.upsideDown },
  { holds: (monitor) => monitor.conditions.length === 0 },
  {
    holds: (monitor) =>
      monitor.timeout * 1_000 >= MAINTENANCE_REQUEST_DEADLINE_MS,
  },
  { holds: carriesAuthorization },
];

/**
 * A monitor matches the scheduled request when every rule holds. The rules
 * are data, so a new rule is one entry in the table above, and this fold is
 * the only place the decision is made.
 */
export const siteMonitorMatches = (
  monitor: UptimeKumaMonitor,
  context: ScheduledMatchContext,
): boolean =>
  SCHEDULED_MONITOR_RULES.every((rule) => rule.holds(monitor, context));

/**
 * Normalises a monitor URL to its origin plus trailing-slash-normalised
 * path, so `https://child.example.test/scheduled/` and
 * `https://child.example.test/scheduled` match.
 */
export const scheduledTarget = (value: string): string => {
  const url = new URL(value);
  return `${url.origin}${normalizePath(url.pathname)}`;
};

/**
 * Reads the 204 status code against Kuma's range notation: `"200-299"` and
 * `"204"` both accept it; `"200"` and `"205-399"` do not.
 */
export const acceptsScheduledResponse = (statusCodes: string[]): boolean =>
  statusCodes.some((range) => {
    const parts = range.split("-");
    const minimum = Number(parts[0]);
    const maximum = Number(parts[1] === undefined ? parts[0] : parts[1]);
    return minimum <= 204 && maximum >= 204;
  });

/**
 * The shared Chobble Tickets group monitors, ordered by id. Shared groups
 * are the containers for all site scheduled monitors.
 */
export const sharedGroups = (
  monitors: UptimeKumaMonitor[],
): UptimeKumaMonitor[] =>
  pipe(
    filter(
      (monitor: UptimeKumaMonitor) =>
        monitor.type === "group" && monitor.name === UPTIME_KUMA_GROUP_NAME,
    ),
  )(monitors);

export const sharedGroupIds = (monitors: UptimeKumaMonitor[]): number[] =>
  sharedGroups(monitors).map((group) => group.id);

export const lowestByIdOrNull = (
  monitors: UptimeKumaMonitor[],
): UptimeKumaMonitor | null => {
  const [first] = monitors.toSorted((left, right) => left.id - right.id);
  return first === undefined ? null : first;
};

export const firstById = (
  monitors: UptimeKumaMonitor[],
  missingMessage: string,
): UptimeKumaMonitor => {
  const first = lowestByIdOrNull(monitors);
  if (first === null) throw new Error(missingMessage);
  return first;
};

type FoundMonitor = { kind: "found"; monitor: UptimeKumaMonitor };

type FindResult =
  | FoundMonitor
  | { kind: "missing" }
  | { kind: "ambiguous"; url: string };

type RaceResult = FoundMonitor | { kind: "missing" };

const matchingMonitors = (
  monitors: UptimeKumaMonitor[],
  url: string,
  authorization: string,
): UptimeKumaMonitor[] => {
  const context: ScheduledMatchContext = {
    authorization,
    groupIds: sharedGroupIds(monitors),
    target: scheduledTarget(url),
  };
  return monitors.filter((monitor) => siteMonitorMatches(monitor, context));
};

/**
 * Finds the one monitor that matches the scheduled request. Missing is a
 * normal result (the add action is offered); ambiguous is reported as an
 * error state so the operator is told to fix Kuma by hand instead of guessing.
 */
export const findSiteMonitor = (
  monitors: UptimeKumaMonitor[],
  url: string,
  authorization: string,
): FindResult => {
  const matches = matchingMonitors(monitors, url, authorization);
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length > 1) return { kind: "ambiguous", url };
  return foundMonitor(matches, url);
};

/**
 * Finds the lowest-id monitor that matches the scheduled request, allowing
 * duplicates so a concurrent add that attached another monitor between read
 * and add does not get replaced. Used during the add flow to pick a winner.
 */
export const findRaceWinner = (
  monitors: UptimeKumaMonitor[],
  url: string,
  authorization: string,
): RaceResult => {
  const result = findSiteMonitor(monitors, url, authorization);
  if (result.kind === "ambiguous") {
    return foundMonitor(matchingMonitors(monitors, url, authorization), url);
  }
  return result;
};

const foundMonitor = (
  matches: UptimeKumaMonitor[],
  url: string,
): FoundMonitor => ({
  kind: "found",
  monitor: firstById(
    matches,
    t("built_sites.kuma_returned_no_monitor", { url }),
  ),
});

/** The monitor details shown on the maintenance tab. */
export const monitorDetails = (
  monitor: UptimeKumaMonitor,
  url: string,
): UptimeKumaMonitorDetails => ({
  active: monitor.active,
  group: UPTIME_KUMA_GROUP_NAME,
  id: monitor.id,
  intervalSeconds: monitor.interval,
  method: monitor.method,
  name: monitor.name,
  url,
});

export type UptimeKumaMonitorDetails = {
  active: boolean;
  group: string;
  id: number;
  intervalSeconds: number;
  method: string;
  name: string;
  url: string;
};
