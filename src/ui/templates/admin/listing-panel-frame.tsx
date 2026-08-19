import type { Child } from "#jsx/jsx-runtime.ts";
import type { ListingWithCount } from "#types";

export type ListingPanelProps = {
  listing: ListingWithCount;
};

const ListingPanelFrame = ({
  children,
  footer,
  heading,
}: {
  children: Child;
  footer: Child;
  heading: string;
}): JSX.Element => (
  <>
    <h1>{heading}</h1>
    {children}
    {footer}
  </>
);

export const listingChoicePanel = <T,>(
  heading: string,
  footer: Child,
  items: T[],
  renderEmpty: () => Child,
  renderItems: (items: T[]) => Child,
): JSX.Element => (
  <ListingPanelFrame footer={footer} heading={heading}>
    {items.length === 0 ? renderEmpty() : renderItems(items)}
  </ListingPanelFrame>
);
