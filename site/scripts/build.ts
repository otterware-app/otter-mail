// Assembles the site in dist/: the web app (apps/web's build). Run by `pnpm build`
// (and deploy).

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const site = NodePath.resolve(import.meta.dirname, "..");
const web = NodePath.resolve(site, "../apps/web/dist");
const dist = NodePath.join(site, "dist");

execFileSync("pnpm", ["--filter", "@otter-mail/web", "build"], { cwd: site, stdio: "inherit" });

NodeFS.rmSync(dist, { recursive: true, force: true });
NodeFS.mkdirSync(dist);
for (const name of [
  "index.html",
  "favicon.ico",
  "favicon.svg",
  "apple-touch-icon.png",
  "assets",
  "todoist-callback",
]) {
  NodeFS.cpSync(NodePath.join(web, name), NodePath.join(dist, name), { recursive: true });
}
console.log("Site assembled in site/dist.");
