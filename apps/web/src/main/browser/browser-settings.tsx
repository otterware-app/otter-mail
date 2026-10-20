import { useState } from "react";

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
import { osNames } from "../os-names";
import { modKeyName } from "../keybindings/keys";
import { ExtensionsSection } from "./extensions-section";
import { setOpenLinksIn, useBrowser, type OpenLinksIn } from "./store";

const OPEN_LINKS_OPTIONS: { value: OpenLinksIn; label: string }[] = [
  { value: "app", label: "In Otter Mail" },
  { value: "browser", label: "In your default browser" },
];

/** Settings › Browser (Mac): where links open, extensions, browsing data. */
export function BrowserSettingsPane() {
  const openLinksIn = useBrowser((s) => s.openLinksIn);
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
          description={`Links in mail and chat open in a tab in the browser panel, or in your ${osNames.computer}'s default browser. ${modKeyName}-click opens one the other way.`}
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

      <ExtensionsSection />

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
