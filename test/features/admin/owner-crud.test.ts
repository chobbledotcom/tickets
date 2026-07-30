import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { type HolidayInput, holidays } from "#shared/db/holidays.ts";
import type { FormValues } from "#shared/forms/definition.ts";
import {
  defineNamedResource,
  type NamedOperations,
} from "#shared/rest/resource.ts";
import type { Holiday } from "#shared/types.ts";
import { getHolidayForm } from "#templates/fields/admin.ts";
import { wasActivityLogged } from "#test-utils/activity-log.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

type HolidayFormValues = FormValues<ReturnType<typeof getHolidayForm>>;

const toHolidayInput = (values: HolidayFormValues): HolidayInput => ({
  endDate: values.end_date,
  name: values.name,
  startDate: values.start_date,
});

const holidayResource = defineNamedResource({
  form: getHolidayForm(),
  nameField: "name",
  table: holidays.table,
  toInput: toHolidayInput,
});

const crudFor = (
  operations: NamedOperations<Holiday>,
  options: {
    activityName?: string;
    deleteGuard?: (row: Holiday, id: number) => Promise<string | null>;
    identifierLabel?: string;
  } = {},
) =>
  createOwnerCrudHandlers({
    getAll: holidays.getAll,
    getName: (row) => row.name,
    listPath: "/admin/holidays",
    operations,
    renderDelete: () => "delete",
    renderEditError: (_id, _session, form, error) =>
      Promise.resolve(
        new Response(`${form.getString("name")} | ${error}`, { status: 400 }),
      ),
    renderList: () => "list",
    renderNew: () => "new",
    singular: "Holiday",
    ...options,
  });

const validHolidayFields = async (name: string) => ({
  csrf_token: await testCsrfToken(),
  end_date: "2027-02-02",
  name,
  start_date: "2027-02-01",
});

const rejectedEditResponse = async (
  operations: NamedOperations<Holiday>,
): Promise<Response> => {
  const holiday = await createTestHoliday();
  return crudFor(operations).editPost(
    mockFormRequest(
      `/admin/holidays/${holiday.id}/edit`,
      { csrf_token: await testCsrfToken(), name: "Submitted holiday" },
      await testCookie(),
    ),
    { id: holiday.id },
  );
};

describeWithEnv("owner CRUD handlers", { db: true }, () => {
  test("logs and redirects a successful create", async () => {
    const response = await crudFor(holidayResource, {
      activityName: "Closure",
    }).createPost(
      mockFormRequest(
        "/admin/holidays",
        await validHolidayFields("Created holiday"),
        await testCookie(),
      ),
    );

    expectRedirectWithFlash(
      "/admin/holidays",
      "Holiday created",
      true,
    )(response);
    expect(await wasActivityLogged("Closure 'Created holiday' created")).toBe(
      true,
    );
  });

  test("logs and redirects a successful edit", async () => {
    const holiday = await createTestHoliday();
    const response = await crudFor(holidayResource).editPost(
      mockFormRequest(
        `/admin/holidays/${holiday.id}/edit`,
        await validHolidayFields("Updated holiday"),
        await testCookie(),
      ),
      { id: holiday.id },
    );

    expectRedirectWithFlash(
      "/admin/holidays",
      "Holiday updated",
      true,
    )(response);
    expect(await wasActivityLogged("Holiday 'Updated holiday' updated")).toBe(
      true,
    );
  });

  test("passes a rejected edit's submitted form to its error renderer", async () => {
    const response = await rejectedEditResponse(holidayResource);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Submitted holiday | Start date is required",
    );
  });

  test("renders an operation error for a rejected edit", async () => {
    const response = await rejectedEditResponse({
      ...holidayResource,
      update: () =>
        Promise.resolve({ error: "The holiday cannot be changed", ok: false }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Submitted holiday | The holiday cannot be changed",
    );
  });

  test("returns a confirmed operation error to the delete page", async () => {
    const holiday = await createTestHoliday();
    const crud = crudFor({
      ...holidayResource,
      delete: () =>
        Promise.resolve({ error: "The holiday is still in use", ok: false }),
    });
    const path = `/admin/holidays/${holiday.id}/delete`;
    const response = await crud.deletePost(
      mockFormRequest(
        path,
        {
          confirm_identifier: holiday.name,
          csrf_token: await testCsrfToken(),
        },
        await testCookie(),
      ),
      { id: holiday.id },
    );

    expectRedirectWithFlash(
      path,
      "The holiday is still in use",
      false,
    )(response);
  });

  test("returns not found when a loaded row disappears before deletion", async () => {
    const holiday = await createTestHoliday();
    const crud = crudFor({
      ...holidayResource,
      delete: () => Promise.resolve({ notFound: true, ok: false }),
    });
    const response = await crud.deletePost(
      mockFormRequest(
        `/admin/holidays/${holiday.id}/delete`,
        {
          confirm_identifier: holiday.name,
          csrf_token: await testCsrfToken(),
        },
        await testCookie(),
      ),
      { id: holiday.id },
    );

    expect(response.status).toBe(404);
    expect(await wasActivityLogged(`Holiday '${holiday.name}' deleted`)).toBe(
      false,
    );
  });

  test("logs and redirects a successful deletion", async () => {
    const holiday = await createTestHoliday();
    const response = await crudFor(holidayResource).deletePost(
      mockFormRequest(
        `/admin/holidays/${holiday.id}/delete`,
        {
          confirm_identifier: holiday.name,
          csrf_token: await testCsrfToken(),
        },
        await testCookie(),
      ),
      { id: holiday.id },
    );

    expectRedirectWithFlash(
      "/admin/holidays",
      "Holiday deleted",
      true,
    )(response);
    expect(await wasActivityLogged(`Holiday '${holiday.name}' deleted`)).toBe(
      true,
    );
  });

  test("blocks deletion when its guard rejects the row", async () => {
    const holiday = await createTestHoliday();
    const path = `/admin/holidays/${holiday.id}/delete`;
    const response = await crudFor(holidayResource, {
      deleteGuard: () => Promise.resolve("This holiday is protected"),
    }).deletePost(
      mockFormRequest(
        path,
        {
          confirm_identifier: holiday.name,
          csrf_token: await testCsrfToken(),
        },
        await testCookie(),
      ),
      { id: holiday.id },
    );

    expectRedirectWithFlash(path, "This holiday is protected", false)(response);
    expect(await holidays.table.findById(holiday.id)).toEqual(holiday);
  });

  test("uses the configured identifier label for a mismatch", async () => {
    const holiday = await createTestHoliday();
    const path = `/admin/holidays/${holiday.id}/delete`;
    const response = await crudFor(holidayResource, {
      identifierLabel: "Closure label",
    }).deletePost(
      mockFormRequest(
        path,
        {
          confirm_identifier: "Wrong name",
          csrf_token: await testCsrfToken(),
        },
        await testCookie(),
      ),
      { id: holiday.id },
    );

    expectRedirectWithFlash(
      path,
      "Closure label does not match. Please type the exact closure label to confirm deletion.",
      false,
    )(response);
  });
});
