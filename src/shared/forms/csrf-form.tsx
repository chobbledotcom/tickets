import { settings } from "#db/settings.ts";
import type { Child } from "#jsx/jsx-runtime.ts";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import {
  flashConsumed,
  getFlash,
  getFlashFormId,
} from "#shared/flash-context.ts";
import { Flash } from "#shared/forms/flash.tsx";
import { appendIframeParam } from "#shared/request-context.ts";

export const CsrfForm = ({
  action,
  children,
  ...rest
}: {
  action: string;
  children?: Child;
  id?: string | undefined;
  class?: string | undefined;
  enctype?: string | undefined;
} & { [key: `data-${string}`]: string | boolean }): JSX.Element => (
  <form
    action={appendIframeParam(action)}
    autocomplete="off"
    method="POST"
    {...rest}
  >
    <input name="csrfToken" type="hidden" value={getCurrentCsrfToken()} />
    {(action.startsWith("/admin/settings") ||
      action.startsWith("/admin/features/") ||
      action === "/admin/listing-defaults") && (
      <input name="settingsVersion" type="hidden" value={settings.version} />
    )}
    {rest.id && rest.id === getFlashFormId() && !flashConsumed() && (
      <Flash error={getFlash().error} success={getFlash().success} />
    )}
    {children}
  </form>
);
