import { Given } from "@cucumber/cucumber";

export const SPEC_RUNS_PATH_ENV = "TICKETS_SPEC_RUNS_PATH";

export const requiredSpecRunsPath = (): string => {
  const path = Deno.env.get(SPEC_RUNS_PATH_ENV);
  if (!path) throw new Error(`${SPEC_RUNS_PATH_ENV} is required`);
  return path;
};

export const registerRecordedStep = (): void => {
  Given("a selected example runs", async () => {
    await Deno.writeTextFile(requiredSpecRunsPath(), "run\n", { append: true });
  });
};
