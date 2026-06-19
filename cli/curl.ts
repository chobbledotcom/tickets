import type { CliConfig } from "./config.ts";

export type CurlOptions = Readonly<{
  method?: string;
  path: string;
  body?: unknown;
}>;

const buildUrl = (host: string, path: string): string =>
  `${host}${path.startsWith("/") ? path : `/${path}`}`;

export const buildCurlArgs = (
  config: CliConfig,
  { body, method = "GET", path }: CurlOptions,
): string[] => {
  const args = [
    "--silent",
    "--show-error",
    "--fail-with-body",
    "--request",
    method,
    "--header",
    `Authorization: Bearer ${config.apiKey}`,
    "--header",
    "Accept: application/json",
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

export const curlJson = async <T>(
  config: CliConfig,
  options: CurlOptions,
): Promise<T> => {
  const command = new Deno.Command("curl", {
    args: buildCurlArgs(config, options),
    stderr: "piped",
    stdout: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    throw new Error(curlFailureMessage(stderr, stdout));
  }
  return JSON.parse(stdout) as T;
};
