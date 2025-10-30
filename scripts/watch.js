const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC_DIR = 'src';
const DIST_DIR = 'dist';

if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// ---------- helpers ----------
function walkDir(dir, fileCallback, dirCallback) {
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

// ---------- build / copy ----------
function compileTypeScript(_filePath, verbose = true) {
  try {
    if (verbose) console.log(`Compiling project (tsc)...`);
    execSync(`npx tsc --project tsconfig.json`, { stdio: 'inherit' });
    if (verbose) console.log(`Compilation finished`);
  } catch (error) {
    console.error(`TypeScript compile error:`, error.message);
  }
}

function copyFile(filePath, verbose = true) {
  try {
    const relativePath = path.relative(SRC_DIR, filePath);
    const destPath = path.join(DIST_DIR, relativePath);
    ensureDir(destPath);
    if (verbose) console.log(`Copying: ${filePath} -> ${destPath}`);
    fs.copyFileSync(filePath, destPath);
    if (verbose) console.log(`Copied: ${relativePath}`);
  } catch (error) {
    console.error(`Error copying ${filePath}:`, error.message);
  }
}

function handleFileChange(filePath, verbose = true) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') {
    compileTypeScript(filePath, verbose);
  } else {
    copyFile(filePath, verbose);
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
      console.log(`Removed: ${p}`);
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
        console.log(`Removed: ${destPath}`);
      }
    }
  } catch (error) {
    console.error(`Error removing outputs for ${filePath}:`, error.message);
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
          console.log(`Removed empty directory: ${distDir}`);
        }
      } catch {}
    }
  } catch {}
}

// ---------- NEW: initial cleanup ----------
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
        console.log(`Cleaned: ${distFile}`);
      } catch (e) {
        console.warn(`Failed to remove ${distFile}: ${e.message}`);
      }
    };

    if (isMap(distFile)) {
      // Handle .map for .js or .d.ts
      // base may end with .js or .d.ts
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
  // Walk dirs in reverse depth order by collecting first
  const dirs = [];
  walkDir(DIST_DIR, () => {}, (dir) => dirs.push(dir));
  dirs.sort((a, b) => b.length - a.length).forEach((d) => {
    try {
      if (fs.existsSync(d) && fs.readdirSync(d).length === 0) {
        fs.rmdirSync(d);
        console.log(`Pruned empty dir: ${d}`);
      }
    } catch {}
  });
}

// ---------- initial build ----------
function initialBuild() {
  console.log('Starting initial build...');

  // 1) Build: copy non-TS & compile TS (deep)
  walkDir(SRC_DIR, (filePath) => handleFileChange(filePath, false));

  // 2) Clean: remove dist orphans if sources went missing while watcher was off
  cleanupDistOrphans();

  console.log('Initial build complete.');
}

// ---------- watch ----------
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
