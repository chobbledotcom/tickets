/** A block under one bold line that names it. */

import type { Child } from "#jsx/jsx-runtime.ts";
import type { ChildProps } from "#templates/components/child-props.ts";

export const LabelledBlock = ({
  label,
  children,
}: ChildProps & { label: Child }): JSX.Element => (
  <>
    <p>
      <strong>{label}</strong>
    </p>
    {children}
  </>
);
