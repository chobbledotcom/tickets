import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { formGuard, type Guard, OWNER_FORM } from "#routes/auth.ts";
import {
  createEntityHandler,
  createIdEntityHandler,
  throughParent,
} from "#routes/entity.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import {
  createTestManagerSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

type Params = { id: number };

describeWithEnv("entity route handlers", { db: true }, () => {
  test("builds context from a child loaded through its parent", async () => {
    expect(
      await throughParent(
        Promise.resolve({ children: [3, 7] }),
        (parent) => `${parent.children.length}:${parent.children[1]}`,
      ),
    ).toBe("2:7");
  });

  test("does not load a child when its parent is missing", async () => {
    let loadedChild = false;
    const found = await throughParent(Promise.resolve(null), () => {
      loadedChild = true;
      return 1;
    });

    expect(found).toBeNull();
    expect(loadedChild).toBe(false);
  });

  test("loads a child when its parent is zero", async () => {
    let loadedParent: number | null = null;

    const found = await throughParent(Promise.resolve(0), (parent) => {
      loadedParent = parent;
      return "child";
    });

    expect(found).toBe("child");
    expect(loadedParent).toBe(0);
  });

  test("returns null when the parent does not contain the child", async () => {
    expect(
      await throughParent(Promise.resolve({ id: 1 }), () => null),
    ).toBeNull();
  });

  test("runs the auth gate before loading the entity", async () => {
    const calls: string[] = [];
    const blocked: Guard<[role: string]> = (_request, _handle) => {
      calls.push("auth");
      return Promise.resolve(new Response("blocked", { status: 403 }));
    };
    const route = createEntityHandler<Params, { id: number }>((params) => {
      calls.push("load");
      return Promise.resolve({ id: params.id });
    })(blocked)(() => {
      calls.push("handle");
      return new Response("handled");
    });

    const response = await route(mockRequest("/admin/items/7"), { id: 7 });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("blocked");
    expect(calls).toEqual(["auth"]);
  });

  test("does not load an owner entity for a lower role", async () => {
    let loadCount = 0;
    const route = createEntityHandler<Params, { id: number }>((params) => {
      loadCount += 1;
      return Promise.resolve({ id: params.id });
    })(formGuard(OWNER_FORM))(() => new Response("handled"));
    const managerCookie = await createTestManagerSession();

    const response = await route(
      new Request("http://localhost/admin/items/8", {
        headers: { cookie: managerCookie },
        method: "POST",
      }),
      { id: 8 },
    );

    expect(response.status).toBe(403);
    expect(loadCount).toBe(0);
  });

  test("returns 404 without running the action when the entity is missing", async () => {
    let handled = false;
    const allow: Guard<[label: string]> = (_request, handle) =>
      Promise.resolve(handle("allowed"));
    const route = createEntityHandler<Params, { id: number }>(() =>
      Promise.resolve(null),
    )(allow)(() => {
      handled = true;
      return new Response("handled");
    });

    const response = await route(mockRequest("/admin/items/99"), { id: 99 });

    expect(response.status).toBe(404);
    expect(handled).toBe(false);
  });

  test("loads an id route from its id param", async () => {
    const allow: Guard<[]> = (_request, handle) => Promise.resolve(handle());
    const route = createIdEntityHandler((id) =>
      Promise.resolve({ id: id * 2 }),
    )(allow)((entity) => new Response(String(entity.id)));

    const response = await route(mockRequest("/admin/items/6"), { id: 6 });

    expect(await response.text()).toBe("12");
  });

  test("passes the entity, auth values, request, and params to the action", async () => {
    const cookie = await testCookie();
    const csrfToken = await testCsrfToken();
    const route = createEntityHandler<Params, { id: number; name: string }>(
      ({ id }) => Promise.resolve({ id, name: "Loaded" }),
    )(formGuard(OWNER_FORM))(
      (entity, session, form, request, params) =>
        new Response(
          [
            entity.id,
            entity.name,
            session.adminLevel,
            form.getString("value"),
            new URL(request.url).pathname,
            params.id,
          ].join(":"),
        ),
    );

    const response = await route(
      mockFormRequest(
        "/admin/items/12",
        { csrf_token: csrfToken, value: "saved" },
        cookie,
      ),
      { id: 12 },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      "12:Loaded:owner:saved:/admin/items/12:12",
    );
  });
});
