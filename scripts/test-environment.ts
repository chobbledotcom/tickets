import {
  denoEnvironment,
  environmentTasks,
  type RunWithEnvironment,
} from "./environment-values.ts";

export const withEnvironment: RunWithEnvironment =
  environmentTasks(denoEnvironment);
