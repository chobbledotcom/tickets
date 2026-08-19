/** Embed data for a client script to read. The JSON has `<` escaped so no
 * payload text can close the script tag. */

import { Raw } from "#jsx/jsx-runtime.ts";

export const JsonScript = ({
  id,
  value,
}: {
  id: string;
  value: unknown;
}): JSX.Element => (
  <script id={id} type="application/json">
    <Raw html={JSON.stringify(value).replaceAll("<", "\\u003c")} />
  </script>
);
