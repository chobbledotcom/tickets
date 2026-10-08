import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  AdminApiError,
  type AdminApiResponse,
  type AdminApiTransport,
  adminApiChildCreate,
  adminApiList,
  adminApiWrite,
} from "#shared/admin-api-client.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";

const ATTRIBUTE = {
  id: 3,
  name: "Game Length",
  options: [{ attribute_id: 3, id: 8, sort_order: 0, text: "15-20 minutes" }],
  sort_order: 0,
};

/** A transport that answers every call with one canned body and records the
 *  requests, so the tests can pin the paths and methods the client builds. */
const stubTransport = (
  body: unknown,
  status = 200,
): {
  calls: { method: string; path: string }[];
  transport: AdminApiTransport;
} => {
  const calls: { method: string; path: string }[] = [];
  const transport: AdminApiTransport = (options) => {
    calls.push({ method: options.method, path: options.path });
    return Promise.resolve({ data: body, status } as AdminApiResponse);
  };
  return { calls, transport };
};

describe("admin api client", () => {
  test("list builds the table's path and validates the envelope", async () => {
    const { calls, transport } = stubTransport({
      attributes: [ATTRIBUTE],
    });
    const listed = await adminApiList(
      transport,
      ADMIN_API_RESOURCES.attributes,
    );
    expect(calls).toEqual([{ method: "GET", path: "/api/admin/attributes" }]);
    expect(listed.attributes[0]!.name).toBe("Game Length");
  });

  test("create sends the body and validates the single envelope", async () => {
    const { calls, transport } = stubTransport({ attribute: ATTRIBUTE });
    const created = await adminApiWrite(
      transport,
      ADMIN_API_RESOURCES.attributes,
      "create",
      undefined,
      { name: "Game Length" },
    );
    expect(calls).toEqual([{ method: "POST", path: "/api/admin/attributes" }]);
    expect(created.attribute.id).toBe(3);
  });

  test("update builds the id path", async () => {
    const updated = stubTransport({ attribute: ATTRIBUTE });
    await adminApiWrite(
      updated.transport,
      ADMIN_API_RESOURCES.attributes,
      "update",
      3,
      { name: "Renamed" },
    );
    expect(updated.calls).toEqual([
      { method: "PUT", path: "/api/admin/attributes/3" },
    ]);
  });

  test("child verbs build the parent and child id paths", async () => {
    const created = stubTransport({ attribute: ATTRIBUTE });
    await adminApiChildCreate(
      created.transport,
      ADMIN_API_RESOURCES.attributes,
      "options",
      3,
      { text: "20-30 minutes" },
    );
    expect(created.calls).toEqual([
      { method: "POST", path: "/api/admin/attributes/3/options" },
    ]);
  });

  test("a malformed response throws with the resource and field named", async () => {
    const { transport } = stubTransport({
      attributes: [{ id: "not-a-number" }],
    });
    const failure = await adminApiList(
      transport,
      ADMIN_API_RESOURCES.attributes,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "admin api attributes response failed validation",
    );
    expect((failure as Error).message).toContain("attributes.0.id");
  });

  test("a non-2xx status throws AdminApiError with the server's message", async () => {
    const { transport } = stubTransport({ error: "kaboom" }, 418);
    const failure = await adminApiChildCreate(
      transport,
      ADMIN_API_RESOURCES.attributes,
      "options",
      3,
      {},
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminApiError);
    expect((failure as Error).message).toBe("kaboom (status 418)");
  });

  test("a non-2xx answer without an error string names the status alone", async () => {
    const { transport } = stubTransport({ detail: "nope" }, 500);
    const failure = await adminApiList(
      transport,
      ADMIN_API_RESOURCES.attributes,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminApiError);
    expect((failure as Error).message).toBe(
      "admin api request failed (status 500)",
    );
  });

  test("a 3xx or 304 status throws before the envelope validates", async () => {
    const redirected = stubTransport({ attributes: [ATTRIBUTE] }, 302);
    const failure = await adminApiList(
      redirected.transport,
      ADMIN_API_RESOURCES.attributes,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminApiError);
    expect((failure as Error).message).toBe(
      "admin api request failed (status 302)",
    );

    const notModified = stubTransport({ attributes: [ATTRIBUTE] }, 304);
    const cached = await adminApiList(
      notModified.transport,
      ADMIN_API_RESOURCES.attributes,
    ).catch((error: unknown) => error);
    expect(cached).toBeInstanceOf(AdminApiError);
    expect((cached as Error).message).toBe(
      "admin api request failed (status 304)",
    );
  });

  test("an unknown child key throws instead of building a path", async () => {
    const { transport } = stubTransport({ attribute: ATTRIBUTE });
    const childFailure = await adminApiChildCreate(
      transport,
      ADMIN_API_RESOURCES.attributes,
      // The table has one child today; the runtime guard is for a caller
      // that names a child the entry does not declare.
      "nonexistent" as keyof typeof ADMIN_API_RESOURCES.attributes.children,
      3,
      {},
    ).catch((error: unknown) => error);
    expect((childFailure as Error).message).toBe(
      "admin api attributes has no nonexistent child",
    );
  });
});
