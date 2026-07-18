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

const crudFor = (operations: NamedOperations<Holiday>) =>
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
  test("passes a rejected edit's submitted form to its error renderer", async () => {
    const response = await rejectedEditResponse(holidayResource);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Submitted holiday | Start Date is required",
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
});
