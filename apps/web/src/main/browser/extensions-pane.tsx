import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, PuzzleIcon, SearchIcon } from "lucide-react";

import { Dialog } from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { Text } from "~/components/ui/text";
import { ipc } from "~/lib/ipc";
import { toast } from "../gmail/toast";
import { Btn, cn } from "../gmail/ui";
import { SettingsPageContainer } from "../settings/settings-ui";
import { CHROME_WEB_STORE_URL, openTab, setPinned, useBrowser } from "./store";

/** An installed extension (apps/desktop/src/services/extensions.ts' BrowserExtension). */
type Extension = {
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string | null;
  optionsUrl: string | null;
  enabled: boolean;
  siteAccess: string;
  permissions: string[];
};

const EXTENSIONS_KEY = ["browser-extensions"];
const DEVELOPER_MODE_KEY = "gmail:browser-developer-mode";

/** The installed extensions, kept current as they're added, turned off or removed. */
function useExtensions() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: EXTENSIONS_KEY,
    queryFn: () => ipc<Extension[]>("browser:extensions"),
  });
  useEffect(
    () =>
      window.desktopBridge.on("browser:extensionsChanged", () => {
        void queryClient.invalidateQueries({ queryKey: EXTENSIONS_KEY });
      }),
    [queryClient],
  );
  return query;
}

const PILL = "rounded-full px-3.5";

/**
 * Settings › Extensions (Mac): Chrome's extensions page, as ChatGPT has it.
 * Each one's card turns it on or off, shows its details, or removes it;
 * developer mode loads one from a folder.
 */
export function ExtensionsPane() {
  const extensions = useExtensions();
  const pinned = useBrowser((s) => s.pinned);
  const [query, setQuery] = useState("");
  const [developerMode, setDeveloperMode] = useState(
    () => localStorage.getItem(DEVELOPER_MODE_KEY) === "1",
  );
  const [details, setDetails] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Extension | null>(null);

  const all = extensions.data ?? [];
  const words = query.trim().toLowerCase();
  const shown = words
    ? all.filter((each) => `${each.name} ${each.description}`.toLowerCase().includes(words))
    : all;

  const toggle = async (extension: Extension, enabled: boolean) => {
    try {
      await ipc("browser:setExtensionEnabled", { id: extension.id, enabled });
    } catch (error) {
      toast.error(`Couldn't turn ${extension.name} ${enabled ? "on" : "off"}: ${error}`);
    }
  };

  const loadUnpacked = async () => {
    try {
      const loaded = await ipc<Extension | null>("browser:loadUnpacked");
      if (loaded) toast.success(`Loaded ${loaded.name}`);
    } catch (error) {
      toast.error(`Couldn't load the extension: ${error}`);
    }
  };

  return (
    <SettingsPageContainer
      title="Extensions"
      searchId="browser-extensions"
      action={
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          Developer mode
          <Switch
            checked={developerMode}
            onCheckedChange={(on) => {
              localStorage.setItem(DEVELOPER_MODE_KEY, on ? "1" : "0");
              setDeveloperMode(on);
            }}
          />
        </label>
      }
    >
      <div className="space-y-4 px-[1px]">
        <div className="flex items-center gap-2">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-foreground/[0.05] px-3.5 focus-within:bg-foreground/[0.08]">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search extensions"
              aria-label="Search extensions"
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          {developerMode ? (
            <Btn className={PILL} onClick={() => void loadUnpacked()}>
              Load unpacked
            </Btn>
          ) : null}
          <Btn className={PILL} onClick={() => openTab(CHROME_WEB_STORE_URL)}>
            Chrome Web Store
            <ArrowUpRightIcon className="size-4 text-muted-foreground" />
          </Btn>
        </div>

        <h2 className="px-4 pt-2 text-sm font-medium text-foreground">All extensions</h2>
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border/70 px-6 py-10 text-center">
            <PuzzleIcon className="size-6 text-muted-foreground" />
            <p className="text-sm text-foreground">
              {extensions.isPending
                ? "Loading…"
                : words
                  ? "No extensions match."
                  : "No extensions yet"}
            </p>
            {!words && !extensions.isPending ? (
              <p className="max-w-80 text-[13px] text-muted-foreground">
                Find one in the Chrome Web Store and choose Add to Otter Mail.
              </p>
            ) : null}
          </div>
        ) : (
          shown.map((extension) => (
            <div key={extension.id} className="rounded-xl border border-border/70 p-4">
              <div className="flex gap-4">
                {extension.icon ? (
                  <img src={extension.icon} alt="" className="mt-0.5 size-10 shrink-0" />
                ) : (
                  <PuzzleIcon className="mt-0.5 size-10 shrink-0 p-1.5 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {extension.name}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {extension.version}
                    </span>
                  </p>
                  <p className="mt-1 line-clamp-2 text-[13px] leading-[18px] text-muted-foreground">
                    {extension.description}
                  </p>
                </div>
              </div>
              {details === extension.id ? (
                <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 border-t border-border/70 pt-4 text-[13px]">
                  <dt className="text-muted-foreground">Site access</dt>
                  <dd className="text-foreground">{extension.siteAccess}</dd>
                  {extension.permissions.length > 0 ? (
                    <>
                      <dt className="text-muted-foreground">Permissions</dt>
                      <dd className="text-foreground">{extension.permissions.join(", ")}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">ID</dt>
                  <dd className="select-text font-mono text-xs text-foreground">{extension.id}</dd>
                  <dt className="text-muted-foreground">Pin to toolbar</dt>
                  <dd>
                    <Switch
                      checked={pinned.includes(extension.id)}
                      onCheckedChange={(on) => setPinned(extension.id, on)}
                    />
                  </dd>
                  <dd className="col-span-2 flex flex-wrap gap-2 pt-1">
                    {extension.optionsUrl ? (
                      <Btn
                        size="sm"
                        className={PILL}
                        onClick={() => openTab(extension.optionsUrl!)}
                      >
                        Extension options
                      </Btn>
                    ) : null}
                    <Btn
                      size="sm"
                      className={PILL}
                      onClick={() =>
                        openTab(`https://chromewebstore.google.com/detail/${extension.id}`)
                      }
                    >
                      View in Chrome Web Store
                    </Btn>
                  </dd>
                </dl>
              ) : null}
              <div className="mt-4 flex items-center gap-2">
                <Btn
                  size="sm"
                  className={cn(PILL, details === extension.id && "bg-accent-surface")}
                  onClick={() => setDetails(details === extension.id ? null : extension.id)}
                >
                  Details
                </Btn>
                <Btn size="sm" className={PILL} onClick={() => setRemoving(extension)}>
                  Remove
                </Btn>
                <span className="flex-1" />
                <Switch
                  aria-label={`${extension.name} on`}
                  checked={extension.enabled}
                  onCheckedChange={(on) => void toggle(extension, on)}
                />
              </div>
            </div>
          ))
        )}
      </div>

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
            setPinned(removing.id, false);
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
    </SettingsPageContainer>
  );
}
