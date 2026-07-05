/**
 * A single-form page: the base {@link Layout} wrapping a {@link CsrfForm} whose
 * `.prose` intro (heading + blurb) sits above the error flash, the form's own
 * fields, and a submit button. The setup and join pages both render this shell;
 * setup slots its country picker and agreement in as `children` between the
 * fields and the button.
 */

import { CsrfForm, Flash } from "#shared/forms.tsx";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";

export const IntroFormPage = ({
  pageTitle,
  action,
  heading,
  intro,
  error,
  fieldsHtml,
  submitLabel,
  children,
}: {
  pageTitle: string;
  action: string;
  heading: string;
  intro: string;
  error?: string;
  fieldsHtml: string;
  submitLabel: string;
  children?: Child;
}): string =>
  String(
    <Layout title={pageTitle}>
      <CsrfForm action={action}>
        <div class="prose">
          <h1>{heading}</h1>
          <p>{intro}</p>
        </div>
        <Flash error={error} />
        <Raw html={fieldsHtml} />
        {children}
        <button type="submit">{submitLabel}</button>
      </CsrfForm>
    </Layout>,
  );
