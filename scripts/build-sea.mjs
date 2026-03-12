import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build as esbuild } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const seaDir = join(distDir, "sea");

mkdirSync(seaDir, { recursive: true });

const bundlePath = join(seaDir, "main.cjs");
const blobPath = join(seaDir, "sea-prep.blob");
const outputName = getOutputName();
const outputPath = join(distDir, outputName);
const baseRuntimePath = process.env.SEA_BASE_BINARY || process.execPath;

runTypeScriptBuild();
await runSeaBundle();

writeFileSync(
  join(seaDir, "sea-config.json"),
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);

execFileSync(
  process.execPath,
  ["--experimental-sea-config", join(seaDir, "sea-config.json")],
  { cwd: root, stdio: "inherit" },
);

if (existsSync(outputPath)) {
  chmodSync(outputPath, 0o755);
  rmSync(outputPath, { force: true });
}

copyFileSync(baseRuntimePath, outputPath);
chmodSync(outputPath, 0o755);

const postjectArgs = [
  outputPath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];

if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}

execFileSync(
  process.execPath,
  [join(root, "node_modules", "postject", "dist", "cli.js"), ...postjectArgs],
  { cwd: root, stdio: "inherit" },
);

console.log(`SEA executable created: ${outputPath}`);
console.log(`SEA base runtime: ${baseRuntimePath}`);

function runTypeScriptBuild() {
  execFileSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    { cwd: root, stdio: "inherit" },
  );
}

async function runSeaBundle() {
  await esbuild({
    absWorkingDir: root,
    entryPoints: ["src/sea-main.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: bundlePath,
  });
}

function getOutputName() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "mermaid-fixer-mac-arm64";
  }
  if (process.platform === "darwin") {
    return "mermaid-fixer-mac-x64";
  }
  if (process.platform === "win32") {
    return "mermaid-fixer-windows-x64.exe";
  }
  return "mermaid-fixer-linux-x64";
}
