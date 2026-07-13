import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { IconName } from "#templates/components/actions.tsx";
import { saveFormComponent } from "#templates/components/save-form.tsx";

/** The shared body of an admin "create resource" new-page:
 *  `<CsrfForm action={action}><h1>{title}</h1><Raw html={fieldsHtml}/><SubmitButton icon={icon}>{submitLabel}</SubmitButton></CsrfForm>`.
 *  Several admin new-resource pages (groups, built-sites) pass exactly this
 *  shape to {@link errorAdminPage}; this helper builds it once so the form
 *  scaffold can't drift between call sites. Extra `children` (e.g. an agent
 *  selector) render between the fields and the submit button when given. */
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
