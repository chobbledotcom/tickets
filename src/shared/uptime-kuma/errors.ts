import { t } from "#i18n";
import { UptimeKumaError, type UptimeKumaErrorKind } from "./error.ts";

/**
 * Mapping typed Kuma failures to catalog copy shown on the maintenance tab
 * and in flash messages.
 *
 * Messages returned by Kuma (plain `Error` values) are preserved as-is; only
 * locally generated failures are translated through catalog keys.
 */

const ERROR_MESSAGE_KEYS: Record<UptimeKumaErrorKind, string> = {
  connection_closed: "built_sites.kuma_connection_closed",
  connection_failed: "built_sites.kuma_connection_failed",
  connection_timeout: "built_sites.kuma_connection_timeout",
  incorrect_credentials: "built_sites.kuma_incorrect_credentials",
  invalid_response: "built_sites.kuma_invalid_response",
  monitor_list_timeout: "built_sites.kuma_monitor_list_timeout",
  request_timeout: "built_sites.kuma_request_timeout",
  two_factor: "built_sites.kuma_two_factor",
  unsupported_version: "built_sites.kuma_unsupported_version",
  version_timeout: "built_sites.kuma_version_timeout",
};

export const kumaErrorMessage = (error: unknown): string =>
  error instanceof UptimeKumaError
    ? t(ERROR_MESSAGE_KEYS[error.kind])
    : errorMessage(error);

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return t("built_sites.kuma_failed");
};
