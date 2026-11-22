import { read } from "#test/scripts/check-test-internals/fixtures/src/app/db.ts";
import { handle } from "#test/scripts/check-test-internals/fixtures/src/app/request.ts";
import { day } from "#test/scripts/check-test-internals/fixtures/src/pure/dates.ts";

export const total = (): number => read() + handle() + day();
