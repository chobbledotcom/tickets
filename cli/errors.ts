import { AdminApiError } from "#shared/admin-api-client.ts";

/** The failure kinds the CLI reports. Each kind maps to one exit code. */
export type CliErrorKind =
  | "usage"
  | "validation"
  | "not_allowed"
  | "not_found"
  | "server"
  | "io";

/** The exit code each kind answers with. */
export const EXIT_CODES: Record<CliErrorKind, number> = {
  io: 6,
  not_allowed: 4,
  not_found: 5,
  server: 6,
  usage: 2,
  validation: 3,
};

/** One problem with one body field. */
export type FieldProblem = { field: string; message: string };

/** The one error type the CLI raises. The message names the problem and the
 *  fix; `status` carries the HTTP status when the server answered, and
 *  `fields` names per-field problems when the body failed a check. */
export class CliError extends Error {
  readonly fields: FieldProblem[] | null;
  readonly kind: CliErrorKind;
  readonly status: number | undefined;

  constructor(
    kind: CliErrorKind,
    message: string,
    fields: FieldProblem[] | null = null,
    status?: number,
  ) {
    super(message);
    this.fields = fields;
    this.kind = kind;
    this.status = status;
  }
}

/** The JSON object stderr carries for one failure. An absent status means no
 *  server answered, and the contract renders it as null. */
export const errorJson = (error: CliError): unknown => ({
  error: {
    fields: error.fields,
    kind: error.kind,
    message: error.message,
    status: error.status ?? null,
  },
});

/** The exit code one mapped error answers with. */
export const exitCodeFor = (error: CliError): number => EXIT_CODES[error.kind];

/** Map one HTTP status to the CLI error kind the contract names. */
const kindForStatus = (status: number | undefined): CliErrorKind => {
  if (status === 400) return "validation";
  if (status === 401 || status === 403) return "not_allowed";
  if (status === 404) return "not_found";
  return "server";
};

/** The server's own error text when its body names one. */
const serverMessage = (error: AdminApiError): string => {
  const data = error.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string"
  ) {
    return data.error;
  }
  return error.message;
};

/** Map any thrown value to the contract's error shape. A `CliError` passes
 *  through; the typed client's refusal maps by status; every other failure
 *  takes the caller's fallback kind — a transport failure for the api
 *  command, a local input or environment failure for the importer. */
export const cliErrorFromUnknown = (
  error: unknown,
  fallbackKind: CliErrorKind = "server",
): CliError => {
  if (error instanceof CliError) return error;
  if (error instanceof AdminApiError) {
    return new CliError(
      kindForStatus(error.status),
      serverMessage(error),
      null,
      error.status,
    );
  }
  return new CliError(
    fallbackKind,
    error instanceof Error ? error.message : String(error),
  );
};

/** Map valibot's issues to the per-field problems the contract carries. */
export const fieldProblems = (
  issues: readonly {
    message: string;
    path?: readonly { key: unknown }[] | undefined;
  }[],
): FieldProblem[] =>
  issues.map((issue) => ({
    field: issue.path?.map((item) => String(item.key)).join(".") ?? "",
    message: issue.message,
  }));
