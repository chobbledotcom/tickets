import type { BuiltSite } from "#shared/db/built-sites/types.ts";
import { siteBaseUrl } from "#shared/db/built-sites.ts";
import type { UptimeKumaMonitorInput } from "./client.ts";
import type { UptimeKumaConfig } from "./config.ts";

export const UPTIME_KUMA_GROUP_NAME = "Chobble Tickets";

export const scheduledUrl = (site: BuiltSite): string =>
  `${siteBaseUrl(site.siteUrl)}/scheduled`;

export const scheduledAuthorization = (scheduledTaskKey: string): string =>
  `Bearer ${scheduledTaskKey}`;

const monitorDefaults = (
  type: "group" | "http",
  name: string,
  parent: number | null,
): UptimeKumaMonitorInput => ({
  accepted_statuscodes: ["200-299"],
  authMethod: "",
  body: null,
  conditions: [],
  databaseConnectionString: null,
  description: null,
  dns_resolve_server: "1.1.1.1",
  dns_resolve_type: "A",
  expiryNotification: false,
  headers: null,
  hostname: null,
  httpBodyEncoding: "json",
  ignoreTls: false,
  interval: 60,
  kafkaProducerBrokers: [],
  kafkaProducerSaslOptions: { mechanism: "None" },
  maxredirects: 10,
  maxretries: 1,
  method: "GET",
  mqttPassword: "",
  mqttSuccessMessage: "",
  mqttTopic: "",
  mqttUsername: "",
  name,
  notificationIDList: {},
  packetSize: 56,
  parent,
  port: null,
  proxyId: null,
  rabbitmqNodes: [],
  resendInterval: 0,
  retryInterval: 60,
  timeout: 48,
  type,
  upsideDown: false,
  url: null,
});

export const groupMonitorInput = (): UptimeKumaMonitorInput =>
  monitorDefaults("group", UPTIME_KUMA_GROUP_NAME, null);

export const siteMonitorInput = (
  site: BuiltSite,
  config: UptimeKumaConfig,
  parent: number,
  scheduledTaskKey: string,
): UptimeKumaMonitorInput => ({
  ...monitorDefaults("http", site.name, parent),
  headers: JSON.stringify({
    Authorization: scheduledAuthorization(scheduledTaskKey),
  }),
  interval: config.intervalSeconds,
  method: "POST",
  url: scheduledUrl(site),
});
