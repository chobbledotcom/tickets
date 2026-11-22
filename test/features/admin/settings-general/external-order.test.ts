import { settings } from "#db/settings.ts";
import { describeBooleanSetting } from "#test-utils/setting-toggle.ts";

describeBooleanSetting({
  disabledFlash: "External order buttons disabled",
  enabledFlash: "External order buttons enabled",
  field: "externalOrderEnabled",
  isEnabled: () => settings.externalOrderEnabled,
  label: "external order buttons",
  name: "external-order",
  path: "/admin/settings/external-order",
  question: "Enable external order buttons?",
});
