import { stub } from "@std/testing/mock";

/** Run something with the console captured, keeping each stream apart. */
export const capturingConsole = async <T>(
  run: () => T | Promise<T>,
): Promise<{ errors: string[]; logs: string[]; value: T }> => {
  const logs: string[] = [];
  const errors: string[] = [];
  using _log = stub(console, "log", (line?: unknown) => {
    logs.push(String(line));
  });
  using _error = stub(console, "error", (line?: unknown) => {
    errors.push(String(line));
  });

  return { errors, logs, value: await run() };
};
