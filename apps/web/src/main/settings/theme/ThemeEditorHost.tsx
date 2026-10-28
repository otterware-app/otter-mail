/**
 * Ported from Otter Code (github.com/otterware-app/otter-code) at a944cac52:
 * apps/web/src/components/settings/ThemeEditorHost.tsx. Departures are marked
 * "Mail:": Mail wears a theme per appearance (apply-theme.ts) where upstream
 * has a base theme and halves, and has its own toasts.
 */
import { lazy, Suspense, useCallback, useSyncExternalStore } from "react";

import {
  getThemeModes,
  getThemeDefinition,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../../theme/themePalette";
import { toast } from "../../mail/toast";
import { refreshTheme, setThemeForAppearance, useThemeChoice } from "../../theme/apply-theme";
import { useThemeEditorStore } from "./themeEditorStore";

// The host mounts above the router on every page, but the editor body only
// renders once a session opens; lazy-loading it keeps the editor UI out of
// the startup chunk.
const ThemeEditorPanel = lazy(() =>
  import("./ThemeEditorPanel").then((module) => ({ default: module.ThemeEditorPanel })),
);

function useThemeDefinition(id: string | null | undefined) {
  return useSyncExternalStore(
    subscribeToCustomThemes,
    () => (id ? (getThemeDefinition(id) ?? null) : null),
    () => null,
  );
}

/**
 * Renders the theme editor above the router. The editor paints its draft on
 * the live app, so it has to outlive the settings route: the point is to walk
 * through threads, panels, and pages while the colors are being tuned.
 */
export function ThemeEditorHost() {
  const session = useThemeEditorStore((store) => store.session);
  const closeThemeEditor = useThemeEditorStore((store) => store.closeThemeEditor);
  // Mail: each appearance wears its own theme; "setting" a theme wears it
  // wherever it has a palette.
  const choice = useThemeChoice();
  const setTheme = useCallback((themeId: string) => {
    const definition = getThemeDefinition(themeId);
    if (!definition) return false;
    for (const mode of getThemeModes(definition)) setThemeForAppearance(mode, themeId);
    return true;
  }, []);
  // A saved definition can change without its id changing between sessions.
  const editingTheme = useThemeDefinition(session?.editingThemeId);
  const seedTheme = useThemeDefinition(session?.seedThemeId);

  // The panel reports which path it actually took: a theme removed while its
  // editor is open resolves to null there, so the save becomes a create even
  // though the session still names it.
  const handleSaved = useCallback(
    (
      savedTheme: ThemeDefinition,
      { created, mergedAppearance }: { created: boolean; mergedAppearance?: ThemeAppearance },
    ) => {
      // A merge completed an existing theme's light/dark pair; activating the
      // whole theme shows the new palette right away.
      if (mergedAppearance) {
        if (!setTheme(savedTheme.id)) {
          toast.error("Could not save your theme", {
            description: "Browser storage is unavailable, so the change was not kept.",
          });
          return false;
        }
        toast.success(`${savedTheme.label} updated`, {
          description: `Its ${mergedAppearance} palette was added.`,
        });
        return true;
      }
      if (!created) {
        // The edited theme may be showing through the base preference or either
        // half of the mix; the preference itself is untouched (a setTheme here
        // would clear the mix), the palette just needs re-applying.
        const wasActive = choice.light === savedTheme.id || choice.dark === savedTheme.id;
        if (wasActive) refreshTheme();
        toast.success(`${savedTheme.label} saved`, {
          description: wasActive ? "Your changes are now active." : "Your changes are saved.",
        });
        return true;
      }

      if (!setTheme(savedTheme.id)) {
        toast.error("Could not save your theme", {
          description: "Browser storage is unavailable, so the change was not kept.",
        });
        return false;
      }
      toast.success(`${savedTheme.label} created`, { description: "It’s now active." });
      return true;
    },
    [choice, setTheme],
  );

  if (!session) return null;

  return (
    <Suspense fallback={null}>
      <ThemeEditorPanel
        editingTheme={editingTheme}
        initialAppearance={session.initialAppearance}
        key={session.id}
        onOpenChange={(open) => {
          if (!open) closeThemeEditor();
        }}
        onSaved={handleSaved}
        open
        restoreTheme={refreshTheme}
        seedName={session.seedName ?? undefined}
        seedTheme={seedTheme}
      />
    </Suspense>
  );
}
