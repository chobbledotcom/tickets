/**
 * A stand-in stripe-mock for the lifecycle tests. Each fixture writer wraps
 * this file in a two-line executable, so the harness starts it exactly like
 * the real mock (`<binary> -http-port <port>`) while the behaviour stays in
 * one typed place instead of script text assembled from strings.
 *
 * Usage: stand-in-mock.ts <mode> [argument] -http-port <port>
 */

const PORT_FLAG = "-http-port";

/** Hold one port open until the process is killed, and take each probe
 * connection in and let it go. An open listener alone holds no event-loop
 * work, so the accept loop is what keeps the mock alive. */
const holdPort = async (port: number): Promise<never> => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  for (;;) {
    (await listener.accept()).close();
  }
};

/** The first start dies at once, so the starter must refuse it and spend
 * another try. A later start holds the port for that try to land on. */
const exitThenHold = async (marker: string, port: number): Promise<never> => {
  try {
    Deno.statSync(marker);
  } catch {
    Deno.writeTextFileSync(marker, "");
    Deno.exit(1);
  }
  return await holdPort(port);
};

/** Wait for the given time before the port opens, so the first polls see it
 * shut. */
const waitThenHold = async (ms: number, port: number): Promise<never> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return await holdPort(port);
};

export type StandInMode =
  | "exit"
  | "hold-after"
  | "hold-port"
  | "exit-then-hold";

const requiredArgument = (
  mode: StandInMode,
  value: string | undefined,
): string => {
  if (value === undefined) {
    throw new Error(`The "${mode}" stand-in needs an argument.`);
  }
  return value;
};

const MODES: Record<
  StandInMode,
  (argument: string | undefined, port: number) => Promise<never>
> = {
  exit: () => Deno.exit(1),
  "exit-then-hold": (argument, port) =>
    exitThenHold(requiredArgument("exit-then-hold", argument), port),
  "hold-after": (argument, port) =>
    waitThenHold(Number(requiredArgument("hold-after", argument)), port),
  "hold-port": (argument) =>
    holdPort(Number(requiredArgument("hold-port", argument))),
};

const portFromArgs = (args: readonly string[]): number => {
  const value = args[args.indexOf(PORT_FLAG) + 1];
  if (value === undefined) {
    throw new Error(
      `The stand-in mock was started without a ${PORT_FLAG} value.`,
    );
  }
  return Number(value);
};

const args = Deno.args;
const modeName = args[0];
const runMode:
  | ((argument: string | undefined, port: number) => Promise<never>)
  | undefined =
  modeName === undefined ? undefined : MODES[modeName as StandInMode];
if (runMode === undefined) {
  throw new Error(`No stand-in mode ${JSON.stringify(modeName ?? null)}.`);
}
await runMode(args[1], portFromArgs(args));
