import { join } from "node:path";
import { buildDir, templateRepo } from "./consts.js";
import { bun, copyDir, find, fs, git, path, root } from "./utils.js";

const build = path(buildDir);
const template = path(buildDir, "template");
const dev = path(buildDir, "dev");
const localTemplate = join(root, "..", "chobble-template");

const templateExcludes = [
	".git",
	".direnv",
	"node_modules",
	"*.md",
	"test",
	"test-*",
	".image-cache",
	"landing-pages",
];
const rootExcludes = [
	".git",
	".direnv",
	"*.nix",
	"README.md",
	buildDir,
	"scripts",
	"node_modules",
	"package*.json",
	"bun.lock",
	"old_site",
	...(process.env.PLACEHOLDER_IMAGES === "1" ? ["images"] : []),
];

export const prep = () => {
	console.log("Preparing build...");
	fs.mkdir(build);

	if (fs.exists(localTemplate)) {
		console.log("Using local template from ../chobble-template...");
		copyDir(localTemplate, template, {
			delete: true,
			exclude: templateExcludes,
		});
	} else if (!fs.exists(join(template, ".git"))) {
		console.log("Cloning template...");
		fs.rm(template);
		git.clone(templateRepo, template);
	} else {
		console.log("Updating template...");
		git.reset(template, { hard: true });
		git.pull(template);
	}

	find.deleteByExt(dev, ".md");
	copyDir(template, dev, { delete: true, exclude: templateExcludes });
	copyDir(root, join(dev, "src"), { exclude: rootExcludes });

	sync();

	if (!fs.exists(join(dev, "node_modules"))) {
		console.log("Installing dependencies...");
		bun.install(dev);
	}

	fs.rm(join(dev, "_site"));
	console.log("Build ready.");
};

export const sync = () => {
	copyDir(root, join(dev, "src"), {
		update: true,
		exclude: rootExcludes,
	});
};

if (import.meta.main) prep();
