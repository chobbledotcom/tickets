import { t } from "#i18n";
import { bearerAuthorization } from "#shared/bearer.ts";
import type { BuiltSite } from "#shared/db/built-sites/types.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  type UptimeKumaClient,
  type UptimeKumaMonitor,
  uptimeKumaClientApi,
} from "./client.ts";
import {
  getEnabledUptimeKumaConfigOrNull,
  type UptimeKumaConfig,
} from "./config.ts";
import { kumaErrorMessage } from "./errors.ts";
import {
  findRaceWinner,
  findSiteMonitor,
  firstById,
  lowestByIdOrNull,
  monitorDetails,
  sharedGroups,
  type UptimeKumaMonitorDetails,
} from "./matching.ts";
import {
  groupMonitorInput,
  scheduledUrl,
  siteMonitorInput,
  UPTIME_KUMA_GROUP_NAME,
} from "./monitor-input.ts";

export type UptimeKumaMonitorState =
  | { kind: "unconfigured" }
  | { error: string; kind: "error" }
  | { kind: "missing" }
  | { kind: "found"; monitor: UptimeKumaMonitorDetails };

type AddedMonitor = { created: boolean; monitorId: number };

type AddResult = Result<AddedMonitor>;

const withClient = async <Value>(
  config: UptimeKumaConfig,
  use: (client: UptimeKumaClient) => Promise<Value>,
): Promise<Value> => {
  const client = await uptimeKumaClientApi.connect(config);
  try {
    await client.login(config.username, config.password);
    return await use(client);
  } finally {
    client.disconnect();
  }
};

const withMonitors = <Value>(
  config: UptimeKumaConfig,
  use: (
    client: UptimeKumaClient,
    monitors: UptimeKumaMonitor[],
    groups: UptimeKumaMonitor[],
  ) => Promise<Value> | Value,
): Promise<Value> =>
  withClient(config, async (client) => {
    const monitors = await client.getMonitors();
    return await use(client, monitors, sharedGroups(monitors));
  });

const withConfiguredKuma = async <Value>(
  unavailable: () => Value,
  failed: (error: unknown) => Value,
  use: (config: UptimeKumaConfig) => Promise<Value>,
): Promise<Value> => {
  const config = getEnabledUptimeKumaConfigOrNull();
  if (config === null) return unavailable();
  try {
    return await use(config);
  } catch (error) {
    return failed(error);
  }
};

const groupForAdd = async (
  client: UptimeKumaClient,
  groups: UptimeKumaMonitor[],
): Promise<UptimeKumaMonitor> => {
  const existing = lowestByIdOrNull(groups);
  if (existing !== null) return existing;
  await client.addMonitor(groupMonitorInput());
  return firstById(
    sharedGroups(await client.getMonitors()),
    t("built_sites.kuma_new_group_missing", {
      name: UPTIME_KUMA_GROUP_NAME,
    }),
  );
};

const finishMonitorAdd = async (
  client: UptimeKumaClient,
  monitors: UptimeKumaMonitor[],
  url: string,
  authorization: string,
  monitorId: number,
): Promise<AddedMonitor> => {
  const found = findRaceWinner(monitors, url, authorization);
  if (found.kind === "missing") {
    throw new Error(t("built_sites.kuma_new_monitor_missing", { url }));
  }
  const winner = found.monitor;
  const created = winner.id === monitorId;
  if (created) return { created, monitorId };
  const createdMonitorExists = monitors.some(
    (monitor) => monitor.id === monitorId,
  );
  if (createdMonitorExists) await client.deleteMonitor(monitorId);
  return { created, monitorId: winner.id };
};

const addToGroup = async (
  client: UptimeKumaClient,
  site: BuiltSite,
  config: UptimeKumaConfig,
  scheduledTaskKey: string,
  group: UptimeKumaMonitor,
  url: string,
  authorization: string,
): Promise<AddedMonitor> => {
  const currentMonitors = await client.getMonitors();
  const raceWinner = findRaceWinner(currentMonitors, url, authorization);
  if (raceWinner.kind === "found") {
    return { created: false, monitorId: raceWinner.monitor.id };
  }
  const monitorId = await client.addMonitor(
    siteMonitorInput(site, config, group.id, scheduledTaskKey),
  );
  return await finishMonitorAdd(
    client,
    await client.getMonitors(),
    url,
    authorization,
    monitorId,
  );
};

const addFromMonitors = async (
  client: UptimeKumaClient,
  monitors: UptimeKumaMonitor[],
  groups: UptimeKumaMonitor[],
  site: BuiltSite,
  config: UptimeKumaConfig,
  scheduledTaskKey: string,
): Promise<AddResult> => {
  const url = scheduledUrl(site);
  const authorization = bearerAuthorization(scheduledTaskKey);
  const existing = findSiteMonitor(monitors, url, authorization);
  if (existing.kind === "found") {
    return okResult({ created: false, monitorId: existing.monitor.id });
  }
  if (existing.kind === "ambiguous") {
    return errorResult(t("built_sites.kuma_duplicate_monitor", { url }));
  }
  const group = await groupForAdd(client, groups);
  return okResult(
    await addToGroup(
      client,
      site,
      config,
      scheduledTaskKey,
      group,
      url,
      authorization,
    ),
  );
};

const loadConfigured = (
  site: BuiltSite,
  config: UptimeKumaConfig,
): Promise<UptimeKumaMonitorState> => {
  const scheduledTaskKey = site.scheduledTaskKey;
  if (scheduledTaskKey === null) return Promise.resolve({ kind: "missing" });
  return withMonitors(config, (_client, monitors, _groups) => {
    const url = scheduledUrl(site);
    const found = findSiteMonitor(
      monitors,
      url,
      bearerAuthorization(scheduledTaskKey),
    );
    return found.kind === "found"
      ? { kind: "found", monitor: monitorDetails(found.monitor, url) }
      : found.kind === "ambiguous"
        ? {
            error: t("built_sites.kuma_duplicate_monitor", { url }),
            kind: "error",
          }
        : { kind: "missing" };
  });
};

const load = (site: BuiltSite): Promise<UptimeKumaMonitorState> =>
  withConfiguredKuma<UptimeKumaMonitorState>(
    () => ({ kind: "unconfigured" }),
    (error) => ({ error: kumaErrorMessage(error), kind: "error" }),
    (config) => loadConfigured(site, config),
  );

const add = (site: BuiltSite): Promise<AddResult> =>
  withConfiguredKuma(
    () => errorResult(t("built_sites.kuma_add_unconfigured")),
    (error) => errorResult(kumaErrorMessage(error)),
    (config) => {
      const scheduledTaskKey = site.scheduledTaskKey;
      if (scheduledTaskKey === null) {
        return Promise.resolve(errorResult(t("built_sites.kuma_needs_key")));
      }
      return withMonitors(config, (client, monitors, groups) =>
        addFromMonitors(
          client,
          monitors,
          groups,
          site,
          config,
          scheduledTaskKey,
        ),
      );
    },
  );

export const uptimeKumaMonitorService = { add, load };
