import { withCleanup } from "#scripts/cleanup.ts";

export interface WritableEnvironment {
  delete(key: string): void;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export type EnvironmentValues = Record<string, string | undefined>;

export type RunWithEnvironment = <Result>(
  values: EnvironmentValues | undefined,
  task: () => Promise<Result>,
) => Promise<Result>;

export const denoEnvironment: WritableEnvironment = Deno.env;

export const processEnvironment: WritableEnvironment = {
  delete: (key) => {
    delete process.env[key];
  },
  get: (key) => process.env[key],
  set: (key, value) => {
    process.env[key] = value;
  },
};

export const setEnvironmentValue = (
  environment: WritableEnvironment,
  key: string,
  value: string | undefined,
): void => {
  if (value === undefined) environment.delete(key);
  else environment.set(key, value);
};

export const applyEnvironment = (
  environment: WritableEnvironment,
  values: EnvironmentValues,
): void => {
  for (const [key, value] of Object.entries(values)) {
    setEnvironmentValue(environment, key, value);
  }
};

export const environmentTasks =
  (environment: WritableEnvironment): RunWithEnvironment =>
  (values, task) => {
    if (!values) return task();
    const previous = Object.fromEntries(
      Object.keys(values).map((key) => [key, environment.get(key)]),
    );
    return withCleanup(async () => {
      applyEnvironment(environment, values);
      return await task();
    }, [() => applyEnvironment(environment, previous)]);
  };
