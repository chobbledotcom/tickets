import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { type HolidayInput, holidays } from "#shared/db/holidays.ts";
import type { FormValues } from "#shared/forms/definition.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import { getHolidayForm } from "#templates/fields/admin.ts";
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

describeWithEnv("owner CRUD handlers", { db: true }, () => {
  test("passes a rejected edit's submitted form to its error renderer", async () => {
    const holiday = await createTestHoliday();
    const crud = createOwnerCrudHandlers({
      getAll: holidays.getAll,
      getName: (row) => row.name,
      listPath: "/admin/holidays",
      renderDelete: () => "delete",
      renderEditError: (_id, _session, form, error) =>
        Promise.resolve(
          new Response(`${form.getString("name")} | ${error}`, { status: 400 }),
        ),
      renderList: () => "list",
      renderNew: () => "new",
      resource: defineNamedResource({
        form: getHolidayForm(),
        nameField: "name",
        table: holidays.table,
        toInput: toHolidayInput,
      }),
      singular: "Holiday",
    });
    const response = await crud.editPost(
      mockFormRequest(
        `/admin/holidays/${holiday.id}/edit`,
        { csrf_token: await testCsrfToken(), name: "Submitted holiday" },
        await testCookie(),
      ),
      { id: holiday.id },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Submitted holiday | Start Date is required",
    );
  });
});
