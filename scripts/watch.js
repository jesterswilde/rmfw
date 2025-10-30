// scripts/watch.js
/* eslint-disable no-console */
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

// -------- CLI flags --------
const args = new Set(process.argv.slice(2));
const BUILD_ONCE = args.has('--build');
const VERBOSE = !args.has('--quiet');

// -------- config --------
const SRC_DIR = 'src';
const DIST_DIR = 'dist';
const CACHE_DIR = '.cache';
const MANIFEST_PATH = path.join(CACHE_DIR, 'copy-manifest.json');

// Ensure base dirs exist
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ---------- helpers ----------
function walkDir(dir, fileCallback, dirCallback) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dirCallback) dirCallback(full);
      walkDir(full, fileCallback, dirCallback);
    } else if (entry.isFile()) {
      fileCallback(full);
    }
  }
}

function ensureDir(p) {
  const d = path.dirname(p);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---------- TypeScript build ----------
function compileTypeScript(_filePath, verbose = VERBOSE) {
  try {
    if (verbose) console.log(`Compiling project (tsc)...`);
    // Tip: enable "incremental": true in tsconfig.json for faster rebuilds.
    execSync(`npx tsc --project tsconfig.json`, { stdio: 'inherit' });
    if (verbose) console.log(`Compilation finished`);
  } catch (error) {
    console.error(`TypeScript compile error:`, error.message || error);
  }
}

// Debounced compile scheduler (prevents multiple tsc runs in quick succession)
let compileTimer = null;
function scheduleCompile(verbose = VERBOSE, delayMs = 100) {
  if (compileTimer) clearTimeout(compileTimer);
  compileTimer = setTimeout(() => {
    compileTimer = null;
    compileTypeScript(undefined, verbose);
  }, delayMs);
}

// ---------- cached copy (non-TS) ----------
function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); }
  catch { return {}; }
}
function saveManifest(m) {
  try { fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2)); }
  catch (e) { if (VERBOSE) console.warn('Failed to save manifest:', e.message); }
}
const manifest = loadManifest();

function fileKeyFromSrc(srcPath) {
  // normalize to forward slashes to be cross-platform
  return path.relative(SRC_DIR, srcPath).replace(/\\/g, '/');
}
function statSignature(stat) {
  // fast & good-enough fingerprint based on mtime + size
  return `${stat.mtimeMs}-${stat.size}`;
}
function contentHash(filePath) {
  // used only for edge cases (disabled by default below)
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function shouldCopy(srcPath, useHash = false) {
  const key = fileKeyFromSrc(srcPath);
  const stat = fs.statSync(srcPath);
  const sig = statSignature(stat);
  const prev = manifest[key];
  if (!prev) return true;
  if (prev.sig !== sig) {
    if (!useHash) return true;
    const hash = contentHash(srcPath);
    return hash !== prev.hash;
  }
  return false;
}

function rememberCopy(srcPath, useHash = false) {
  const key = fileKeyFromSrc(srcPath);
  const stat = fs.statSync(srcPath);
  const entry = { sig: statSignature(stat) };
  if (useHash) entry.hash = contentHash(srcPath);
  manifest[key] = entry;
}

function maybeCopyFile(filePath, verbose = VERBOSE) {
  try {
    // Set second arg to true to enable content hashing as a secondary check.
    if (!shouldCopy(filePath /*, true*/)) return;
    const relativePath = path.relative(SRC_DIR, filePath);
    const destPath = path.join(DIST_DIR, relativePath);
    ensureDir(destPath);
    if (verbose) console.log(`Copying: ${filePath} -> ${destPath}`);
    fs.copyFileSync(filePath, destPath);
    rememberCopy(filePath /*, true*/);
    saveManifest(manifest);
    if (verbose) console.log(`Copied: ${relativePath}`);
  } catch (error) {
    console.error(`Error copying ${filePath}:`, error.message || error);
  }
}

// (kept for compatibility; not used by initial build any more)
function copyFile(filePath, verbose = VERBOSE) {
  try {
    const relativePath = path.relative(SRC_DIR, filePath);
    const destPath = path.join(DIST_DIR, relativePath);
    ensureDir(destPath);
    if (verbose) console.log(`Copying: ${filePath} -> ${destPath}`);
    fs.copyFileSync(filePath, destPath);
    if (verbose) console.log(`Copied: ${relativePath}`);
  } catch (error) {
    console.error(`Error copying ${filePath}:`, error.message || error);
  }
}

// ---------- on-change handlers ----------
function handleFileChange(filePath, verbose = VERBOSE) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') {
    // debounce compiles; a burst of TS changes compiles once
    scheduleCompile(verbose);
  } else {
    maybeCopyFile(filePath, verbose);
  }
}

// ---------- removal on change ----------
function removeCandidates(baseAbsNoExt) {
  const candidates = [
    `${baseAbsNoExt}.js`,
    `${baseAbsNoExt}.js.map`,
    `${baseAbsNoExt}.d.ts`,
    `${baseAbsNoExt}.d.ts.map`,
    `${baseAbsNoExt}.mjs`,
    `${baseAbsNoExt}.mjs.map`,
    `${baseAbsNoExt}.cjs`,
    `${baseAbsNoExt}.cjs.map`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      if (VERBOSE) console.log(`Removed: ${p}`);
    }
  }
}

function handleFileRemoval(filePath) {
  try {
    const relativePath = path.relative(SRC_DIR, filePath);
    const ext = path.extname(relativePath).toLowerCase();
    if (ext === '.ts' || ext === '.tsx') {
      const baseAbsNoExt = path.join(DIST_DIR, relativePath.slice(0, -ext.length));
      removeCandidates(baseAbsNoExt);
    } else {
      const destPath = path.join(DIST_DIR, relativePath);
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
        if (VERBOSE) console.log(`Removed: ${destPath}`);
      }
      // clean from manifest
      const key = relativePath.replace(/\\/g, '/');
      if (manifest[key]) {
        delete manifest[key];
        saveManifest(manifest);
      }
    }
  } catch (error) {
    console.error(`Error removing outputs for ${filePath}:`, error.message || error);
  }
}

function handleDirRemoval(dirPath) {
  const relative = path.relative(SRC_DIR, dirPath);
  const distDir = path.join(DIST_DIR, relative);
  try {
    if (fs.existsSync(distDir)) {
      // best-effort: remove if empty (or recursively if you prefer)
      try {
        if (fs.readdirSync(distDir).length === 0) {
          fs.rmdirSync(distDir, { recursive: true });
          if (VERBOSE) console.log(`Removed empty directory: ${distDir}`);
        }
      } catch {}
    }
  } catch {}
}

// ---------- NEW: initial cleanup / orphans ----------
function srcHasTsSource(baseRelNoExt) {
  return (
    fs.existsSync(path.join(SRC_DIR, `${baseRelNoExt}.ts`)) ||
    fs.existsSync(path.join(SRC_DIR, `${baseRelNoExt}.tsx`))
  );
}

function cleanupDistOrphans() {
  // Delete any dist file that no longer corresponds to a source file
  // - For TS outputs (.js/.mjs/.cjs/.d.ts and *.map), keep only if src has matching .ts/.tsx
  // - For mirrored non-TS files (css, images, etc.), keep only if src has the same file
  const compiledExts = new Set(['.js', '.mjs', '.cjs', '.d.ts']);
  const isMap = (p) => p.endsWith('.map');

  walkDir(DIST_DIR, (distFile) => {
    const rel = path.relative(DIST_DIR, distFile);
    const ext = path.extname(distFile).toLowerCase();

    const removeFile = () => {
      try {
        fs.unlinkSync(distFile);
        if (VERBOSE) console.log(`Cleaned: ${distFile}`);
      } catch (e) {
        console.warn(`Failed to remove ${distFile}: ${e.message}`);
      }
      // also reflect removal in manifest for mirrored files
      const key = rel.replace(/\\/g, '/');
      if (manifest[key]) {
        delete manifest[key];
        saveManifest(manifest);
      }
    };

    if (isMap(distFile)) {
      // Handle .map for .js or .d.ts
      const withoutMap = distFile.slice(0, -'.map'.length);
      const baseRel = path.relative(DIST_DIR, withoutMap);
      const baseNoExt = baseRel.replace(/\.(js|mjs|cjs|d\.ts)$/i, '');
      if (!srcHasTsSource(baseNoExt)) removeFile();
      return;
    }

    if (compiledExts.has(ext)) {
      const baseRelNoExt = rel.slice(0, -ext.length).replace(/\.d$/, ''); // remove trailing ".d" for .d.ts
      if (!srcHasTsSource(baseRelNoExt)) removeFile();
      return;
    }

    // Mirrored (non-TS) file: must exist 1:1 in src
    const srcCounterpart = path.join(SRC_DIR, rel);
    if (!fs.existsSync(srcCounterpart)) removeFile();
  });

  // Remove empty directories in dist (bottom-up)
  const dirs = [];
  walkDir(DIST_DIR, () => {}, (dir) => dirs.push(dir));
  dirs.sort((a, b) => b.length - a.length).forEach((d) => {
    try {
      if (fs.existsSync(d) && fs.readdirSync(d).length === 0) {
        fs.rmdirSync(d);
        if (VERBOSE) console.log(`Pruned empty dir: ${d}`);
      }
    } catch {}
  });
}

// ---------- initial build ----------
function initialBuild() {
  if (VERBOSE) console.log('Starting initial build...');

  // 1) Copy only non-TS files (skip unchanged via manifest)
  if (fs.existsSync(SRC_DIR)) {
    walkDir(SRC_DIR, (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.ts' && ext !== '.tsx') {
        maybeCopyFile(filePath, false);
      }
    });
  }

  // 2) Single project compile (uses tsc incremental cache if enabled in tsconfig)
  compileTypeScript(undefined, false);

  // 3) Clean orphans
  cleanupDistOrphans();

  if (VERBOSE) console.log('Initial build complete.');
}

// ---------- entrypoint ----------
if (BUILD_ONCE) {
  console.log('Running one-time build...');
  initialBuild();
  process.exit(0);
} else {
  console.log('Starting file watcher...');
  console.log(`Watching: ${SRC_DIR}`);
  console.log(`Output: ${DIST_DIR}`);
  console.log('Press Ctrl+C to stop\n');

  initialBuild();

  const watcher = chokidar.watch(SRC_DIR, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
  });

  watcher
    .on('add', (p) => handleFileChange(p, true))
    .on('change', (p) => handleFileChange(p, true))
    .on('unlink', handleFileRemoval)
    .on('unlinkDir', handleDirRemoval)
    .on('error', (error) => console.error('Watcher error:', error));

  process.on('SIGINT', () => {
    console.log('\nShutting down watcher...');
    watcher.close();
    process.exit(0);
  });
}
