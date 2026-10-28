import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { todoistApi } from "./api";
import { browseTodoist, useTodoistStatus } from "./dialogs";
import { Btn } from "../../mail/ui";
import { Input } from "~/components/ui/input";
import { toast } from "../../mail/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../../settings/settings-ui";
import { searchableSetting } from "../../settings/settings-search";

export function TodoistSettingsPane() {
  const status = useTodoistStatus();
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const change = async (action: () => Promise<void>) => {
    setPending(true);
    try {
      await action();
      setToken("");
      await qc.resetQueries({ queryKey: ["todoist"] });
      await status.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsPageContainer
      title="Integrations"
      description="Connect the tools you use alongside your mail."
    >
      <SettingsSection {...searchableSetting("todoist")}>
        <SettingsRow
          title="Todoist"
          description={
            status.isError
              ? "Could not read the connection. Try again."
              : !status.data
                ? "Loading…"
                : status.data.connected
                  ? "Connected on this device. Create, edit and complete tasks, manage reminders and browse projects."
                  : "Turn emails into tasks and manage your Todoist tasks here."
          }
          control={
            status.data?.connected ? (
              <Btn size="sm" onClick={browseTodoist}>
                Browse tasks
              </Btn>
            ) : status.isError ? (
              <Btn size="sm" onClick={() => void status.refetch()}>
                Retry
              </Btn>
            ) : undefined
          }
        />
        <SettingsRow
          title="Connect with Todoist"
          description={
            __DEMO__
              ? "Connect a pretend Todoist account to try every task feature."
              : "Sign in securely in your browser. Your connection stays on this device."
          }
          control={
            <Btn
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={() =>
                void change(
                  __DEMO__ ? () => todoistApi.connectTodoist("demo") : todoistApi.signInTodoist,
                )
              }
            >
              {pending
                ? "Connecting…"
                : status.data?.connected
                  ? "Reconnect with Todoist"
                  : "Connect with Todoist"}
            </Btn>
          }
        />
        <details>
          <summary className="cursor-pointer px-4 py-3 text-sm text-muted-foreground">
            Connect using an API token
          </summary>
          <SettingsRow
            title="API token"
            description={
              <span>
                Get your token from{" "}
                <a
                  href="https://app.todoist.com/app/settings/integrations/developer"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Todoist’s developer settings
                </a>
                . Kept on this device only.{" "}
                {__DEMO__ ? "In this demo, use the token demo for a pretend Todoist account." : ""}
              </span>
            }
            control={
              <Input
                type="password"
                autoComplete="off"
                aria-label="Todoist API token"
                placeholder={status.data?.connected ? "Replace token" : "API token"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={pending}
              />
            }
          />
          <SettingsRow
            title={status.data?.connected ? "Connection" : "Connect Todoist"}
            description="The token is verified before it is saved."
            control={
              <div className="flex gap-2">
                <Btn
                  size="sm"
                  variant="primary"
                  disabled={pending || !token.trim() || !status.data}
                  onClick={() => void change(() => todoistApi.connectTodoist(token))}
                >
                  {pending ? "Saving…" : status.data?.connected ? "Replace token" : "Connect"}
                </Btn>
                {status.data?.connected ? (
                  <Btn
                    size="sm"
                    disabled={pending}
                    onClick={() => void change(todoistApi.disconnectTodoist)}
                  >
                    Disconnect
                  </Btn>
                ) : null}
              </div>
            }
          />
        </details>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
