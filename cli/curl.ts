import type {
  AdminApiRequest,
  AdminApiResponse,
  AdminApiTransport,
} from "#shared/admin-api-client.ts";
import type { CliConfig } from "./config.ts";
import { CliError } from "./errors.ts";

const buildUrl = (host: string, path: string): string =>
  `${host}${path.startsWith("/") ? path : `/${path}`}`;

export const buildCurlArgs = (
  config: CliConfig,
  { body, method, path }: AdminApiRequest,
): string[] => {
  const args = [
    "--silent",
    "--show-error",
    "--request",
    method,
    "--header",
    `Authorization: Bearer ${config.apiKey}`,
    "--header",
    "Accept: application/json",
    // The status rides after the body, so the transport can answer with it
    // and the client can refuse a non-2xx status by name.
    "--write-out",
    "\n%{http_code}",
  ];
  if (body !== undefined) {
    args.push(
      "--header",
      "Content-Type: application/json",
      "--data",
      JSON.stringify(body),
    );
  }
  args.push(buildUrl(config.apiHostname, path));
  return args;
};

export const curlFailureMessage = (stderr: string, stdout: string): string => {
  const stderrText = stderr.trim();
  if (stderrText) return stderrText;
  const stdoutText = stdout.trim();
  return stdoutText || "curl request failed";
};

/** Split curl's answer into the response body and the status line the
 *  --write-out argument appended. */
const splitStatus = (stdout: string): { body: string; statusText: string } => {
  // The --write-out string always rides last, after one newline; a failed
  // transfer carries the code 000.
  const split = stdout.lastIndexOf("\n");
  return {
    body: stdout.slice(0, split),
    statusText: stdout.slice(split + 1).trim(),
  };
};

/** Parse the answer body. A non-JSON body on an error status is the
 *  server's refusal: the raw body goes back, and the client's status
 *  mapping names the kind (401 → not_allowed, 400 → validation). A non-JSON
 *  success keeps the status the transport already extracted: the server
 *  answered, so the contract's status is its HTTP status, not null. */
const parseJson = (text: string, status: number): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (status >= 400) return text;
    throw new CliError(
      "server",
      `The server answered with text that is not JSON: ${text.slice(0, 200)}`,
      null,
      status,
    );
  }
};

/** The curl transport: one request in, the parsed body and the HTTP status
 *  out. A transport failure throws; the client refuses a non-2xx status
 *  itself, including the 000 a transfer without an answer reports. */
export const curlJson = async (
  config: CliConfig,
  options: AdminApiRequest,
): Promise<AdminApiResponse> => {
  const command = new Deno.Command("curl", {
    args: buildCurlArgs(config, options),
    stderr: "piped",
    stdout: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  const { body, statusText } = splitStatus(stdout);
  if (!output.success) {
    // The server kind survives the importer's io fallback: a transfer
    // failure is never a local input failure.
    throw new CliError("server", curlFailureMessage(stderr, body));
  }
  const status = Number(statusText);
  return { data: parseJson(body, status), status };
};

/** The transport one resolved config serves: curl carries the auth and the
 *  HTTP mechanics, and the client validates every answer. */
export const curlTransport = (config: CliConfig): AdminApiTransport =>
  (options) => curlJson(config, options);
