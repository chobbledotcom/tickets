import type { Child } from "#jsx/jsx-runtime.ts";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import { settings } from "#shared/db/settings.ts";
import {
  flashConsumed,
  getFlash,
  getFlashFormId,
} from "#shared/flash-context.ts";
import { Flash } from "#shared/forms/flash.tsx";
import { appendIframeParam } from "#shared/iframe.ts";

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
    <input name="csrf_token" type="hidden" value={getCurrentCsrfToken()} />
    <input name="settings_version" type="hidden" value={settings.version} />
    {rest.id && rest.id === getFlashFormId() && !flashConsumed() && (
      <Flash error={getFlash().error} success={getFlash().success} />
    )}
    {children}
  </form>
);
