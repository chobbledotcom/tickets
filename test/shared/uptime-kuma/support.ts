import type { UptimeKumaMonitor } from "#shared/uptime-kuma/client.ts";

/**
 * Values for the monitor fields the built-site guard checks — a monitor that
 * is safe to drive a scheduled request: right way up, no custom conditions,
 * and a timeout that gives the request time to finish.
 *
 * Shared between the `client/` and `monitors/` test subdirectories so each
 * can spread it into a fixture without walking up to the other's folder.
 */
export const safeMonitorFields: Pick<
  UptimeKumaMonitor,
  "conditions" | "timeout" | "upsideDown"
> = {
  conditions: [],
  timeout: 48,
  upsideDown: false,
};
