import type { Config } from "@libsql/client";
import { parseArgs } from "@std/cli/parse-args";
import { load } from "@std/dotenv";
import { basename, dirname, join, resolve, toFileUrl } from "@std/path";
import * as v from "valibot";
import { withCleanup } from "#scripts/cleanup.ts";
import { secureUrlCheck } from "#scripts/secure-url.ts";
import { getEnv } from "#shared/env.ts";

export const SNAPSHOT_USAGE = "Usage: deno task snapshot --out <path.sqlite>";

export interface SnapshotOptions {
  outputPath: string;
}

export interface SnapshotRequest extends SnapshotOptions {
  dbToken: string;
  dbUrl: string;
}

export interface SnapshotQueryResult {
  rows: readonly Readonly<Record<string, unknown>>[];
}

export interface SnapshotQueryCheck {
  sql: string;
  verify: (result: SnapshotQueryResult) => void;
}

export interface SnapshotClient {
  close(): void;
  execute(sql: string): Promise<SnapshotQueryResult>;
  sync(): Promise<unknown>;
}

export type SnapshotClientFactory = (config: Config) => SnapshotClient;
export type SnapshotEnvReader = (key: string) => string | undefined;
export type SnapshotEnvFileLoader = (
  path: string,
) => Promise<Record<string, string>>;

export const SNAPSHOT_PROGRESS = {
  checking: "[1/4] Checking destination",
  publishing: "[4/4] Publishing standalone SQLite file",
  syncing: "[2/4] Syncing remote database",
  verifying: "[3/4] Checkpointing and checking integrity",
} as const;

export type SnapshotProgress =
  (typeof SNAPSHOT_PROGRESS)[keyof typeof SNAPSHOT_PROGRESS];
export type SnapshotProgressWriter = (message: SnapshotProgress) => void;

const ignoreSnapshotProgress: SnapshotProgressWriter = () => {};

const OutputValuesSchema = v.strictTuple([
  v.pipe(
    v.string(),
    v.check((path) => path.trim().length > 0),
  ),
]);

const EmptyStringsSchema = v.strictTuple([]);

const snapshotArgsSchema = <
  Help extends boolean,
  OutSchema extends v.GenericSchema,
>(
  help: Help,
  out: OutSchema,
) =>
  v.strictObject({
    _: EmptyStringsSchema,
    h: v.literal(help),
    help: v.literal(help),
    out,
  });

const SnapshotArgsSchema = snapshotArgsSchema(false, OutputValuesSchema);
const SnapshotHelpArgsSchema = snapshotArgsSchema(true, EmptyStringsSchema);

const CheckpointRowsSchema = v.pipe(
  v.array(
    v.strictObject({
      busy: v.literal(0),
      checkpointed: v.literal(0),
      log: v.literal(0),
    }),
  ),
  v.length(1),
);

const IntegrityRowsSchema = v.pipe(
  v.array(v.strictObject({ integrity_check: v.literal("ok") })),
  v.length(1),
);

const SECURE_DATABASE_PROTOCOLS = new Set(["https:", "libsql:"]);

const invalidUsage = (): never => {
  throw new Error(SNAPSHOT_USAGE);
};

export const parseSnapshotArgs = (args: string[]): SnapshotOptions | null => {
  const parsed = parseArgs(args, {
    alias: { h: "help" },
    boolean: ["help"],
    collect: ["out"],
    string: ["out"],
  });
  if (parsed.help) {
    if (!v.safeParse(SnapshotHelpArgsSchema, parsed).success) invalidUsage();
    return null;
  }
  const result = v.safeParse(SnapshotArgsSchema, parsed);
  if (!result.success) return invalidUsage();
  return { outputPath: result.output.out[0] };
};

const requiredEnv = (key: string, readEnv: SnapshotEnvReader): string => {
  const value = readEnv(key);
  if (!value || value.trim().length === 0) {
    throw new Error(`${key} environment variable is required`);
  }
  return value;
};

const requireRemoteDatabaseUrl = (value: string): string =>
  secureUrlCheck(SECURE_DATABASE_PROTOCOLS)(value, "DB_URL");

export const readSnapshotRequest = (
  options: SnapshotOptions,
  readEnv: SnapshotEnvReader = getEnv,
): SnapshotRequest => ({
  dbToken: requiredEnv("DB_TOKEN", readEnv),
  dbUrl: requireRemoteDatabaseUrl(requiredEnv("DB_URL", readEnv)),
  outputPath: options.outputPath,
});

const loadSnapshotEnvFile: SnapshotEnvFileLoader = (path) =>
  load({ envPath: path });

export const readSnapshotRequestFromEnvFile = async (
  options: SnapshotOptions,
  path = ".env",
  readEnv: SnapshotEnvReader = getEnv,
  loadFile: SnapshotEnvFileLoader = loadSnapshotEnvFile,
): Promise<SnapshotRequest> => {
  const fileEnv = await loadFile(path);
  return readSnapshotRequest(options, (key) => fileEnv[key] ?? readEnv(key));
};

const outputAlreadyExists = (path: string): Error =>
  new Error(`Output already exists: ${path}`);

const readOrNullIfMissing = async <Result>(
  read: () => Promise<Result>,
): Promise<Result | null> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
};

const fileInfoOrNull =
  (getRead: () => (path: string) => Promise<Deno.FileInfo>) =>
  (path: string): Promise<Deno.FileInfo | null> =>
    readOrNullIfMissing(() => getRead()(path));

const statOrNull = fileInfoOrNull(() => Deno.stat);
const lstatOrNull = fileInfoOrNull(() => Deno.lstat);

const requireOutputDirectory = async (path: string): Promise<void> => {
  const info = await statOrNull(path);
  if (info === null)
    throw new Error(`Output directory does not exist: ${path}`);
  if (!info.isDirectory)
    throw new Error(`Output directory is not a directory: ${path}`);
};

const outputFiles = (path: string): string[] => [
  path,
  `${path}-wal`,
  `${path}-shm`,
];

const requireMissingOutputFiles = async (path: string): Promise<void> => {
  const existingPath = (
    await Promise.all(
      outputFiles(path).map(async (filePath) =>
        (await lstatOrNull(filePath)) === null ? null : filePath,
      ),
    )
  ).find((filePath) => filePath !== null);
  if (existingPath !== undefined) throw outputAlreadyExists(existingPath);
};

const withSnapshotClient = <Result>(
  factory: SnapshotClientFactory,
  config: Config,
  run: (client: SnapshotClient) => Promise<Result>,
): Promise<Result> => {
  const client = factory(config);
  return withCleanup(() => run(client), [() => client.close()]);
};

const waitForOrAbort = async <Result>(
  operation: () => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> => {
  if (signal === undefined) return await operation();
  signal.throwIfAborted();
  const interrupted = Promise.withResolvers<never>();
  const stop = (): void => interrupted.reject(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await Promise.race([operation(), interrupted.promise]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
};

export const checkLocalSnapshot = (
  path: string,
  factory: SnapshotClientFactory,
  checks: SnapshotQueryCheck[],
  signal?: AbortSignal,
): Promise<void> =>
  withSnapshotClient(factory, { url: toFileUrl(path).href }, async (client) => {
    for (const check of checks) {
      signal?.throwIfAborted();
      check.verify(
        await waitForOrAbort(() => client.execute(check.sql), signal),
      );
    }
  });

const syncReplica = (
  path: string,
  request: SnapshotRequest,
  factory: SnapshotClientFactory,
  signal?: AbortSignal,
): Promise<unknown> =>
  withSnapshotClient(
    factory,
    {
      authToken: request.dbToken,
      syncUrl: request.dbUrl,
      url: toFileUrl(path).href,
    },
    (client) => waitForOrAbort(() => client.sync(), signal),
  );

const verifyRows = (
  schema: v.GenericSchema,
  result: SnapshotQueryResult,
  message: string,
): void => {
  if (!v.safeParse(schema, result.rows).success) throw new Error(message);
};

const snapshotQueryCheck = (
  schema: v.GenericSchema,
  sql: string,
  message: string,
): SnapshotQueryCheck => ({
  sql,
  verify: (result) => verifyRows(schema, result, message),
});

const SNAPSHOT_QUERY_CHECKS = [
  snapshotQueryCheck(
    CheckpointRowsSchema,
    "PRAGMA wal_checkpoint(TRUNCATE)",
    "Database snapshot checkpoint did not empty the WAL",
  ),
  snapshotQueryCheck(
    IntegrityRowsSchema,
    "PRAGMA integrity_check",
    "Database snapshot integrity check failed",
  ),
];

const fileSizeOrNull = async (path: string): Promise<number | null> => {
  const info = await statOrNull(path);
  // SQLite can either remove an empty WAL or leave a zero-byte file.
  return info?.size ?? null;
};

const requireEmptyWal = async (path: string): Promise<void> => {
  const size = await fileSizeOrNull(`${path}-wal`);
  if (size !== null && size !== 0) {
    throw new Error("Database snapshot WAL is not empty");
  }
};

const publishSnapshot = async (
  temporaryPath: string,
  outputPath: string,
): Promise<void> => {
  await Deno.chmod(temporaryPath, 0o600);
  await requireMissingOutputFiles(outputPath);
  try {
    await Deno.link(temporaryPath, outputPath);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw outputAlreadyExists(outputPath);
    }
    throw error;
  }
};

export const createDatabaseSnapshot = async (
  request: SnapshotRequest,
  factory: SnapshotClientFactory,
  writeProgress: SnapshotProgressWriter = ignoreSnapshotProgress,
  signal?: AbortSignal,
): Promise<string> => {
  const outputPath = resolve(request.outputPath);
  const outputDirectory = dirname(outputPath);
  writeProgress(SNAPSHOT_PROGRESS.checking);
  await requireOutputDirectory(outputDirectory);
  await requireMissingOutputFiles(outputPath);
  const temporaryDirectory = await Deno.makeTempDir({
    dir: outputDirectory,
    prefix: `.${basename(outputPath)}-snapshot-`,
  });

  return await withCleanup(async () => {
    const temporaryPath = join(temporaryDirectory, "snapshot.sqlite");
    writeProgress(SNAPSHOT_PROGRESS.syncing);
    await syncReplica(temporaryPath, request, factory, signal);
    writeProgress(SNAPSHOT_PROGRESS.verifying);
    await checkLocalSnapshot(
      temporaryPath,
      factory,
      SNAPSHOT_QUERY_CHECKS,
      signal,
    );
    await requireEmptyWal(temporaryPath);
    writeProgress(SNAPSHOT_PROGRESS.publishing);
    await publishSnapshot(temporaryPath, outputPath);
    return outputPath;
  }, [() => Deno.remove(temporaryDirectory, { recursive: true })]);
};
