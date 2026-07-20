import type { LaunchOptions } from "playwright";

export const browserLaunchOptions = (
  headless: boolean,
  executablePath?: string,
  args?: string[],
): LaunchOptions => ({
  ...(args ? { args } : {}),
  ...(executablePath ? { executablePath } : {}),
  headless,
});
