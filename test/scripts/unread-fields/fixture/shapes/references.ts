/** Shapes that hand fields on through named and asynchronous values. */
export const references = `
interface NamedDetail {
  readDeep: number;
  unreadDeep: number;
}

interface NamedHolder {
  detail: NamedDetail;
}

export type BorrowsNested = NamedHolder;

export interface ReadsAnAsyncResult {
  validate(): Promise<{ error: string } | { value: number }>;
}
`;
