import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  ),
  source = path.join(root, "tools/ui/course-archive"),
  output = path.join(root, "src/ui/library/archive");
function run(file, args) {
  const result = spawnSync(file, args, {
    cwd: source,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) throw Error("Course archive build failed");
}
if (!fs.existsSync(path.join(source, "node_modules/vite")))
  throw Error(
    "Run npm ci --ignore-scripts in tools/ui/course-archive before building the archive.",
  );
run(process.execPath, ["node_modules/typescript/bin/tsc"]);
run(process.execPath, ["node_modules/vite/bin/vite.js", "build"]);
fs.mkdirSync(path.join(output, "assets"), { recursive: true });
run(process.execPath,["scripts/prepare-model.mjs",path.join(source,"public/assets/archive-cassette.glb"),path.join(output,"assets/archive-cassette.glb")]);
for (const file of ['archive-studio.bin.gz', 'archive-studio.json']) fs.copyFileSync(path.join(source, 'public/assets', file), path.join(output, 'assets', file));
fs.copyFileSync(path.join(source, "LICENSE"), path.join(output, "LICENSE.txt"));
console.log(
  "Course archive built with local assets; no account or course data bundled.",
);
