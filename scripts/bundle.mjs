#!/usr/bin/env node
// scripts/bundle-single.mjs
import fs from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { build } from "esbuild";
import { parse } from "node-html-parser";
import { transform as cssTransform } from "lightningcss";
import { minify as minifyHtml } from "html-minifier-terser";

/* -------------------------------------------------------------
   Config
------------------------------------------------------------- */
const projectRoot = process.cwd();
const outDir = path.resolve(projectRoot, "out");
const esTargets = { chrome: 113, firefox: 114, safari: 16, edge: 113 };

/* -------------------------------------------------------------
   Utils
------------------------------------------------------------- */
function isExternalUrl(u) {
  return /^https?:\/\//i.test(u) || /^data:/i.test(u);
}

function resolveHref(baseHtmlPath, href) {
  if (!href) return null;
  if (isExternalUrl(href)) return null; // leave external
  if (href.startsWith("/")) return path.join(projectRoot, href.replace(/^\//, ""));
  return path.resolve(path.dirname(baseHtmlPath), href);
}

function escapeForScriptTag(code) {
  return code.replace(/<\/script/gi, "<\\/script");
}

function escapeForStyleTag(code) {
  return code.replace(/<\/style/gi, "<\\/style");
}

/* -------------------------------------------------------------
   Inline <link rel="stylesheet" href="...">
------------------------------------------------------------- */
async function inlineStyles(doc, htmlPath) {
  const linkNodes = doc.querySelectorAll('link[rel="stylesheet"][href]');
  for (const node of linkNodes) {
    const href = node.getAttribute("href");
    const absPath = resolveHref(htmlPath, href);
    if (!absPath) {
      console.log(pc.dim(`- skip CSS (external/unresolved): ${href ?? "(none)"}`));
      continue;
    }

    const cssRaw = await fs.readFile(absPath, "utf8");
    const { code } = cssTransform({
      code: Buffer.from(cssRaw),
      minify: true,
      targets: esTargets,
    });

    const styleEl = parse(`<style>${escapeForStyleTag(code.toString())}</style>`);
    node.replaceWith(styleEl);
    console.log(pc.green(`OK Inlined CSS ${href}`));
  }
}

/* -------------------------------------------------------------
   Bundle and inline <script type="module" src="...">
   - Forces an in-memory outfile so outputFiles are populated.
   - Inlines any CSS outputs as <style>.
------------------------------------------------------------- */
async function inlineScripts(doc, htmlPath) {
  const scriptNodes = doc.querySelectorAll('script[src][type="module"]');
  for (const node of scriptNodes) {
    const src = node.getAttribute("src");
    const absPath = resolveHref(htmlPath, src);
    if (!absPath) {
      console.log(pc.dim(`- skip script (external/unresolved): ${src ?? "(none)"}`));
      continue;
    }

    // Use a fake outfile; write:false keeps it in memory.
    const fakeOutfile = path.join(projectRoot, "out", "__inline__.js");

    const result = await build({
      entryPoints: [absPath],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["es2023"],
      minify: true,
      sourcemap: false,
      treeShaking: true,
      loader: {
        ".ts": "ts",
        ".tsx": "tsx",
        ".css": "css", // allow CSS imports from JS to be emitted
      },
      outfile: fakeOutfile,
      write: false,
      logLevel: "silent",
    });

    // Collect outputs
    const cssPieces = [];
    let jsText = "";
    for (const f of result.outputFiles || []) {
      if (f.path.endsWith(".css")) {
        cssPieces.push(f.text);
      } else if (f.path.endsWith(".js") || f.path.endsWith(".mjs")) {
        jsText += f.text;
      }
    }

    if (!jsText) {
      console.warn(pc.yellow(`!! No JS output for ${src}`));
      continue;
    }

    // Inline emitted CSS first (if any), then JS
    for (const css of cssPieces) {
      const styleEl = parse(`<style>${escapeForStyleTag(css)}</style>`);
      // Insert before the script node to preserve relative order
      node.insertAdjacentHTML("beforebegin", styleEl.toString());
      console.log(pc.green(`OK Inlined CSS emitted from JS ${src}`));
    }

    const scriptEl = parse(`<script type="module">${escapeForScriptTag(jsText)}</script>`);
    node.replaceWith(scriptEl);
    console.log(pc.green(`OK Bundled & inlined JS ${src}`));
  }
}

/* -------------------------------------------------------------
   Main
------------------------------------------------------------- */
async function run() {
  const [, , inputHtmlArg] = process.argv;
  if (!inputHtmlArg) {
    console.error(pc.red("Usage: npm run build:single -- <path/to/file.html>"));
    process.exit(1);
  }

  const htmlPath = path.resolve(projectRoot, inputHtmlArg);

  const exists = await fs
    .access(htmlPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    console.error(pc.red(`Input HTML not found: ${htmlPath}`));
    process.exit(1);
  }

  const originalHtml = await fs.readFile(htmlPath, "utf8");
  const doc = parse(originalHtml, { comment: true });

  await inlineStyles(doc, htmlPath);
  await inlineScripts(doc, htmlPath);

  // Clean any leftover externals we could not inline
  doc.querySelectorAll('link[rel="stylesheet"]').forEach((n) => {
    if (n.getAttribute("href")) n.remove();
  });
  doc.querySelectorAll("script[src]").forEach((n) => n.remove());

  // Minify final HTML (CSS/JS already minified)
  const minified = await minifyHtml("<!doctype html>\n" + doc.toString(), {
    collapseWhitespace: true,
    removeComments: true,
    minifyCSS: false,
    minifyJS: false,
    keepClosingSlash: true,
    sortAttributes: true,
    sortClassName: true,
    html5: true,
  });

  await fs.mkdir(outDir, { recursive: true });
  const outName = path.basename(htmlPath).replace(/\.html?$/i, "") + ".html";
  const outPath = path.join(outDir, outName);
  await fs.writeFile(outPath, minified, "utf8");

  console.log(pc.cyan(`\n=== Single-file build ready ===\n${outPath}\n`));
}

run().catch((err) => {
  console.error(pc.red(err?.stack || String(err)));
  process.exit(1);
});
