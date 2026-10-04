import { useState } from "react";
import { gmailApi, type ProviderSnapshot } from "../gmail/api";
import { useSetProvidersState } from "../gmail/agent-providers";
import { toast } from "../gmail/toast";
import { Btn } from "../gmail/ui";
import { SettingsRow, SettingsSection, TextInput } from "./settings-ui";

export function OpenRouterConnection({ provider }: { provider: ProviderSnapshot }) {
  const setState = useSetProvidersState();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const connected = provider.auth.status === "authenticated";

  const connect = async () => {
    setSaving(true);
    try {
      setState(await gmailApi.connectOpenRouter(key.trim()));
      setKey("");
      toast.success("OpenRouter connected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not connect OpenRouter.");
    } finally {
      setSaving(false);
    }
  };
  const disconnect = async () => {
    setSaving(true);
    try {
      setState(await gmailApi.disconnectOpenRouter());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disconnect OpenRouter.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="OpenRouter connection">
      <SettingsRow
        title="Mail and chat history"
        description="When you use this agent, your prompts and mail returned by its tools are sent to Otter Mail's server, OpenRouter and the selected model provider. Otter Mail keeps chat history until you delete the chat or your Otter account."
      />
      <SettingsRow
        title="API key"
        description="Saved on Otter Mail's server for your account. The agent and its chats are shared across your Mac, browser, and iPhone."
        control={
          <TextInput
            type="password"
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={connected ? "Replace API key" : "sk-or-…"}
            aria-label="OpenRouter API key"
            className="@min-[32rem]/settings-row:w-56"
          />
        }
      />
      <SettingsRow
        title={connected ? "Connected" : "Connect OpenRouter"}
        description="Usage is billed to your OpenRouter account."
        control={
          <div className="flex gap-2">
            <Btn
              size="sm"
              variant="primary"
              disabled={saving || !key.trim()}
              onClick={() => void connect()}
            >
              {saving ? "Saving…" : connected ? "Update key" : "Connect"}
            </Btn>
            {connected ? (
              <Btn size="sm" disabled={saving} onClick={() => void disconnect()}>
                Disconnect
              </Btn>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title="OpenRouter account"
        description="Create an API key or review your usage and credits."
        control={
          <div className="flex gap-2">
            <Btn
              size="sm"
              onClick={() =>
                void window.desktopBridge.openExternal("https://openrouter.ai/settings/keys")
              }
            >
              Get API key
            </Btn>
            <Btn
              size="sm"
              onClick={() =>
                void window.desktopBridge.openExternal("https://openrouter.ai/activity")
              }
            >
              Usage
            </Btn>
          </div>
        }
      />
      {provider.message ? (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
          {provider.message}
        </p>
      ) : null}
    </SettingsSection>
  );
}
