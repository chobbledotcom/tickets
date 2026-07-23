export type UptimeKumaErrorKind =
  | "connection_closed"
  | "connection_failed"
  | "connection_timeout"
  | "incorrect_credentials"
  | "invalid_response"
  | "monitor_list_timeout"
  | "request_timeout"
  | "two_factor"
  | "unsupported_version"
  | "version_timeout";

export class UptimeKumaError extends Error {
  constructor(readonly kind: UptimeKumaErrorKind) {
    super(kind);
  }
}
