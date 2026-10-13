import { Outlet } from "@tanstack/react-router";
import * as React from "react";
import { startSyncedPreferences } from "./synced-preferences";
import { applyAppTheme, startAppTheme } from "./theme/apply-theme";
import { applyInterfaceSettings, startInterfaceSettings } from "./theme/interface-settings";
import { UpdateNotifier } from "./updates";
import { ThemeEditorHost } from "./settings/theme/ThemeEditorHost";

// Color theme (Settings → Appearance) for the current appearance, applied
// before first paint. It also owns the `dark` class on <html>.
applyAppTheme();
// Contrast, glass and the font size, also before first paint.
applyInterfaceSettings();

export function RootView() {
  // Re-theme live on appearance switches and theme picks from any window.
  React.useEffect(() => startAppTheme(), []);
  React.useEffect(() => startInterfaceSettings(), []);
  React.useEffect(() => startSyncedPreferences(), []);

  return (
    <div className="h-full relative [&:not(:has([data-toolbar]))_.drag-region]:z-50 [&:has([data-toolbar])>.drag-region]:[-webkit-app-region:none]">
      {/* Draggable top bar - fallback for when no toolbar is present (with
          one, it stops dragging: Electron ignores z-order for drag regions,
          so it would otherwise swallow clicks in the views' own top bars). */}
      <div className="drag-region fixed top-0 left-0 right-0 h-(--workspace-topbar-height)" />
      {/* relative: paints above the fixed fallback strip, which otherwise
          swallows clicks on the app's own top bar (the strip still wins via
          z-50 when no [data-toolbar] is mounted). */}
      <div className="relative h-full">
        <Outlet />
      </div>
      <UpdateNotifier />
      {/* Above the views, so the theme editor stays open while you browse the app in its colors. */}
      <ThemeEditorHost />
    </div>
  );
}
