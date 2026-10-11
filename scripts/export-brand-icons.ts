#!/usr/bin/env node
// Regenerates every app icon from the mark, assets/prod/otter-mail-symbol.svg (Otterware's
// envelope, a charcoal path on a 1024 canvas). The released icon is the mark on an ivory tile
// (charcoal in dark mode); the development ("blueprint") variant, like T3 Code's assets/dev, is
// it in white on a blue drafting sheet; the picker's icons are it in a theme's accent on its
// sidebar.
//   assets/prod/otter-mail-{macos,ios}-1024.png, assets/dev/blueprint-{macos,ios}-1024.png
//   apps/desktop/resources/icon.icns, icon-dev.icns  the released app, and dev / `pnpm start` runs
//   apps/desktop/resources/icon.png                  the released Linux app
//   apps/desktop/resources/app-icons/<theme>.png     the picker's icons (Dock, Linux windows)
//   apps/web/src/main/assets/app-icons/<theme>.png   their pictures, and the web's favicon
//   apps/web/public/favicon.{svg,ico}, apple-touch-icon.png
//   the iPhone's AppIcon (light, dark, tinted), AppIcon-<theme>, AppIconPreview-<theme>, OtterMark
// Renders with playwright-core's Chromium (`pnpm exec playwright-core install
// chromium-headless-shell` once). Run with `pnpm icons:export`.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { chromium } from "playwright-core";
import { APP_THEMES, getThemeColorsForAppearance } from "../packages/shared/src/theme-palettes.ts";
import { DEFAULT_APP_ICON } from "../packages/shared/src/app-icons.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const at = (file: string) => NodePath.join(root, file);
const catalog = "apps/ios/OtterMail/Assets.xcassets";

const IVORY = "#f8f5ec";
const CHARCOAL = "#2c2f31";
const mark = /<path[^>]* d="([^"]+)"/.exec(
  NodeFS.readFileSync(at("assets/prod/otter-mail-symbol.svg"), "utf8"),
)![1]!;

type Art = { background: string; color: string; defs?: string };

const svg = (body: string, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${defs}</defs>${body}</svg>`;
const glyph = ({ color }: Art) => `<path fill="${color}" fill-rule="evenodd" d="${mark}"/>`;
const art = (a: Art) => a.background + glyph(a);

/** Full bleed, for iOS (which masks it) and the web's pictures. */
const square = (a: Art) => svg(art(a), a.defs);
/** A rounded tile filling the canvas: Linux, favicons. */
const tile = (a: Art) =>
  svg(
    `<g clip-path="url(#tile)">${art(a)}</g>`,
    `${a.defs ?? ""}<clipPath id="tile"><rect width="1024" height="1024" rx="230"/></clipPath>`,
  );
/** The classic macOS icon: an 824 tile inset 100, with a shadow. */
const mac = (a: Art) =>
  svg(
    `<rect x="100" y="100" width="824" height="824" rx="184" filter="url(#shadow)"/>` +
      `<g transform="translate(100 100) scale(.8046875)" clip-path="url(#tile)">${art(a)}</g>`,
    `${a.defs ?? ""}<clipPath id="tile"><rect width="1024" height="1024" rx="229"/></clipPath>` +
      `<filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dy="10" stdDeviation="12" flood-opacity=".18"/></filter>`,
  );

const flat = (background: string, color: string): Art => ({
  background: `<rect width="1024" height="1024" fill="${background}"/>`,
  color,
});
const light = flat(IVORY, CHARCOAL);
const dark = flat(CHARCOAL, IVORY);

function blueprint(): Art {
  let lines = "";
  for (let i = 32; i < 1024; i += 32) {
    const major = i % 128 === 0;
    lines += `<path d="M${i} 0V1024M0 ${i}H1024" stroke="#fff" stroke-opacity="${major ? 0.16 : 0.07}" stroke-width="${major ? 2 : 1.25}"/>`;
  }
  const plus = (x: number, y: number) => `M${x - 16} ${y}H${x + 16}M${x} ${y - 16}V${y + 16}`;
  const ticks =
    `<path d="${plus(176, 176)}${plus(848, 176)}${plus(848, 848)}" stroke="#fff" stroke-opacity=".6" stroke-width="4"/>` +
    `<path d="M94 260H130M112 260V764M94 764H130M260 894V930M260 912H764M764 894V930" stroke="#fff" stroke-opacity=".45" stroke-width="4"/>`;
  return {
    defs: `<linearGradient id="sheet" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f86f4"/><stop offset="1" stop-color="#1b4fd1"/></linearGradient>`,
    background: `<rect width="1024" height="1024" fill="url(#sheet)"/>${lines}${ticks}`,
    color: "#ffffff",
  };
}

/** An icon's .icns: PNGs for every size macOS asks for (iconutil's types). */
async function icns(png: (size: number) => Promise<Buffer>): Promise<Buffer> {
  const types = {
    ic11: 32,
    ic12: 64,
    ic07: 128,
    ic08: 256,
    ic13: 256,
    ic09: 512,
    ic14: 512,
    ic10: 1024,
  };
  const chunks = [];
  for (const [type, size] of Object.entries(types)) {
    const data = await png(size);
    const head = Buffer.alloc(8);
    head.write(type, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    chunks.push(head, data);
  }
  const head = Buffer.alloc(8);
  head.write("icns", "ascii");
  head.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

/** An .ico of PNGs (Vista and later read them). */
function ico(pngs: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    head.writeUInt8(size % 256, entry);
    head.writeUInt8(size % 256, entry + 1);
    head.writeUInt16LE(1, entry + 4);
    head.writeUInt16LE(32, entry + 6);
    head.writeUInt32LE(data.length, entry + 8);
    head.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map(({ data }) => data)]);
}

const write = (file: string, data: string | Buffer) => {
  NodeFS.mkdirSync(NodePath.dirname(at(file)), { recursive: true });
  NodeFS.writeFileSync(at(file), data);
};
const json = (file: string, value: unknown) => write(file, `${JSON.stringify(value, null, 2)}\n`);
const info = { author: "xcode", version: 1 };

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  /** PNG of an SVG at a size; opaque art comes out without an alpha channel, as Apple wants. */
  async function png(image: string, size: number): Promise<Buffer> {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${image}`,
    );
    return page.screenshot({ omitBackground: true });
  }

  const dev = blueprint();
  write("assets/prod/otter-mail-macos-1024.png", await png(mac(light), 1024));
  write("assets/prod/otter-mail-ios-1024.png", await png(square(light), 1024));
  write("assets/dev/blueprint-macos-1024.png", await png(mac(dev), 1024));
  write("assets/dev/blueprint-ios-1024.png", await png(square(dev), 1024));
  write("apps/desktop/resources/icon.icns", await icns((size) => png(mac(light), size)));
  write("apps/desktop/resources/icon-dev.icns", await icns((size) => png(mac(dev), size)));
  write("apps/desktop/resources/icon.png", await png(tile(light), 512));

  // The web's favicon follows the system's light or dark; the picker's icons are pictures.
  write(
    "apps/web/public/favicon.svg",
    svg(
      `<style>.tile{fill:${IVORY}}.mark{fill:${CHARCOAL}}@media (prefers-color-scheme: dark){.tile{fill:${CHARCOAL}}.mark{fill:${IVORY}}}</style>` +
        `<rect class="tile" width="1024" height="1024" rx="230"/><path class="mark" fill-rule="evenodd" d="${mark}"/>`,
    ),
  );
  const favicons = [];
  for (const size of [16, 32, 48]) favicons.push({ size, data: await png(tile(light), size) });
  write("apps/web/public/favicon.ico", ico(favicons));
  write("apps/web/public/apple-touch-icon.png", await png(square(light), 180));
  write("apps/web/src/main/assets/otter-mail-icon.png", await png(square(light), 192));

  // The iPhone: light, dark and tinted (the system colors the light mark on black).
  const appIcon = `${catalog}/AppIcon.appiconset`;
  write(`${appIcon}/icon-1024.png`, await png(square(light), 1024));
  write(`${appIcon}/icon-dark-1024.png`, await png(square(dark), 1024));
  write(`${appIcon}/icon-tinted-1024.png`, await png(square(flat("#000000", "#ffffff")), 1024));
  json(`${appIcon}/Contents.json`, {
    images: [
      ["icon-1024.png"],
      ["icon-dark-1024.png", "dark"],
      ["icon-tinted-1024.png", "tinted"],
    ].map(([filename, luminosity]) => ({
      ...(luminosity ? { appearances: [{ appearance: "luminosity", value: luminosity }] } : {}),
      filename,
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
    })),
    info,
  });
  write(`${catalog}/OtterMark.imageset/otter-mark.png`, await png(square(light), 512));

  for (const theme of APP_THEMES) {
    const colors = getThemeColorsForAppearance(theme, "dark")!;
    const icon = theme.id === DEFAULT_APP_ICON ? light : flat(colors.sidebar, colors.accent);
    write(`apps/desktop/resources/app-icons/${theme.id}.png`, await png(mac(icon), 512));
    write(`apps/web/src/main/assets/app-icons/${theme.id}.png`, await png(square(icon), 192));
    write(`${catalog}/AppIconPreview-${theme.id}.imageset/icon.png`, await png(square(icon), 192));
    json(`${catalog}/AppIconPreview-${theme.id}.imageset/Contents.json`, {
      images: [{ filename: "icon.png", idiom: "universal" }],
      info,
    });
    // The default is the primary AppIcon, restored with setAlternateIconName(nil).
    if (theme.id === DEFAULT_APP_ICON) continue;
    write(`${catalog}/AppIcon-${theme.id}.appiconset/icon-1024.png`, await png(square(icon), 1024));
    json(`${catalog}/AppIcon-${theme.id}.appiconset/Contents.json`, {
      images: [
        { filename: "icon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" },
      ],
      info,
    });
  }
} finally {
  await browser.close();
}
console.log(`Icons exported from assets/prod/otter-mail-symbol.svg (${APP_THEMES.length} themes).`);
