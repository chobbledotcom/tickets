import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import type { IconName } from "#templates/components/actions.tsx";
import { saveFormComponent } from "#templates/components/save-form.tsx";

/** The shared body of an admin "create resource" new-page: a {@link SaveForm}
 *  wrapping `<h1>{title}</h1>` and the rendered fields, with the submit
 *  icon/label from `submitIcon`/`submitLabel`. Built from {@link saveFormComponent}
 *  so the form scaffold lives in one place. Several admin new-resource pages
 *  (groups, built-sites) pass exactly this shape to {@link errorAdminPage}.
 *  Extra `children` (e.g. an agent selector) render between the fields and the
 *  submit button when given. */
export const NewResourceForm = saveFormComponent<{
  action: string;
  children?: Child;
  fieldsHtml: string;
  id?: string;
  submitLabel: string;
  submitIcon?: IconName;
  title: string;
}>(({ children, fieldsHtml, submitIcon = "plus", submitLabel, title }) => ({
  children: (
    <>
      <h1>{title}</h1>
      <Raw html={fieldsHtml} />
      {children}
    </>
  ),
  submitIcon,
  submitLabel,
}));
