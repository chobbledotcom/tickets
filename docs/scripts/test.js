import { prep } from "./prepare-dev.js";
import { bun, fs, path } from "./utils.js";

process.env.PLACEHOLDER_IMAGES = "1";

const templateTest = path(".build", "template", "test");
const devTest = path(".build", "dev", "test");
const dev = path(".build", "dev");
const submoduleToolkit = path("chobble-template", "packages", "js-toolkit");
const devToolkit = path(".build", "dev", "packages", "js-toolkit");

prep();

if (fs.exists(templateTest)) {
  console.log("Copying test directory...");
  fs.rm(devTest);
  fs.cp(templateTest, devTest);
}

if (fs.exists(submoduleToolkit)) {
  console.log("Syncing #toolkit from submodule...");
  fs.rm(devToolkit);
  fs.cp(submoduleToolkit, devToolkit);
}

console.log("Running tests...");
bun.test(dev);
