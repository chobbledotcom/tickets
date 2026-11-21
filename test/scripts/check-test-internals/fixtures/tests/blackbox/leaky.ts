import { read } from "#test/scripts/check-test-internals/fixtures/src/app/db.ts";

export const leaked = (): number => read();
