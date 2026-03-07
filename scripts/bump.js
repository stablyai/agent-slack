import semver from "semver";
import fs from "fs";
const [, , versionArg] = process.argv;
if (!versionArg) {
  console.error("version argument required");
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const currentVersion = pkg.version;
if (["patch", "minor", "major"].includes(versionArg)) {
  console.log(semver.inc(currentVersion, versionArg));
  process.exit(0);
}
if (["patch-rc", "minor-rc", "major-rc"].includes(versionArg)) {
  const bumpType = versionArg.replace("-rc", "");
  const parsed = semver.parse(currentVersion);
  const isRc = parsed.prerelease.length > 0 && parsed.prerelease[0] === "rc";
  if (isRc) {
    let rcTargetType = "unknown";
    if (parsed.patch > 0) {
      rcTargetType = "patch";
    } else if (parsed.minor > 0) {
      rcTargetType = "minor";
    } else if (parsed.major > 0) {
      rcTargetType = "major";
    }
    if (rcTargetType === bumpType) {
      console.log(semver.inc(currentVersion, "prerelease", "rc"));
      process.exit(0);
    }
  }
  const baseVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  console.log(semver.inc(baseVersion, `pre${bumpType}`, "rc"));
  process.exit(0);
}
const valid = semver.valid(versionArg);
if (!valid) {
  console.error(`invalid version format: ${versionArg}`);
  process.exit(1);
}
console.log(valid);
