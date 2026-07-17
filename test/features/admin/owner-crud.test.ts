import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { type HolidayInput, holidays } from "#shared/db/holidays.ts";
import type { FormValues } from "#shared/forms/definition.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import { getHolidayForm } from "#templates/fields/admin.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { testCookie } from "#test-utils/session.ts";

type HolidayFormValues = FormValues<ReturnType<typeof getHolidayForm>>;

const toHolidayInput = (values: HolidayFormValues): HolidayInput => ({
  endDate: values.end_date,
  name: values.name,
  startDate: values.start_date,
});

describeWithEnv("owner CRUD handlers", { db: true }, () => {
  test("renders a configured edit page for the loaded row", async () => {
    const holiday = await createTestHoliday({ name: "Factory holiday" });
    const resource = defineNamedResource({
      form: getHolidayForm(),
      nameField: "name",
      table: holidays.table,
      toInput: toHolidayInput,
    });
    const crud = createOwnerCrudHandlers({
      getAll: holidays.getAll,
      getName: (row) => row.name,
      listPath: "/admin/holidays",
      renderDelete: () => "delete",
      renderEdit: (row) => `Edit ${row.name}`,
      renderList: () => "list",
      renderNew: () => "new",
      resource,
      singular: "Holiday",
    });
    if (!crud.editGet) throw new Error("Expected an edit GET handler");

    const response = await crud.editGet(
      mockRequest(`/admin/holidays/${holiday.id}/edit`, {
        headers: { cookie: await testCookie() },
      }),
      { id: holiday.id },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Edit Factory holiday");
  });
});
