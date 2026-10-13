import { join } from "node:path";
import { CliError } from "./errors.ts";

export type CliConfig = Readonly<{ apiHostname: string; apiKey: string }>;

const ENV_HOST = "API_HOSTNAME";
const ENV_KEY = "API_KEY";
const ENV_BASE_URL = "BASE_URL";

const parseDotEnv = (text: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1] as string;
    const rawValue = match[2] as string;
    values[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
};

const readDotEnv = async (envDir: string): Promise<Record<string, string>> => {
  try {
    return parseDotEnv(await Deno.readTextFile(join(envDir, ".env")));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
};

// requiredValue answers a non-empty trimmed host, so cleanHost has no
// blank-input branch to guard.
const cleanHost = (host: string): string =>
  (/^https?:\/\//.test(host) ? host : `https://${host}`).replace(/\/+$/, "");

const requiredValue = (value: string | undefined, name: string): string => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new CliError(
      "usage",
      `The ${name} is missing. Set API_HOSTNAME and API_KEY in the environment or the repo .env file.`,
    );
  }
  return trimmed;
};

/** Read the site the commands run against. There is no prompt: a missing
 *  host or key is a usage error the caller reports as JSON. */
export const loadConfig = async (envDir: string): Promise<CliConfig> => {
  const envFile = await readDotEnv(envDir);
  // The deployment .env names the site BASE_URL; accept it as the host.
  return {
    apiHostname: cleanHost(
      requiredValue(
        Deno.env.get(ENV_HOST) ?? envFile[ENV_HOST] ?? envFile[ENV_BASE_URL],
        "API host",
      ),
    ),
    apiKey: requiredValue(Deno.env.get(ENV_KEY) ?? envFile[ENV_KEY], "API key"),
  };
};
