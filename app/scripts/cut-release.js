#!/usr/bin/env node
// Bumps the version and cuts a release — replacing `npm version`, which
// silently does nothing here: its git integration only fires when
// package.json sits at the repo root, and this one lives in app/. It bumped
// the file once with no commit and no tag, and `git push --follow-tags`
// reported "Everything up-to-date" because there was, genuinely, nothing to
// push — not an error, just a no-op dressed up as success.
//
// A second trap worth naming: `--follow-tags` only pushes *annotated* tags.
// A plain `git tag vX.Y.Z` is lightweight and gets silently skipped, which is
// exactly what let the first "release" sit invisibly on this machine while
// GitHub showed nothing.
//
// This does both steps explicitly, from the repo root, with an annotated tag.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(APP_DIR, '..');
const PKG_PATH = path.join(APP_DIR, 'package.json');

const bumpType = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('Usage: node scripts/cut-release.js <patch|minor|major>');
  process.exit(1);
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function shInherit(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

// Refuse to bundle unrelated work into a version-bump commit.
const dirty = sh('git', ['status', '--porcelain'], REPO_ROOT);
if (dirty) {
  console.error('Working tree has uncommitted changes. Commit or stash them first —\na release commit should only ever contain the version bump.');
  console.error(dirty);
  process.exit(1);
}

// --no-git-tag-version: just edit package.json/package-lock.json, no git ops.
// Those are npm's job to get right (semver, package-lock sync) — only the
// git side of `npm version` was broken here.
sh('npm', ['version', bumpType, '--no-git-tag-version'], APP_DIR);

const version = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version;
const tag = `v${version}`;

console.log(`Bumped to ${version}. Committing and tagging ${tag}...`);

shInherit('git', ['add', 'app/package.json', 'app/package-lock.json'], REPO_ROOT);
shInherit('git', ['commit', '-m', tag], REPO_ROOT);
// -a: annotated. Lightweight tags are silently dropped by `--follow-tags`,
// which is exactly how the last attempt at this never reached GitHub.
shInherit('git', ['tag', '-a', tag, '-m', tag], REPO_ROOT);
shInherit('git', ['push', 'origin', 'HEAD', '--follow-tags'], REPO_ROOT);

console.log(`\nPushed ${tag}. GitHub Actions will build and publish the release:`);
console.log('  https://github.com/stridefr/sidecar/actions');
