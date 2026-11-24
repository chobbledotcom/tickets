import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Answer, Api } from "#test/blackbox/api.ts";
import type { App, Page, Target } from "#test/blackbox/driver.ts";
import { addBooking, addListing, openApi } from "#test/blackbox/seed.ts";

const page = (
  status: number,
  html = "",
  location: string | null = null,
): Page => ({
  headers: new Headers(),
  html,
  location,
  status,
});

/** An owner whose keys page answers from `pages`, and whose target records
 * each request that it gets. */
const owner = (made: Page, pages: Record<string, string>) => {
  const requests: Request[] = [];
  const target: Target = (request) => {
    requests.push(request);
    return Promise.resolve(new Response("{}"));
  };
  const app: App = {
    cookieHeader: () => "",
    get: (path) => Promise.resolve(page(200, pages[path] ?? "")),
    logIn: () => Promise.resolve(page(302)),
    submit: () => Promise.resolve(made),
    target,
  };
  return { app, requests };
};

/** An API whose creates answer with `answer`, and which records the bodies. */
const answering = (answer: Answer) => {
  const posted: { body: unknown; path: string }[] = [];
  const api: Api = {
    delete: () => Promise.resolve(answer),
    get: () => Promise.resolve(answer),
    post: (path, body) => {
      posted.push({ body, path });
      return Promise.resolve(answer);
    },
    put: () => Promise.resolve(answer),
    statusOf: () => Promise.resolve(answer.status),
  };
  return { api, posted };
};

describe("openApi", () => {
  test("keeps the one key that the keys page shows, and sends it", async () => {
    const { app, requests } = owner(page(302, "", "/admin/api-keys?flash=1"), {
      "/admin/api-keys?flash=1": "<pre><code>abc_DEF-123</code></pre>",
    });
    const api = await openApi(app);
    await api.get("/api/admin/listings");
    expect(requests[0]!.headers.get("authorization")).toBe(
      "Bearer abc_DEF-123",
    );
  });

  test("fails when the key form is not answered with a redirect", async () => {
    const { app } = owner(page(422), {});
    await expect(openApi(app)).rejects.toThrow(
      "Making the API key answered 422, not a redirect.",
    );
  });

  test("fails when the keys page shows no key", async () => {
    const { app } = owner(page(302, "", "/admin/api-keys"), {
      "/admin/api-keys": "<p>no key</p>",
    });
    await expect(openApi(app, "reports")).rejects.toThrow(
      "The keys page shows no reports key.",
    );
  });
});

/** What `run` posts, and what it gives back, when the API answers with
 * `answer`. */
const postedBy = async <Result>(
  answer: Answer,
  run: (api: Api) => Promise<Result>,
) => {
  const { api, posted } = answering(answer);
  const result = await run(api);
  return { posted, result };
};

describe("addListing", () => {
  const made = { body: { listing: { id: 7, slug: "abc12" } }, status: 201 };

  test("sends a standard listing, and gives back its number and address", async () => {
    const { posted, result } = await postedBy(made, (api) =>
      addListing(api, { max_attendees: 5, name: "Quiz" }),
    );
    expect(result).toEqual({ id: 7, slug: "abc12" });
    expect(posted).toEqual([
      {
        body: { listing_type: "standard", max_attendees: 5, name: "Quiz" },
        path: "/api/admin/listings",
      },
    ]);
  });

  test("lets a field replace the default type", async () => {
    const { posted } = await postedBy(made, (api) =>
      addListing(api, {
        listing_type: "daily",
        max_attendees: 5,
        name: "Quiz",
      }),
    );
    expect(posted.map(({ body }) => body)).toEqual([
      { listing_type: "daily", max_attendees: 5, name: "Quiz" },
    ]);
  });

  test("fails and shows what the API said when it does not answer 201", async () => {
    const { api } = answering({
      body: { error: "name is required" },
      status: 400,
    });
    await expect(
      addListing(api, { max_attendees: 5, name: "" }),
    ).rejects.toThrow(
      'Adding the listing answered 400: {"error":"name is required"}',
    );
  });
});

describe("addBooking", () => {
  const listing = { id: 7, slug: "abc12" };
  const booked = { body: { attendee: { id: 41 } }, status: 201 };

  test("books the places for one person and gives back the booking number", async () => {
    const { posted, result } = await postedBy(booked, (api) =>
      addBooking(api, listing, { name: "Ada", quantity: 2 }),
    );
    expect(result).toBe(41);
    expect(posted).toEqual([
      {
        body: {
          email: "buyer@example.com",
          lines: [{ listingId: 7, quantity: 2 }],
          name: "Ada",
        },
        path: "/api/admin/attendees",
      },
    ]);
  });

  test("books one place with the given email by default", async () => {
    const { posted } = await postedBy(booked, (api) =>
      addBooking(api, listing, { email: "ada@example.com", name: "Ada" }),
    );
    expect(posted.map(({ body }) => body)).toEqual([
      {
        email: "ada@example.com",
        lines: [{ listingId: 7, quantity: 1 }],
        name: "Ada",
      },
    ]);
  });

  test("fails when the listing does not allow the quantity", async () => {
    const { api } = answering({
      body: { error: "lines[0].quantity is more than the listing allows" },
      status: 400,
    });
    await expect(
      addBooking(api, listing, { name: "Ada", quantity: 9 }),
    ).rejects.toThrow("Adding the booking answered 400");
  });
});
