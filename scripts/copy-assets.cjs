#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve('src');
const DIST_DIR = path.resolve('dist');

if (!fs.existsSync(SRC_DIR)) {
  console.error(`Source directory not found: ${SRC_DIR}`);
  process.exit(1);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyDirectory(srcDir, destDir) {
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.ts' || ext === '.tsx') {
        continue;
      }
      ensureDir(path.dirname(destPath));
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

ensureDir(DIST_DIR);
copyDirectory(SRC_DIR, DIST_DIR);
console.log(`Assets copied from ${SRC_DIR} to ${DIST_DIR}`);

