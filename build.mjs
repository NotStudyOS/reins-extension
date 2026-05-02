import { build, context } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Builds the Chrome MV3 extension.
 *
 * Three artifacts:
 *   1. background service worker (esbuild, esm, browser target)
 *   2. popup React app (esbuild, esm, browser target)
 *   3. popup tailwind CSS (@tailwindcss/cli)
 *
 * All land in `chrome/` alongside copied static assets (manifest, html, icon).
 */

const watch = process.argv.includes("--watch");
const dev = process.argv.includes("--dev") || watch;

const targets = [
  { outDir: resolve("chrome"), entry: "src/entry.chrome.ts", manifest: "src/manifest.chrome.json" },
];

for (const t of targets) {
  if (!watch) rmSync(t.outDir, { recursive: true, force: true });
  mkdirSync(t.outDir, { recursive: true });

  const common = {
    entryPoints: {
      background: t.entry,
      popup: "src/popup/main.tsx",
    },
    outdir: t.outDir,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: ["chrome114"],
    sourcemap: dev,
    sourcesContent: dev,
    jsx: "automatic",
    loader: { ".css": "empty" },
    logLevel: "info",
  };

  if (watch) {
    const ctx = await context(common);
    await ctx.watch();
  } else {
    await build(common);
  }

  // Tailwind CSS for the popup. Single-pass build; watcher reruns
  // tailwind on every esbuild rebuild instead of running its own watcher.
  const cssCmd = `npx @tailwindcss/cli -i src/popup/globals.css -o ${resolve(t.outDir, "popup.css")}${
    dev ? "" : " --minify"
  }`;
  execSync(cssCmd, { stdio: "inherit" });

  copyFileSync("src/popup/index.html", resolve(t.outDir, "popup.html"));
  copyFileSync(t.manifest, resolve(t.outDir, "manifest.json"));
  const iconSrc = resolve("icons/icon-128.png");
  if (existsSync(iconSrc)) {
    copyFileSync(iconSrc, resolve(t.outDir, "icon-128.png"));
  }
}

console.log("built: chrome/");
