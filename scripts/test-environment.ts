import { denoEnvironment, environmentTasks } from "./environment-values.ts";

export const withEnvironment = environmentTasks(denoEnvironment);
