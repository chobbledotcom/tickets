import { watch } from "node:fs";
import { sync } from "./prepare-dev.js";
import { debounce, root } from "./utils.js";

const ignored = [".build", ".direnv", "node_modules", ".git"];

const debouncedSync = debounce(sync, 5000);

watch(root, { recursive: true }, (_, file) => {
  if (!file || ignored.some((p) => file.startsWith(p))) return;
  debouncedSync();
});

console.log(`Watching ${root}...`);
