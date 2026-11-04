#!/usr/bin/env node
/**
 * Release versioning for NEXUS (semantic versioning).
 *
 * `package.json` is the source of truth. This script keeps every other place that records the version in step
 * with it: package-lock.json, backend/version.py (the backend image cannot read files outside ./backend) and
 * CHANGELOG.md (the `## [Unreleased]` heading becomes `## [x.y.z] - <date>` and a fresh Unreleased section
 * is opened above it).
 *
 *   node scripts/bump-version.mjs patch|minor|major|x.y.z   bump everywhere
 *   node scripts/bump-version.mjs --check                   exit 1 if any file disagrees with package.json
 *
 * It only edits files; committing and tagging stay manual:  git tag -a vX.Y.Z -m "NEXUS X.Y.Z"
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = (p) => join(root, p);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const pkg = JSON.parse(readFileSync(file("package.json"), "utf8"));
const current = pkg.version;
if (!SEMVER.test(current)) fail(`package.json version "${current}" is not MAJOR.MINOR.PATCH`);

/** Every place the version is recorded, besides package.json itself: [path, read-version, write-version(text, v)]. */
const PY_RE = /^__version__ = "([^"]+)"$/m;
const TARGETS = [
  ["package-lock.json", (t) => JSON.parse(t).version, (t, v) => setLockVersion(t, v)],
  ["backend/version.py", (t) => PY_RE.exec(t)?.[1], (t, v) => t.replace(PY_RE, `__version__ = "${v}"`)],
  ["CHANGELOG.md", (t) => /^## \[(\d+\.\d+\.\d+)\]/m.exec(t)?.[1], null],
];

const arg = process.argv[2];
if (!arg) fail("usage: bump-version.mjs patch|minor|major|x.y.z | --check");

if (arg === "--check") {
  const bad = TARGETS.filter(([p, read]) => read(readFileSync(file(p), "utf8")) !== current);
  if (bad.length) {
    for (const [p, read] of bad) console.error(`${p}: ${read(readFileSync(file(p), "utf8"))} (package.json: ${current})`);
    process.exit(1);
  }
  console.log(`All version files agree: ${current}`);
  process.exit(0);
}

const next = nextVersion(current, arg);
const date = new Date().toISOString().slice(0, 10);

// Build every new text first and write only if all of them succeeded, so a failure cannot leave the files half-bumped.
const changelog = readFileSync(file("CHANGELOG.md"), "utf8");
if (!/^## \[Unreleased\]/m.test(changelog)) fail("CHANGELOG.md has no '## [Unreleased]' section to release");
const writes = [
  ["package.json", readFileSync(file("package.json"), "utf8").replace(/("version":\s*")[^"]+(")/, `$1${next}$2`)],
  ["CHANGELOG.md", changelog.replace(/^## \[Unreleased\][ \t]*$/m, `## [Unreleased]\n\n## [${next}] - ${date}`)],
];
for (const [p, , write] of TARGETS) if (write) writes.push([p, write(readFileSync(file(p), "utf8"), next)]);
for (const [p, text] of writes) writeFileSync(file(p), text);

console.log(`${current} -> ${next}`);
console.log(`Next: review CHANGELOG.md, commit, then  git tag -a v${next} -m "NEXUS ${next}"`);

function nextVersion(from, how) {
  const [maj, min, pat] = from.split(".").map(Number);
  if (how === "major") return `${maj + 1}.0.0`;
  if (how === "minor") return `${maj}.${min + 1}.0`;
  if (how === "patch") return `${maj}.${min}.${pat + 1}`;
  if (!SEMVER.test(how)) fail(`"${how}" is not patch, minor, major or MAJOR.MINOR.PATCH`);
  return how;
}

/** package-lock.json records the version twice (top level and packages[""]); replace just those two, keeping the file's formatting. */
function setLockVersion(text, v) {
  let n = 0;
  const out = text.replace(/^(\s*"version":\s*")[^"]+(")/gm, (m, a, b) => (n++ < 2 ? `${a}${v}${b}` : m));
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
