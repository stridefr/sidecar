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

// `git commit`/`git tag -a` fail outright with no configured identity, which
// is easy to hit if this is the first time `git` (not `gh`) has ever made a
// commit on a machine — `gh auth login` doesn't set one. Falls back to the
// repo's own git history, then a placeholder, rather than making the whole
// release fail on something this script can just supply.
function resolveIdentity(cwd) {
  try {
    const name = sh('git', ['config', 'user.name'], cwd);
    const email = sh('git', ['config', 'user.email'], cwd);
    if (name && email) return null; // already configured — don't override it
  } catch (e) { /* not configured — fall through */ }
  try {
    const last = sh('git', ['log', '-1', '--format=%an <%ae>'], cwd);
    const m = last.match(/^(.*) <(.*)>$/);
    if (m) return { name: m[1], email: m[2] };
  } catch (e) { /* no commits yet either */ }
  return { name: 'sidecar-release', email: 'release@localhost' };
}

function gitCommitOrTag(args, cwd, identity) {
  const withIdentity = identity
    ? ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, ...args]
    : args;
  shInherit('git', withIdentity, cwd);
}

// Refuse to bundle unrelated work into a version-bump commit.
const dirty = sh('git', ['status', '--porcelain'], REPO_ROOT);
if (dirty) {
  console.error('Working tree has uncommitted changes. Commit or stash them first —\na release commit should only ever contain the version bump.');
  console.error(dirty);
  process.exit(1);
}

// Bumped directly rather than shelling out to `npm version` — on Windows,
// `execFileSync('npm', ...)` fails with ENOENT because npm is npm.cmd, a
// batch file, and child_process without shell:true won't resolve it through
// PATH the way an actual shell would. A plain semver bump is simple enough
// not to need npm's involvement (or that whole class of problem) at all.
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);
const bumped = bumpType === 'major' ? [maj + 1, 0, 0]
  : bumpType === 'minor' ? [maj, min + 1, 0]
  : [maj, min, pat + 1];
pkg.version = bumped.join('.');
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');

const lockPath = path.join(APP_DIR, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = pkg.version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = pkg.version;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

const version = pkg.version;
const tag = `v${version}`;

console.log(`Bumped to ${version}. Committing and tagging ${tag}...`);

const identity = resolveIdentity(REPO_ROOT);
if (identity) console.log(`(no git identity configured — using ${identity.name} <${identity.email}> for this commit only)`);

shInherit('git', ['add', 'app/package.json', 'app/package-lock.json'], REPO_ROOT);
gitCommitOrTag(['commit', '-m', tag], REPO_ROOT, identity);
// -a: annotated. Lightweight tags are silently dropped by `--follow-tags`,
// which is exactly how the last attempt at this never reached GitHub.
gitCommitOrTag(['tag', '-a', tag, '-m', tag], REPO_ROOT, identity);
shInherit('git', ['push', 'origin', 'HEAD', '--follow-tags'], REPO_ROOT);

console.log(`\nPushed ${tag}. GitHub Actions will build and publish the release:`);
console.log('  https://github.com/stridefr/sidecar/actions');
