import { sync } from "./prepare-dev.js";

if (import.meta.main) sync();

export { sync };
