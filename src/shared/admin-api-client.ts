/**
 * The typed admin API client, built from the resource table
 * (src/shared/admin-api-resources.ts). One flat function per verb. Each takes
 * the transport, the resource entry, and the call's arguments. Every success
 * response is validated against the entry's envelope schema before it is
 * returned. A malformed answer throws with the resource named and the fields
 * valibot rejected. A non-2xx status throws an AdminApiError whose
 * message carries the status and the server's error text.
 *
 * The transport carries the auth and the HTTP mechanics.
 */

import * as v from "valibot";
import type {
  AdminApiChild,
  AdminApiResource,
} from "#shared/admin-api-resources.ts";
import { namedError } from "#shared/named-error.ts";

/** What the server answered: the parsed body, and the status when the
 *  transport can see it (the curl bridge cannot — it throws on failure). */
export type AdminApiResponse = { data: unknown; status?: number };

/** The request every transport receives: the method, the table-built path,
 *  and the JSON body when the verb takes one. */
export type AdminApiRequest = {
  body?: unknown;
  method: "DELETE" | "GET" | "POST" | "PUT";
  path: string;
};

export type AdminApiTransport = (
  options: AdminApiRequest,
) => Promise<AdminApiResponse>;

/** The server refused the request (a non-2xx status), or the transport
 *  failed before one existed. The message carries the status and the
 *  server's own error text. */
export class AdminApiError extends namedError("AdminApiError") {
  constructor(data: unknown, status: number | undefined) {
    super(AdminApiErrorMessage(data, status));
  }
}

const AdminApiErrorMessage = (data: unknown, status: number | undefined) => {
  const detail = (data as { error?: unknown } | undefined)?.error;
  if (typeof detail === "string") return `${detail} (status ${status})`;
  return `admin api request failed (status ${status})`;
};

/** Validate one success envelope, naming the resource and the rejected
 *  fields when the server answers something the contract does not describe. */
const parseEnvelope = <T>(
  resource: string,
  schema: v.GenericSchema<T>,
  data: unknown,
): T => {
  const result = v.safeParse(schema, data);
  if (!result.success) {
    const issues = result.issues
      .map(
        (issue) =>
          `${issue.path
            ?.map((item: { key: unknown }) => String(item.key))
            .join(".")}: ${issue.message}`,
      )
      .join("; ");
    throw new Error(
      `admin api ${resource} response failed validation: ${issues}`,
    );
  }
  return result.output;
};

/** Fail any non-2xx answer before any envelope validation runs. */
const refuseErrorStatus = (response: AdminApiResponse): void => {
  if (
    response.status !== undefined &&
    (response.status < 200 || response.status >= 300)
  ) {
    throw new AdminApiError(response.data, response.status);
  }
};

const rootPath = (entry: AdminApiResource, id: number): string =>
  `/api/admin/${entry.path}/${id}`;

/** One round trip: send the request, refuse a non-2xx answer, then validate
 *  the envelope. Every verb below shares this tail. */
const request = async <T>(
  transport: AdminApiTransport,
  resource: string,
  schema: v.GenericSchema<T>,
  options: AdminApiRequest,
): Promise<T> => {
  const response = await transport(options);
  refuseErrorStatus(response);
  return parseEnvelope(resource, schema, response.data);
};

/** The HTTP method each root verb answers with. */
const ROOT_METHODS = {
  create: "POST",
  list: "GET",
  update: "PUT",
} as const;

type RootVerb = keyof typeof ROOT_METHODS;

/** One root-resource call: the path follows the verb (the collection for
 *  list and create, the row's id segment for the rest). */
const rootCall = async <T>(
  transport: AdminApiTransport,
  entry: AdminApiResource,
  verb: RootVerb,
  schema: v.GenericSchema<T>,
  id: number | undefined,
  body: unknown,
): Promise<T> => {
  const path =
    verb === "list" || verb === "create"
      ? `/api/admin/${entry.path}`
      : rootPath(entry, id!);
  return request(transport, entry.path, schema, {
    body,
    method: ROOT_METHODS[verb],
    path,
  });
};

/** The row shape a resource's single envelope carries. */
type Row<E extends AdminApiResource> = v.InferOutput<E["singleSchema"]>;

/** The body a create sends: the entry's declared schema, or unknown when the
 *  resource carries none and the server owns the validation. */
type CreateBody<E extends AdminApiResource> =
  E["createBodySchema"] extends v.GenericSchema
    ? v.InferOutput<E["createBodySchema"]>
    : unknown;

/** The body an update sends, under the same rule. */
type UpdateBody<E extends AdminApiResource> =
  E["updateBodySchema"] extends v.GenericSchema
    ? v.InferOutput<E["updateBodySchema"]>
    : unknown;

/** List one resource: GET /api/admin/{path}. */
export const adminApiList = async <E extends AdminApiResource>(
  transport: AdminApiTransport,
  entry: E,
): Promise<v.InferOutput<E["listSchema"]>> =>
  rootCall(transport, entry, "list", entry.listSchema, undefined, undefined);

/** One write: POST creates on the collection, PUT updates the row. The body
 *  type follows the entry's declared schema for that verb. */
export const adminApiWrite = async <
  E extends AdminApiResource,
  V extends "create" | "update",
>(
  transport: AdminApiTransport,
  entry: E,
  verb: V,
  id: V extends "create" ? undefined : number,
  body: V extends "create" ? CreateBody<E> : UpdateBody<E>,
): Promise<Row<E>> =>
  rootCall(transport, entry, verb, entry.singleSchema, id, body);

const childEntry = (
  entry: AdminApiResource,
  childKey: string,
): AdminApiChild => {
  const child = entry.children?.[childKey];
  if (!child) {
    throw new Error(`admin api ${entry.path} has no ${childKey} child`);
  }
  return child;
};

const childPath = (
  entry: AdminApiResource,
  child: AdminApiChild,
  parentId: number,
): string => `/api/admin/${entry.path}/${parentId}/${child.path}`;

/** Create one child row: POST /api/admin/{path}/:parentId/{child}. The
 *  answer is the parent envelope — an option write answers with the whole
 *  attribute. */
export const adminApiChildCreate = async <
  E extends AdminApiResource & {
    children: Record<string, AdminApiChild>;
    label: string;
    path: string;
  },
  K extends keyof E["children"] & string,
>(
  transport: AdminApiTransport,
  entry: E,
  childKey: K,
  parentId: number,
  body: unknown,
): Promise<v.InferOutput<E["children"][K]["responseSchema"]>> => {
  const child = childEntry(entry, childKey);
  return request<v.InferOutput<E["children"][K]["responseSchema"]>>(
    transport,
    `${entry.label} ${childKey}`,
    child.responseSchema as v.GenericSchema<
      v.InferOutput<E["children"][K]["responseSchema"]>
    >,
    {
      body,
      method: "POST",
      path: childPath(entry, child, parentId),
    },
  );
};
