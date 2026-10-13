import * as v from "valibot";
import {
  type AdminApiTransport,
  adminApiChildCall,
  adminApiCustomRoute,
  adminApiDelete,
  adminApiGet,
  adminApiList,
  adminApiWrite,
} from "#shared/admin-api-client.ts";
import {
  bodySchemaFor,
  type ParsedCommand,
  parseCommand,
  type Table,
} from "./commands.ts";
import type { CliConfig } from "./config.ts";
import { describeEntries } from "./describe.ts";
import {
  CliError,
  cliErrorFromUnknown,
  errorJson,
  exitCodeFor,
  fieldProblems,
} from "./errors.ts";

/** The seams the runner runs on: the table the commands read, the transport
 *  the client sends through, and the two IO sides the tests replace. */
export type RunDeps = {
  config: () => Promise<CliConfig>;
  readStdin: () => Promise<string>;
  table: Table;
  transport: AdminApiTransport;
};

/** What one run answered: the streams it wrote and the exit code it asks
 *  for. The entrypoint applies them. */
export type RunResult = { code: number; err?: string; out?: string };

const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** Parse one body argument: its JSON text, or all of stdin for "-". */
const parseBodyJson = async (
  source: string,
  readStdin: () => Promise<string>,
): Promise<unknown> => {
  const text = source === "-" ? await readStdin() : source;
  try {
    return JSON.parse(text);
  } catch (error) {
    // JSON.parse answers a SyntaxError whose message names the position.
    const message = (error as Error).message;
    throw new CliError("validation", `The body is not valid JSON: ${message}.`);
  }
};

/** Check one write's body against the schema the table declares for its
 *  verb, before anything is sent. A schema the table does not declare leaves
 *  the body to the server's own validation. */
const validatedBody = async (
  command: Extract<ParsedCommand, { kind: "write" }>,
  schema: v.GenericSchema | undefined,
  readStdin: () => Promise<string>,
): Promise<unknown | undefined> => {
  // An absent body supplies no fields. Checking it against the schema names
  // every field the write would have missed (a delete without its
  // confirmation, for one) instead of one round trip for the same answer.
  const raw =
    command.body === undefined
      ? undefined
      : await parseBodyJson(command.body, readStdin);
  if (schema === undefined) return raw;
  const result = v.safeParse(schema, raw ?? {});
  if (!result.success) {
    throw new CliError(
      "validation",
      "The body failed validation. It was not sent.",
      fieldProblems(result.issues),
    );
  }
  return result.output;
};

/** Run one request command against the typed client. */
const execute = async (
  command: Exclude<ParsedCommand, { kind: "describe" }>,
  deps: RunDeps,
): Promise<unknown> => {
  const { transport } = deps;
  if (command.kind === "list") {
    return adminApiList(transport, command.entry);
  }
  if (command.kind === "read") {
    return adminApiGet(transport, command.entry, command.id);
  }
  if (command.kind === "custom") {
    return adminApiCustomRoute(
      transport,
      command.entry,
      command.routeKey,
      command.id,
    );
  }
  const body = await validatedBody(
    command,
    bodySchemaFor(command.entry, command),
    deps.readStdin,
  );
  if (command.child) {
    return adminApiChildCall(
      transport,
      command.entry,
      command.verb,
      command.child.key,
      command.parentId,
      command.child.id,
      body,
    );
  }
  if (command.verb === "create") {
    return adminApiWrite(transport, command.entry, "create", undefined, body);
  }
  if (command.verb === "update") {
    return adminApiWrite(
      transport,
      command.entry,
      "update",
      command.parentId,
      body,
    );
  }
  // The body already passed DeleteBodySchema above — bodySchemaFor answers
  // it for every delete — so it is the body the client asks for.
  const deleteBody = body as Parameters<typeof adminApiDelete>[3];
  return adminApiDelete(transport, command.entry, command.parentId, deleteBody);
};

/** One CLI run: parse the arguments, send one request, and answer with the
 *  contract's streams and exit code. Never throws — every failure becomes
 *  the stderr JSON error and its exit code. */
export const runApi = async (
  args: readonly string[],
  deps: RunDeps,
): Promise<RunResult> => {
  try {
    const command = parseCommand(deps.table, args);
    if (command.kind === "describe") {
      return { code: 0, out: jsonLine(describeEntries(command.resources)) };
    }
    // Fail before any request when the site or the key is missing.
    await deps.config();
    return { code: 0, out: jsonLine(await execute(command, deps)) };
  } catch (error) {
    const cli = cliErrorFromUnknown(error);
    return { code: exitCodeFor(cli), err: jsonLine(errorJson(cli)) };
  }
};
