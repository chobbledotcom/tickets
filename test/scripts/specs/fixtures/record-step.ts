import { Given } from "@cucumber/cucumber";
import { getEnv } from "#shared/env.ts";

export const SPEC_RUNS_PATH_ENV = "TICKETS_SPEC_RUNS_PATH";

export const requiredSpecRunsPath = (): string => {
  const path = getEnv(SPEC_RUNS_PATH_ENV);
  if (!path) throw new Error(`${SPEC_RUNS_PATH_ENV} is required`);
  return path;
};

export const registerRecordedStep = (): void => {
  Given("a selected example runs", async () => {
    await Deno.writeTextFile(requiredSpecRunsPath(), "run\n", { append: true });
  });
};
