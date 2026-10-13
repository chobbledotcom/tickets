import type * as v from "valibot";
import {
  type AdminApiChild,
  type AdminApiResource,
  DeleteBodySchema,
} from "#shared/admin-api-resources.ts";
import { CliError } from "./errors.ts";

/** The resource table the parser and describe read. The CLI passes the
 *  production table; tests pass their own, so a new table row reaches the
 *  commands with no CLI change. */
export type Table = Record<string, AdminApiResource>;

/** The standard verbs every resource answers with. */
export const STANDARD_VERBS = [
  "create",
  "delete",
  "describe",
  "get",
  "list",
  "update",
] as const;

export type StandardVerb = (typeof STANDARD_VERBS)[number];

/** One child row a write addresses, resolved off the table. */
export type ChildAddress = {
  def: AdminApiChild;
  /** Absent on a create: the child collection takes the new row. */
  id: number | undefined;
  key: string;
};

export type ParsedCommand =
  | { kind: "describe"; resources: readonly [string, AdminApiResource][] }
  | { entry: AdminApiResource; kind: "list"; resource: string }
  | { entry: AdminApiResource; id: number; kind: "read"; resource: string }
  | {
      entry: AdminApiResource;
      id: number;
      kind: "custom";
      resource: string;
      routeKey: string;
    }
  | {
      body: string | undefined;
      child: ChildAddress | undefined;
      entry: AdminApiResource;
      kind: "write";
      parentId: number;
      resource: string;
      verb: "create" | "delete" | "update";
    };

const unknownResource = (raw: string, table: Table): CliError =>
  new CliError(
    "usage",
    `Unknown resource '${raw}'. The valid resources are: ${Object.keys(
      table,
    ).join(", ")}.`,
  );

/** Read one own property off a table record, or undefined for a name the
 *  table never declared. Inherited properties do not count, so
 *  'constructor' names no resource and no route. */
const ownEntry = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** One whole-number id segment. */
const parseId = (raw: string, what: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new CliError(
      "usage",
      `The ${what} must be a whole number, got '${raw}'.`,
    );
  }
  return Number(raw);
};

const tooManyArguments = (): CliError =>
  new CliError("usage", "Too many arguments.");

const requireBody = (raw: string | undefined, verb: string): string => {
  if (raw === undefined) {
    throw new CliError(
      "usage",
      `The '${verb}' command needs a JSON body argument, or '-' to read it from stdin.`,
    );
  }
  return raw;
};

/** The usage error for a write whose id argument is missing. */
const missingWriteIdError = (
  verb: "create" | "delete" | "update",
  entry: AdminApiResource,
): CliError => {
  if (verb === "create") {
    return new CliError(
      "usage",
      "The 'create' command needs a JSON body argument, or '-' to read it from stdin.",
    );
  }
  return new CliError(
    "usage",
    `The '${verb}' command needs the ${entry.label.toLowerCase()} id.`,
  );
};

/** One child-addressing failure: the path segments did not fit the child
 *  shapes the table declares. */
const badAddress = (raw: string): CliError =>
  new CliError(
    "usage",
    `The id argument '${raw}' does not fit. Use '<id>' or '<parentId>/<child>/<childId>'.`,
  );

/** One child write address: `parentId/childKey` for a create, and
 *  `parentId/childKey/childId` for an update or a delete. */
const CHILD_ADDRESS = /^(\d+)\/([^/]+)(?:\/(\d+))?$/;

/** Resolve one child address against the table. */
const parseChildWrite = (
  resource: string,
  entry: AdminApiResource,
  raw: string,
): { child: ChildAddress; parentId: number } => {
  const match = CHILD_ADDRESS.exec(raw);
  if (!match) throw badAddress(raw);
  // The address regex guarantees the parent id and the child key groups.
  const parentIdText = match[1] as string;
  const key = match[2] as string;
  const children = entry.children;
  const def = children === undefined ? undefined : ownEntry(children, key);
  if (!def) {
    const names = Object.keys(children ?? {}).join(", ") || "none";
    throw new CliError(
      "usage",
      `The resource '${resource}' has no child '${key}'. Its children are: ${names}.`,
    );
  }
  const childIdText = match[3];
  return {
    child: {
      def,
      id:
        childIdText === undefined
          ? undefined
          : parseId(childIdText, "child id"),
      key,
    },
    parentId: parseId(parentIdText, `${entry.label.toLowerCase()} id`),
  };
};

/** Resolve the resource name one command names, off the table. */
const resolveResource = (
  table: Table,
  resourceRaw: string | undefined,
  verb: string,
): { entry: AdminApiResource; name: string } => {
  if (resourceRaw === undefined) {
    throw new CliError(
      "usage",
      `The '${verb}' command needs a resource. The valid resources are: ${Object.keys(
        table,
      ).join(", ")}.`,
    );
  }
  const entry = ownEntry(table, resourceRaw);
  if (!entry) throw unknownResource(resourceRaw, table);
  return { entry, name: resourceRaw };
};

/** Parse list: `list <resource>`. */
const parseList = (table: Table, args: readonly string[]): ParsedCommand => {
  const [, resourceRaw, extra] = args;
  if (extra !== undefined) throw tooManyArguments();
  const { entry, name } = resolveResource(table, resourceRaw, "list");
  return { entry, kind: "list", resource: name };
};

/** Parse get: `get <resource> <id>`. */
const parseRead = (table: Table, args: readonly string[]): ParsedCommand => {
  const [, resourceRaw, idRaw, extra, ...rest] = args;
  if (extra !== undefined || rest.length > 0) throw tooManyArguments();
  const { entry, name } = resolveResource(table, resourceRaw, "get");
  if (idRaw === undefined) {
    throw new CliError(
      "usage",
      `The 'get' command needs the ${entry.label.toLowerCase()} id.`,
    );
  }
  return {
    entry,
    id: parseId(idRaw, `${entry.label.toLowerCase()} id`),
    kind: "read",
    resource: name,
  };
};

/** The write body: create and update require one; a delete may omit it. */
const writeBody = (
  verb: "create" | "delete" | "update",
  bodyRaw: string | undefined,
): string | undefined => {
  if (verb === "delete") return bodyRaw;
  return requireBody(bodyRaw, verb);
};

/** One child address checked against its verb: a create addresses the
 *  collection, an update or a delete the one row. */
const checkChildVerbAddress = (
  verb: "create" | "delete" | "update",
  child: ChildAddress,
  raw: string,
): void => {
  if (verb === "create" && child.id !== undefined) throw badAddress(raw);
  if (verb !== "create" && child.id === undefined) {
    // The admin api serves a child row's PUT and DELETE only with the
    // child id in the path; the collection answers no such method.
    throw new CliError(
      "usage",
      `The '${verb}' command needs the child id. Use '<parentId>/<child>/<childId>'.`,
    );
  }
};

/** Parse create, update, and delete over one resolved resource. */
const parseWrite = (
  resource: string,
  entry: AdminApiResource,
  verb: "create" | "delete" | "update",
  args: readonly string[],
): ParsedCommand => {
  const [, , idRaw, bodyRaw, extra, ...rest] = args;
  if (extra !== undefined || rest.length > 0) throw tooManyArguments();
  if (idRaw === undefined) throw missingWriteIdError(verb, entry);
  // A child address starts with the parent id: "3/options". A JSON body
  // never starts with digits and a slash.
  const childForm = /^\d+\//.test(idRaw);
  if (verb === "create" && !childForm) {
    if (bodyRaw !== undefined) throw tooManyArguments();
    // A create's first argument after the resource is the body itself.
    return {
      body: requireBody(idRaw, "create"),
      child: undefined,
      entry,
      kind: "write",
      parentId: 0,
      resource,
      verb,
    };
  }
  if (childForm) {
    const { child, parentId } = parseChildWrite(resource, entry, idRaw);
    checkChildVerbAddress(verb, child, idRaw);
    return {
      body: writeBody(verb, bodyRaw),
      child,
      entry,
      kind: "write",
      parentId,
      resource,
      verb,
    };
  }
  return {
    body: writeBody(verb, bodyRaw),
    child: undefined,
    entry,
    kind: "write",
    parentId: parseId(idRaw, `${entry.label.toLowerCase()} id`),
    resource,
    verb,
  };
};

/** Parse one custom-route command: `<routeKey> <resource> <id>`. */
const parseCustom = (
  table: Table,
  routeKey: string,
  args: readonly string[],
): ParsedCommand => {
  const [, resourceRaw, idRaw, extra, ...rest] = args;
  if (
    !Object.values(table).some(
      (item) =>
        item.custom !== undefined && Object.hasOwn(item.custom, routeKey),
    )
  ) {
    throw new CliError(
      "usage",
      `Unknown command '${routeKey}'. The valid commands are: ${STANDARD_VERBS.join(
        ", ",
      )}, and every custom route 'describe' names.`,
    );
  }
  if (extra !== undefined || rest.length > 0) throw tooManyArguments();
  if (resourceRaw === undefined || idRaw === undefined) {
    throw new CliError(
      "usage",
      `The '${routeKey}' command needs the resource and the id. Usage: ${routeKey} <resource> <id>.`,
    );
  }
  const entry = ownEntry(table, resourceRaw);
  if (!entry) throw unknownResource(resourceRaw, table);
  if (entry.custom === undefined || !Object.hasOwn(entry.custom, routeKey)) {
    const routeNames = Object.keys(entry.custom ?? {});
    const names = routeNames.length > 0 ? routeNames.join(", ") : "none";
    throw new CliError(
      "usage",
      `The command '${routeKey}' is not a route of '${resourceRaw}'. The routes of '${resourceRaw}' are: ${names}.`,
    );
  }
  return {
    entry,
    id: parseId(idRaw, `${entry.label.toLowerCase()} id`),
    kind: "custom",
    resource: resourceRaw,
    routeKey,
  };
};

/** Parse describe: `describe` for every resource, or `describe <resource>`. */
const parseDescribe = (
  table: Table,
  args: readonly string[],
): ParsedCommand => {
  const [, resourceRaw, extra, ...rest] = args;
  if (extra !== undefined || rest.length > 0) throw tooManyArguments();
  if (resourceRaw === undefined) {
    return { kind: "describe", resources: Object.entries(table) };
  }
  const entry = ownEntry(table, resourceRaw);
  if (!entry) throw unknownResource(resourceRaw, table);
  return { kind: "describe", resources: [[resourceRaw, entry]] };
};

/** Parse the CLI's arguments into one command, or throw the usage error that
 *  names the valid choices. Everything resolves from the table: a resource,
 *  child, or custom route the table adds needs no parser change. */
export const parseCommand = (
  table: Table,
  args: readonly string[],
): ParsedCommand => {
  const [head] = args;
  if (head === undefined) {
    throw new CliError(
      "usage",
      "The CLI needs a command. The valid commands are: describe, list, get, create, update, delete, and every custom route 'describe' names.",
    );
  }
  if (head === "describe") return parseDescribe(table, args);
  if (head === "list") return parseList(table, args);
  if (head === "get") return parseRead(table, args);
  if (head === "create" || head === "update" || head === "delete") {
    const { entry, name } = resolveResource(table, args[1], head);
    return parseWrite(name, entry, head, args);
  }
  return parseCustom(table, head, args);
};

/** The body schema one write validates against before it sends. Absent: the
 *  server owns the validation and the CLI sends the parsed JSON as it is. */
export const bodySchemaFor = (
  entry: AdminApiResource,
  command: Extract<ParsedCommand, { kind: "write" }>,
): v.GenericSchema | undefined => {
  if (command.verb === "delete") return DeleteBodySchema;
  if (command.child) return command.child.def.bodySchema;
  return command.verb === "create"
    ? entry.createBodySchema
    : entry.updateBodySchema;
};
