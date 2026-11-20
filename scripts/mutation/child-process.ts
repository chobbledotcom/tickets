import { extendedBy } from "#fp";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";

type DenoRunOptions = Omit<Deno.CommandOptions, "args" | "clearEnv">;

/** Everything `stream` gives, as text. */
const text = (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text();

/** Kill every process in the group `id`, if any are left. A stand-in child
 *  reports pid 0, which names no group and is left alone. */
const killGroup = (id: number): void => {
  if (id <= 0) return;
  try {
    Deno.kill(-id, "SIGKILL");
  } catch (error) {
    // Everything in the group has exited already.
    rethrowUnlessNotFound(error);
  }
};

/**
 * Run `deno <args>` capturing its exit code and output text, so a failed
 * test batch can report what the child printed. An explicit env is the
 * child's complete environment, so removing a parent variable works.
 *
 * With a signal, the child starts in a session of its own, which is also a
 * process group of its own. A kill then takes the whole group, including the
 * test workers and any browser the tests started. Whatever the child leaves
 * running in its group is killed when it ends.
 */
export const denoExitDetail = async (
  args: string[],
  options: DenoRunOptions = {},
): Promise<{ code: number; output: string }> => {
  const { signal, ...rest } = options;
  const group = signal !== undefined;
  const child = new Deno.Command(Deno.execPath(), {
    args,
    ...rest,
    clearEnv: rest.env !== undefined,
    ...(group ? { detached: true, stdin: "null" as const } : {}),
    stderr: "piped",
    stdout: "piped",
  }).spawn();
  const kill = (): void => {
    if (group) {
      killGroup(child.pid);
      return;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // The child finished between the timer and the kill.
    }
  };
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted === true) kill();
  const stdout = text(child.stdout);
  const stderr = text(child.stderr);
  const status = await child.status;
  signal?.removeEventListener("abort", kill);
  if (group) killGroup(child.pid);
  return {
    code: status.code,
    output: (await stdout) + (await stderr),
  };
};

/** Run `deno <args>` to completion and return its exit code. */
export const denoExitCode = (
  args: string[],
  options?: DenoRunOptions,
): Promise<number> =>
  denoExitDetail(args, options ?? {}).then(({ code }) => code);

/** The current process env plus the given extra variables — the env handed to
 * a spawned child process. */
export const envWith = (
  extras: Record<string, string>,
): Record<string, string> => extendedBy(extras)(Deno.env.toObject());
