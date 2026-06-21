import { join } from "node:path";

export type CliConfig = Readonly<{ apiHostname: string; apiKey: string }>;

const ENV_HOST = "API_HOSTNAME";
const ENV_KEY = "API_KEY";

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

const cleanHost = (host: string): string => {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const requiredPrompt = (label: string): string => {
  const value = prompt(label)?.trim() ?? "";
  if (!value) throw new Error(`${label} is required`);
  return value;
};

export const loadConfig = async (envDir: string): Promise<CliConfig> => {
  const envFile = await readDotEnv(envDir);
  const apiHostname = cleanHost(
    Deno.env.get(ENV_HOST) ?? envFile[ENV_HOST] ?? requiredPrompt("API host"),
  );
  const apiKey =
    Deno.env.get(ENV_KEY) ?? envFile[ENV_KEY] ?? requiredPrompt("API key");
  return { apiHostname, apiKey };
};
