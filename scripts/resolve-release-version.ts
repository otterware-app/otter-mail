#!/usr/bin/env node
// Picks stable versions for Mac/Linux or iPhone (--app ios), or derives a
// Mac/Linux nightly (--channel nightly --date YYYYMMDD --run-number N --sha SHA).
// Stable accepts --version, --tag, or --bump patch|minor|major. --github-output
// appends the release metadata to GITHUB_OUTPUT. iPhone is versioned separately.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parseArgs } from "node:util";
import { isNightlyVersion } from "../packages/shared/src/release-channel.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const STABLE = /^(?:ios-)?v?(\d+)\.(\d+)\.(\d+)$/;

type Bump = "patch" | "minor" | "major";

export function nightlyReleaseMetadata(base: string, date: string, run: string, sha: string) {
  if (!/^\d{8}$/.test(date) || !/^[1-9]\d*$/.test(run) || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error("Nightlies need --date YYYYMMDD, --run-number (positive integer), and --sha.");
  }
  const version = `${bumpVersion(base, "patch")}-nightly.${date}.${run}`;
  return {
    version,
    tag: `v${version}`,
    name: `Otter Mail Nightly ${version} (${sha.slice(0, 12)})`,
  };
}

export function bumpVersion(version: string, bump: Bump): string {
  const match = STABLE.exec(version);
  if (!match) throw new Error(`Not a stable version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

type App = "mac" | "ios";

const APPS: Record<App, { prefix: string; name: string; sourceVersion: () => string }> = {
  mac: {
    prefix: "v",
    name: "Otter Mail",
    sourceVersion: () =>
      (
        JSON.parse(
          NodeFS.readFileSync(NodePath.join(repoRoot, "apps/desktop/package.json"), "utf8"),
        ) as { version: string }
      ).version,
  },
  ios: {
    prefix: "ios-v",
    name: "Otter Mail for iPhone",
    sourceVersion: () =>
      /MARKETING_VERSION = ([^;]+);/.exec(
        NodeFS.readFileSync(
          NodePath.join(repoRoot, "apps/ios/OtterMail.xcodeproj/project.pbxproj"),
          "utf8",
        ),
      )?.[1] ?? "",
  },
};

/** The app's stable tags, newest first. */
function stableTags(prefix: string): string[] {
  const out = NodeChildProcess.execFileSync(
    "git",
    ["tag", "--list", `${prefix}*`, "--sort=-v:refname"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter((tag) => tag.startsWith(prefix) && /^\d+\.\d+\.\d+$/.test(tag.slice(prefix.length)));
}

function main(): void {
  const { values } = parseArgs({
    options: {
      app: { type: "string", default: "mac" },
      channel: { type: "string", default: "stable" },
      date: { type: "string" },
      "run-number": { type: "string" },
      sha: { type: "string" },
      version: { type: "string" },
      tag: { type: "string" },
      bump: { type: "string", default: "patch" },
      "github-output": { type: "boolean", default: false },
    },
  });
  const app = APPS[values.app as App];
  if (!app) throw new Error(`Unknown app: ${values.app}`);
  if (values.channel !== "stable" && values.channel !== "nightly") {
    throw new Error(`Unknown release channel: ${values.channel}`);
  }
  if (values.channel === "nightly" && (values.app !== "mac" || values.version || values.tag)) {
    throw new Error("Nightlies build the Mac/Linux app with an automatically derived version.");
  }
  const tags = stableTags(app.prefix);
  const explicit = (values.version?.trim() || values.tag?.trim() || "").replace(
    new RegExp(`^${app.prefix}`),
    "",
  );
  let version: string;
  const nightly =
    values.channel === "nightly"
      ? nightlyReleaseMetadata(
          tags[0] ?? app.sourceVersion(),
          values.date ?? "",
          values["run-number"] ?? "",
          values.sha ?? "",
        )
      : null;
  if (nightly) {
    version = nightly.version;
  } else if (explicit) {
    version = explicit;
  } else if (tags[0]) {
    const bump = values.bump as Bump;
    if (!["patch", "minor", "major"].includes(bump)) throw new Error(`Unknown bump: ${bump}`);
    version = bumpVersion(tags[0], bump);
  } else {
    version = app.sourceVersion();
  }
  if (!/^\d+\.\d+\.\d+$/.test(version) && !nightly)
    throw new Error(`Invalid stable release version: ${version}`);
  const tag = `${app.prefix}${version}`;
  // A pushed tag already exists; a dispatched release must not reuse one.
  if (!values.tag && tags.includes(tag)) throw new Error(`${tag} was already released.`);

  const stable = !isNightlyVersion(version);
  const nightlyTags = NodeChildProcess.execFileSync(
    "git",
    ["tag", "--list", "v*-nightly.*", "--sort=-v:refname"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const outputs = {
    version,
    tag,
    name: nightly?.name ?? `${app.name} ${version}`,
    prerelease: String(!stable),
    make_latest: String(stable),
    previous_tag:
      (nightly ? nightlyTags.find((t) => t !== tag && isNightlyVersion(t.slice(1))) : undefined) ??
      tags.find((t) => t !== tag) ??
      "",
  };
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  if (values["github-output"] && process.env.GITHUB_OUTPUT) {
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  }
  console.log(lines.join("\n"));
}

if (import.meta.main) main();
