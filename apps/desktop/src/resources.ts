/** Linux's window icon follows the build; macOS uses the bundle's icon. */

import { app, nativeImage, type NativeImage } from "electron";
import { join } from "node:path";
import { isNightlyVersion } from "@otter-mail/shared/release-channel";

export function appIconImage(): NativeImage {
  const dir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
  const filename = app.isPackaged
    ? isNightlyVersion(app.getVersion())
      ? "icon-nightly.png"
      : "icon.png"
    : "icon-dev.png";
  return nativeImage.createFromPath(join(dir, filename));
}
