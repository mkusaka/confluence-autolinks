import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(repoRoot, "assets/icon.svg");
const outputDir = resolve(repoRoot, "public/icons");
const sizes = [16, 32, 48, 128];

mkdirSync(outputDir, { recursive: true });

for (const size of sizes) {
  const output = resolve(outputDir, `icon-${size}.png`);
  const result = spawnSync(
    "magick",
    ["-background", "none", source, "-resize", `${size}x${size}`, output],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to generate ${output}: ${result.stderr || result.stdout}`,
    );
  }
}
