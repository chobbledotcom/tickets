import { withCleanup } from "./cleanup.ts";

const restoreEnvironment = (
  values: Record<string, string | undefined>,
): void => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
};

export const withEnvironment = <Result>(
  values: Record<string, string>,
  task: () => Promise<Result>,
): Promise<Result> => {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, Deno.env.get(key)]),
  );
  return withCleanup(async () => {
    restoreEnvironment(values);
    return await task();
  }, [() => restoreEnvironment(previous)]);
};
