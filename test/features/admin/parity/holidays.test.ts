// Behaviour pins for the holiday resource: what each surface answers today,
// one test per fact. The page posts to /admin/holidays (owner-only form
// routes); the JSON API posts to /api/admin/holidays (OWNER_API).
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { holidays } from "#db/holidays.ts";
import { t } from "#i18n";
import { assertJson, expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestManagerSession } from "#test-utils/session.ts";
import {
  apiPostAs,
  ownerApiPost,
  ownerApiPut,
  ownerPagePost,
  pagePostAs,
} from "./helpers.ts";

describeWithEnv("Holiday parity pins", { db: true }, () => {
  const storedHoliday = async () => {
    const all = await holidays.getAll();
    const row = all[all.length - 1];
    if (!row) throw new Error("the create stored no holiday");
    return row;
  };

  test("page create stores the posted dates and name", async () => {
    const response = await ownerPagePost("/admin/holidays", {
      end_date: "2027-01-02",
      name: "Pinned Page Holiday",
      start_date: "2027-01-01",
    });
    expect(response.status).toBe(302);

    const row = await storedHoliday();
    expect(row.name).toBe("Pinned Page Holiday");
    expect(row.start_date).toBe("2027-01-01");
    expect(row.end_date).toBe("2027-01-02");
  });

  test("page create refuses end before start with the shared message", async () => {
    const response = await ownerPagePost("/admin/holidays", {
      end_date: "2027-01-01",
      name: "Backwards Page Holiday",
      start_date: "2027-01-02",
    });
    // A failed page create redirects back to the new page with the error in
    // the flash; it does not write the row.
    expectRedirectWithFlash(
      "/admin/holidays/new",
      t("error.end_date_before_start"),
      false,
    )(response);
    const all = await holidays.getAll();
    expect(
      all.find((h) => h.name === "Backwards Page Holiday"),
    ).toBeUndefined();
  });

  test("api create stores the posted dates and name", async () => {
    await assertJson(
      ownerApiPost("/api/admin/holidays", {
        end_date: "2027-02-02",
        name: "Pinned Api Holiday",
        start_date: "2027-02-01",
      }),
      201,
      (body) => {
        expect(body.holiday.name).toBe("Pinned Api Holiday");
        expect(body.holiday.start_date).toBe("2027-02-01");
        expect(body.holiday.end_date).toBe("2027-02-02");
      },
    );
  });

  test("api create refuses a missing name with the field message", async () => {
    await assertJson(
      ownerApiPost("/api/admin/holidays", {
        end_date: "2027-02-02",
        start_date: "2027-02-01",
      }),
      400,
      (body) => {
        expect(body.error).toBe("name is required");
      },
    );
  });

  test("api create refuses a non-text date with the field message", async () => {
    await assertJson(
      ownerApiPost("/api/admin/holidays", {
        end_date: "2027-02-02",
        name: "Pinned Create Date Type",
        start_date: 20270201,
      }),
      400,
      (body) => {
        expect(body.error).toBe("start_date has an invalid value");
      },
    );
  });

  test("api update refuses end before start with the shared message", async () => {
    const created = await assertJson<{ holiday: { id: number } }>(
      ownerApiPost("/api/admin/holidays", {
        end_date: "2027-03-02",
        name: "Pinned Update Holiday",
        start_date: "2027-03-01",
      }),
      201,
    );
    await assertJson(
      ownerApiPut(`/api/admin/holidays/${created.holiday.id}`, {
        start_date: "2027-03-03",
      }),
      400,
      (body) => {
        expect(body.error).toBe(t("error.end_date_before_start"));
      },
    );
  });

  // Recorded for #2476: parseUpdateName coerces a non-string name into
  // stored text.
  test("api update coerces a non-string name into text", async () => {
    const created = await assertJson<{ holiday: { id: number } }>(
      ownerApiPost("/api/admin/holidays", {
        end_date: "2027-04-02",
        name: "Pinned Coercion Holiday",
        start_date: "2027-04-01",
      }),
      201,
    );
    await assertJson(
      ownerApiPut(`/api/admin/holidays/${created.holiday.id}`, { name: 123 }),
      200,
      (body) => {
        expect(body.holiday.name).toBe("123");
      },
    );
  });

  // L1's named behaviour change: a non-text date is refused instead of
  // coerced into stored text. The create and update mappers answer the same
  // body with the same field-named message, whichever name rule runs.
  test("api update refuses a non-text date with the field message", async () => {
    const created = await assertJson<{ holiday: { id: number } }>(
      ownerApiPost("/api/admin/holidays", {
        end_date: "2027-06-02",
        name: "Pinned Date Type Holiday",
        start_date: "2027-06-01",
      }),
      201,
    );
    await assertJson(
      ownerApiPut(`/api/admin/holidays/${created.holiday.id}`, {
        name: 123,
        start_date: 20270603,
      }),
      400,
      (body) => {
        expect(body.error).toBe("start_date has an invalid value");
      },
    );
    // The refused update stored nothing: the stored dates stand.
    const all = await holidays.getAll();
    const row = all.find((h) => h.name === "Pinned Date Type Holiday");
    expect(row?.start_date).toBe("2027-06-01");
    expect(row?.end_date).toBe("2027-06-02");
  });

  test("api update keeps the stored dates when none are supplied", async () => {
    const created = await assertJson<{ holiday: { id: number } }>(
      ownerApiPost("/api/admin/holidays", {
        end_date: "2027-07-02",
        name: "Pinned Merge Holiday",
        start_date: "2027-07-01",
      }),
      201,
    );
    await assertJson(
      ownerApiPut(`/api/admin/holidays/${created.holiday.id}`, {
        name: "Pinned Merge Holiday Renamed",
      }),
      200,
      (body) => {
        expect(body.holiday.name).toBe("Pinned Merge Holiday Renamed");
        expect(body.holiday.start_date).toBe("2027-07-01");
        expect(body.holiday.end_date).toBe("2027-07-02");
      },
    );
  });

  test("a manager is refused on both surfaces", async () => {
    const managerCookie = await createTestManagerSession();
    const api = await apiPostAs(
      "/api/admin/holidays",
      {
        end_date: "2027-05-02",
        name: "Manager Api Holiday",
        start_date: "2027-05-01",
      },
      managerCookie,
    );
    expect(api.status).toBe(403);

    // A valid CSRF token, so the 403 is the role gate, not a token failure.
    const page = await pagePostAs(
      "/admin/holidays",
      {
        end_date: "2027-05-02",
        name: "Manager Page Holiday",
        start_date: "2027-05-01",
      },
      managerCookie,
    );
    expect(page.status).toBe(403);
  });
});
