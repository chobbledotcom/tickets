import { CsrfForm, Flash } from "#shared/forms.tsx";
import { RECALCULATE_FIELD_NAME } from "#shared/recalculate-fields.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

export type RecalculateRow = {
  current: string;
  label: string;
  name: string;
  recalculated: string;
};

export const adminRecalculatePage = ({
  action,
  active,
  currentLabel,
  description,
  error,
  recalculatedLabel,
  rows,
  session,
  success,
  submitLabel,
  title,
}: {
  action: string;
  active: string;
  currentLabel: string;
  description: string;
  error?: string;
  recalculatedLabel: string;
  rows: RecalculateRow[];
  session: AdminSession;
  success?: string;
  submitLabel: string;
  title: string;
}): string =>
  String(
    <Layout title={title}>
      <AdminNav active={active} session={session} />
      <CsrfForm action={action}>
        <h1>{title}</h1>
        <Flash error={error} success={success} />
        <div class="prose">
          <p>{description}</p>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>{currentLabel}</th>
                <th>{recalculatedLabel}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr>
                  <th>
                    <label>
                      <input
                        name={RECALCULATE_FIELD_NAME}
                        type="checkbox"
                        value={row.name}
                      />{" "}
                      {row.label}
                    </label>
                  </th>
                  <td>{row.current}</td>
                  <td>{row.recalculated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <SubmitButton icon="save">{submitLabel}</SubmitButton>
      </CsrfForm>
    </Layout>,
  );
