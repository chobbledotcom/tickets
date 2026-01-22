/**
 * Setup page templates - initial configuration
 */

import { renderError, renderFields } from "#lib/forms.ts";
import { setupFields } from "./fields.ts";
import { layout } from "./layout.ts";

/**
 * Initial setup page
 */
export const setupPage = (error?: string, csrfToken?: string): string =>
  layout(
    "Setup",
    `
    <h1>Initial Setup</h1>
    <p>Welcome! Please configure your ticket reservation system.</p>
    ${renderError(error)}
    <form method="POST" action="/setup/">
      ${csrfToken ? `<input type="hidden" name="csrf_token" value="${csrfToken}">` : ""}
      ${renderFields(setupFields, { currency_code: "GBP" })}
      <button type="submit">Complete Setup</button>
    </form>
  `,
  );

/**
 * Setup complete page
 */
export const setupCompletePage = (): string =>
  layout(
    "Setup Complete",
    `
    <h1>Setup Complete!</h1>
    <div class="success">
      <p>Your ticket reservation system has been configured successfully.</p>
    </div>
    <p><a href="/admin/">Go to Admin Dashboard</a></p>
  `,
  );
