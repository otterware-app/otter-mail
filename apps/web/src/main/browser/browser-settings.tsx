import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PuzzleIcon } from "lucide-react";

import { Dialog } from "~/components/ui/dialog";
import { Text } from "~/components/ui/text";
import { ipc } from "~/lib/ipc";
import { toast } from "../gmail/toast";
import { Btn } from "../gmail/ui";
import {
  RowSelect,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-ui";
import { searchableSetting } from "../settings/settings-search";
import {
  CHROME_WEB_STORE_URL,
  openTab,
  setOpenLinksIn,
  useBrowser,
  type OpenLinksIn,
} from "./store";

/** An installed extension (apps/desktop/src/services/browser.ts' BrowserExtension). */
type Extension = {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string | null;
  optionsUrl: string | null;
};

const OPEN_LINKS_OPTIONS: { value: OpenLinksIn; label: string }[] = [
  { value: "app", label: "In Otter Mail" },
  { value: "browser", label: "In your default browser" },
];

const EXTENSIONS_KEY = ["browser-extensions"];

/** Settings › Browser (Mac): where links open, the Web Store's extensions, browsing data. */
export function BrowserSettingsPane() {
  const openLinksIn = useBrowser((s) => s.openLinksIn);
  const queryClient = useQueryClient();
  const extensions = useQuery({
    queryKey: EXTENSIONS_KEY,
    queryFn: () => ipc<Extension[]>("browser:extensions"),
  });
  // Added from the Web Store's page, or removed.
  useEffect(
    () =>
      window.desktopBridge.on("browser:extensionsChanged", () => {
        void queryClient.invalidateQueries({ queryKey: EXTENSIONS_KEY });
      }),
    [queryClient],
  );
  const [removing, setRemoving] = useState<Extension | null>(null);
  const [clearing, setClearing] = useState(false);

  return (
    <SettingsPageContainer title="Browser">
      <SettingsSection title="Links">
        <SettingsRow
          {...searchableSetting("browser-links")}
          resetAction={
            openLinksIn !== "app" ? (
              <SettingResetButton label="open links" onClick={() => setOpenLinksIn("app")} />
            ) : null
          }
          description="Links in mail and chat open in a tab in the agent panel, or in your Mac's default browser."
          control={
            <RowSelect
              value={openLinksIn}
              onValueChange={(value) => setOpenLinksIn(value as OpenLinksIn)}
              options={OPEN_LINKS_OPTIONS}
              ariaLabel="Open links"
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("browser-extensions")}
        description="From the Chrome Web Store, as in Chrome. Otter Mail has no toolbar for them: one that works through a toolbar button or popup won't work here."
        headerAction={
          <Btn size="sm" onClick={() => openTab(CHROME_WEB_STORE_URL)}>
            Chrome Web Store
          </Btn>
        }
      >
        {extensions.data && extensions.data.length > 0 ? (
          extensions.data.map((extension) => (
            <SettingsRow
              key={extension.id}
              title={
                <span className="flex items-center gap-2">
                  {extension.icon ? (
                    <img src={extension.icon} alt="" className="size-4 shrink-0" />
                  ) : (
                    <PuzzleIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  {extension.name}
                  <span className="text-muted-foreground">{extension.version}</span>
                </span>
              }
              description={extension.description}
              control={
                <div className="flex gap-2">
                  {extension.optionsUrl ? (
                    <Btn size="sm" onClick={() => openTab(extension.optionsUrl!)}>
                      Options
                    </Btn>
                  ) : null}
                  <Btn size="sm" onClick={() => setRemoving(extension)}>
                    Remove
                  </Btn>
                </div>
              }
            />
          ))
        ) : (
          <SettingsRow
            title={extensions.isPending ? "Loading…" : "No extensions yet"}
            description="Add one from the Chrome Web Store: open it, find an extension, and choose Add to Chrome."
          />
        )}
      </SettingsSection>

      <SettingsSection title="Browsing data">
        <SettingsRow
          {...searchableSetting("browser-data")}
          description="Signs you out of every site: their cookies, storage and the cache go. Extensions stay."
          control={
            <Btn size="sm" onClick={() => setClearing(true)}>
              Clear…
            </Btn>
          }
        />
      </SettingsSection>

      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing?.name ?? "this extension"}?`}
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (!removing) return;
          try {
            await ipc("browser:removeExtension", removing.id);
            setRemoving(null);
          } catch (error) {
            toast.error(`Couldn't remove ${removing.name}: ${error}`);
          }
        }}
      >
        <Text variant="small">
          Its settings go with it. You can add it again from the Web Store.
        </Text>
      </Dialog>

      <Dialog
        open={clearing}
        onOpenChange={setClearing}
        title="Clear browsing data?"
        confirmLabel="Clear"
        confirmVariant="destructive"
        onConfirm={async () => {
          try {
            await ipc("browser:clearData");
            setClearing(false);
            toast.success("Browsing data cleared");
          } catch (error) {
            toast.error(`Couldn't clear browsing data: ${error}`);
          }
        }}
      >
        <Text variant="small">
          You'll be signed out of the sites you use in Otter Mail's browser. Your mail isn't
          affected.
        </Text>
      </Dialog>
    </SettingsPageContainer>
  );
}
