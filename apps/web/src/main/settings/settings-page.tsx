import { DEFAULT_SETTINGS } from "@otter-mail/contracts";
import { TodoistSettingsPane } from "../integrations/todoist";
import { useCallback, useEffect, useState } from "react";
import { Switch } from "~/components/ui/switch";
import { toast } from "../gmail/toast";
import { gmailApi, type MailApp, type NotificationsMode, type SettingsPane } from "../gmail/api";
import {
  getAdvanceDirection,
  setAdvanceDirection as persistAdvanceDirection,
  type AdvanceDirection,
} from "../gmail/advance-direction";
import { AppearancePane } from "./appearance-pane";
import { KeybindingsPane } from "./keybindings-pane";
import { AccountsPane } from "./accounts-pane";
import { OtterAccountPane } from "./otter-account-pane";
import { ProvidersPane } from "./providers-pane";
import { BrowserSettingsPane } from "../browser/browser-settings";
import { TranslationSection } from "./translation-section";
import { UpdatesSection } from "../updates";
import {
  RowSelect,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTargetProvider,
  SettingsSection,
} from "./settings-ui";
import { searchableSetting } from "./settings-search";
import { features } from "../features";
import { Btn } from "../gmail/ui";
import { requestTour, startSetup } from "../onboarding/onboarding";
import { requestProblemReport } from "../support/report-problem";
import { useRailUnreadDots } from "../gmail/space-rail";

/** Where the settings page is. */
export type SettingsRoute = {
  pane: SettingsPane;
  /** A settings-search result's anchor to scroll to, cleared once it's reached. */
  target?: string;
};

const NOTIFICATIONS_OPTIONS: { value: NotificationsMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "inbox", label: "Inbox only" },
  { value: "all", label: "All new mail" },
];

/** Auto-sync cadence choices in seconds; 0 = manual only. */
const SYNC_INTERVAL_OPTIONS = [
  { value: 0, label: "Manually" },
  { value: 15, label: "Every 15 seconds" },
  { value: 30, label: "Every 30 seconds" },
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
];

const ADVANCE_DIRECTION_OPTIONS: { value: AdvanceDirection; label: string }[] = [
  { value: "next", label: "Next message" },
  { value: "previous", label: "Previous message" },
  { value: "none", label: "Don't select another message" },
];

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function GeneralPane() {
  const [syncInterval, setSyncInterval] = useState<number | null>(null);
  const [notificationsMode, setNotificationsMode] = useState<NotificationsMode | null>(null);
  const [advanceDirection, setAdvanceDirectionState] = useState<AdvanceDirection>(() =>
    getAdvanceDirection(),
  );
  const [launchAtLogin, setLaunchAtLogin] = useState(DEFAULT_SETTINGS.launchAtLogin);
  const [trayEnabled, setTrayEnabled] = useState(DEFAULT_SETTINGS.trayEnabled);
  const [railDots, setRailDots] = useRailUnreadDots();
  const [dockBadge, setDockBadge] = useState(DEFAULT_SETTINGS.dockBadgeEnabled);
  const [mailApps, setMailApps] = useState<MailApp[]>([]);
  const [defaultMailBundleId, setDefaultMailBundleId] = useState<string | null>(null);

  const loadSyncSettings = async () => {
    console.log("[Settings:loadSyncSettings]");
    try {
      const settings = await gmailApi.getSyncSettings();
      setSyncInterval(settings.syncIntervalSeconds);
      setNotificationsMode(settings.notificationsMode);
      setLaunchAtLogin(settings.launchAtLogin);
      setTrayEnabled(settings.trayEnabled);
      setDockBadge(settings.dockBadgeEnabled);
    } catch (error) {
      toast.error(`Failed to load sync settings: ${error}`);
    }
  };

  const loadMailApps = async () => {
    if (!features.defaultMailApp) return;
    try {
      const result = await gmailApi.listMailApps();
      setMailApps(result.apps);
      setDefaultMailBundleId(result.defaultBundleId);
    } catch (error) {
      console.log("[Settings:listMailApps] failed", { error: String(error) });
    }
  };

  useEffect(() => {
    void loadSyncSettings();
    void loadMailApps();
    // Changed on another device.
    const offSettings = window.desktopBridge.on("settings:changed", () => void loadSyncSettings());
    const onStorage = () => setAdvanceDirectionState(getAdvanceDirection());
    window.addEventListener("storage", onStorage);
    return () => {
      offSettings();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const handleSyncIntervalChange = async (value: string) => {
    const seconds = Number(value);
    setSyncInterval(seconds);
    console.log("[Settings:setSyncInterval]", { seconds });
    try {
      await gmailApi.setSyncSettings({ syncIntervalSeconds: seconds });
    } catch (error) {
      toast.error(`Failed to save sync setting: ${error}`);
      void loadSyncSettings();
    }
  };

  const handleNotificationsModeChange = async (value: string) => {
    const mode = value as NotificationsMode;
    setNotificationsMode(mode);
    console.log("[Settings:setNotificationsMode]", { mode });
    try {
      await gmailApi.setSyncSettings({ notificationsMode: mode });
    } catch (error) {
      toast.error(`Failed to save notifications setting: ${error}`);
      void loadSyncSettings();
    }
  };

  const handleAdvanceDirectionChange = (value: string) => {
    const direction = value as AdvanceDirection;
    console.log("[Settings:setAdvanceDirection]", { direction });
    setAdvanceDirectionState(direction);
    persistAdvanceDirection(direction);
  };

  const handleLaunchAtLoginChange = async (checked: boolean) => {
    setLaunchAtLogin(checked);
    console.log("[Settings:setLaunchAtLogin]", { checked });
    try {
      await gmailApi.setSyncSettings({ launchAtLogin: checked });
    } catch (error) {
      toast.error(`Failed to save launch-at-login setting: ${error}`);
      void loadSyncSettings();
    }
  };

  const handleTrayEnabledChange = async (checked: boolean) => {
    setTrayEnabled(checked);
    console.log("[Settings:setTrayEnabled]", { checked });
    try {
      await gmailApi.setSyncSettings({ trayEnabled: checked });
    } catch (error) {
      toast.error(`Failed to save menu-bar icon setting: ${error}`);
      void loadSyncSettings();
    }
  };

  const handleDockBadgeChange = async (checked: boolean) => {
    setDockBadge(checked);
    console.log("[Settings:setDockBadgeEnabled]", { checked });
    try {
      await gmailApi.setSyncSettings({ dockBadgeEnabled: checked });
    } catch (error) {
      toast.error(`Failed to change Dock badge: ${error}`);
      void loadSyncSettings();
    }
  };

  const handleDefaultMailChange = async (bundleId: string) => {
    setDefaultMailBundleId(bundleId);
    console.log("[Settings:setDefaultMailApp]", { bundleId });
    try {
      await gmailApi.setDefaultMailApp(bundleId);
    } catch (error) {
      toast.error(`Failed to change default mail app: ${error}`);
    }
    // macOS may still put a consent dialog in the way — re-read the actual
    // state rather than trusting the optimistic selection.
    void loadMailApps();
  };

  // The rail's unread dots, next to the Dock badge in the Mac app; in Mail elsewhere.
  const railDotsRow = (
    <SettingsRow
      {...searchableSetting("rail-unread-dots")}
      resetAction={
        railDots ? (
          <SettingResetButton label="mailbox unread dots" onClick={() => setRailDots(false)} />
        ) : null
      }
      description="A dot on each mailbox in the rail whose Inbox has unread mail, and each view with unread mail."
      control={<Switch id="railUnreadDots" checked={railDots} onCheckedChange={setRailDots} />}
    />
  );

  return (
    <SettingsPageContainer title="General">
      {/* What only the Mac app has isn't shown elsewhere. */}
      {features.launchAtLogin || features.menuBar || features.dockBadge ? (
        <SettingsSection title="Startup, Dock & menu bar">
          {features.launchAtLogin ? (
            <SettingsRow
              {...searchableSetting("launch-at-login")}
              resetAction={
                launchAtLogin !== DEFAULT_SETTINGS.launchAtLogin ? (
                  <SettingResetButton
                    label="launch at login"
                    onClick={() => void handleLaunchAtLoginChange(DEFAULT_SETTINGS.launchAtLogin)}
                  />
                ) : null
              }
              description="Open Otter Mail automatically when you log in to your Mac."
              control={
                <Switch
                  id="launchAtLogin"
                  checked={launchAtLogin}
                  onCheckedChange={(checked) => void handleLaunchAtLoginChange(checked)}
                />
              }
            />
          ) : null}
          {features.menuBar ? (
            <SettingsRow
              {...searchableSetting("menu-bar-icon")}
              resetAction={
                trayEnabled !== DEFAULT_SETTINGS.trayEnabled ? (
                  <SettingResetButton
                    label="menu bar icon"
                    onClick={() => void handleTrayEnabledChange(DEFAULT_SETTINGS.trayEnabled)}
                  />
                ) : null
              }
              description="An Otter Mail icon in the menu bar with a quick unread inbox view."
              control={
                <Switch
                  id="trayEnabled"
                  checked={trayEnabled}
                  onCheckedChange={(checked) => void handleTrayEnabledChange(checked)}
                />
              }
            />
          ) : null}
          {features.dockBadge ? (
            <SettingsRow
              {...searchableSetting("dock-badge")}
              resetAction={
                dockBadge !== DEFAULT_SETTINGS.dockBadgeEnabled ? (
                  <SettingResetButton
                    label="dock badge"
                    onClick={() => void handleDockBadgeChange(DEFAULT_SETTINGS.dockBadgeEnabled)}
                  />
                ) : null
              }
              description="A badge with the number of unread messages in your inboxes."
              control={
                <Switch
                  id="dockBadgeEnabled"
                  checked={dockBadge}
                  onCheckedChange={(checked) => void handleDockBadgeChange(checked)}
                />
              }
            />
          ) : null}
          {features.dockBadge ? railDotsRow : null}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Mail">
        {features.dockBadge ? null : railDotsRow}
        <SettingsRow
          {...searchableSetting("sync-interval")}
          resetAction={
            syncInterval != null && syncInterval !== DEFAULT_SETTINGS.syncIntervalSeconds ? (
              <SettingResetButton
                label="check for new mail"
                onClick={() =>
                  void handleSyncIntervalChange(String(DEFAULT_SETTINGS.syncIntervalSeconds))
                }
              />
            ) : null
          }
          description="Sync runs in the background at this cadence."
          control={
            <RowSelect
              value={syncInterval != null ? String(syncInterval) : undefined}
              onValueChange={(v) => void handleSyncIntervalChange(v)}
              options={SYNC_INTERVAL_OPTIONS.map((o) => ({
                value: String(o.value),
                label: o.label,
              }))}
              ariaLabel="Check for new mail"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("notifications")}
          resetAction={
            notificationsMode != null &&
            notificationsMode !== DEFAULT_SETTINGS.notificationsMode ? (
              <SettingResetButton
                label="notifications"
                onClick={() =>
                  void handleNotificationsModeChange(DEFAULT_SETTINGS.notificationsMode)
                }
              />
            ) : null
          }
          description="Notify about new mail found by background sync."
          control={
            <RowSelect
              value={notificationsMode ?? undefined}
              onValueChange={(v) => void handleNotificationsModeChange(v)}
              options={NOTIFICATIONS_OPTIONS}
              ariaLabel="Notifications"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("advance-direction")}
          resetAction={
            advanceDirection !== "next" ? (
              <SettingResetButton
                label="after archive, delete, or move"
                onClick={() => handleAdvanceDirectionChange("next")}
              />
            ) : null
          }
          description="Which message to select next in the list."
          control={
            <RowSelect
              value={advanceDirection}
              onValueChange={handleAdvanceDirectionChange}
              options={ADVANCE_DIRECTION_OPTIONS}
              ariaLabel="After archive, delete, or move"
            />
          }
        />
      </SettingsSection>

      <TranslationSection />

      {features.defaultMailApp ? (
        <SettingsSection title="System">
          <SettingsRow
            {...searchableSetting("default-mail-app")}
            description="Which app opens mailto: links across macOS."
            control={
              <RowSelect
                value={defaultMailBundleId ?? undefined}
                onValueChange={(v) => void handleDefaultMailChange(v)}
                options={mailApps.map((app) => ({ value: app.bundleId, label: app.name }))}
                ariaLabel="Default email app"
              />
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Getting started">
        <SettingsRow
          {...searchableSetting("tour")}
          description="A minute's walk through the app, on your own mail."
          control={
            <Btn size="sm" onClick={requestTour}>
              Take the tour
            </Btn>
          }
        />
        <SettingsRow
          {...searchableSetting("setup")}
          description="Mailboxes, look, notifications, your agent and the keys, one step at a time."
          control={
            <Btn size="sm" onClick={() => startSetup()}>
              Run setup again
            </Btn>
          }
        />
      </SettingsSection>

      <UpdatesSection />
      <SettingsSection title="Support">
        <SettingsRow
          {...searchableSetting("send-feedback")}
          description="Report a bug or suggest a feature, with optional agent investigation."
          control={
            <Btn size="sm" onClick={requestProblemReport}>
              Send feedback
            </Btn>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** In-app settings: one pane at a time, chosen from the sidebar nav. */
export function SettingsPage({
  route,
  onNavigate,
}: {
  route: SettingsRoute;
  onNavigate: (route: SettingsRoute) => void;
}) {
  const clearTarget = useCallback(
    () => onNavigate({ ...route, target: undefined }),
    [onNavigate, route],
  );
  return (
    <SettingsSearchTargetProvider targetId={route.target ?? null} onTargetHandled={clearTarget}>
      <SettingsPane route={route} />
    </SettingsSearchTargetProvider>
  );
}

function SettingsPane({ route }: { route: SettingsRoute }) {
  if (route.pane === "appearance") return <AppearancePane />;
  if (route.pane === "keybindings") return <KeybindingsPane />;
  if (route.pane === "integrations") return <TodoistSettingsPane />;
  if (route.pane === "accounts") return <AccountsPane />;
  if (route.pane === "otter") return <OtterAccountPane />;
  if (route.pane === "agents") return <ProvidersPane />;
  if (route.pane === "browser" && features.browser) return <BrowserSettingsPane />;
  return <GeneralPane />;
}
