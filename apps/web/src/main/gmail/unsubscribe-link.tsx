/**
 * Gmail's "Unsubscribe" beside the sender, for mail with a List-Unsubscribe
 * header. A confirmation says what will happen (one-click request, an email
 * to the list, or opening the sender's page), then it's done in place.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "~/components/ui/dialog";
import { Text } from "~/components/ui/text";
import { toast } from "./toast";
import { gmailApi } from "./api";
import { openLink } from "../browser/store";

export function UnsubscribeLink({
  accountId,
  messageId,
  senderName,
  senderEmail,
}: {
  accountId: string;
  messageId: string;
  senderName: string;
  senderEmail: string;
}) {
  const qc = useQueryClient();
  const key = ["unsubscribe", accountId, messageId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => gmailApi.getUnsubscribe(accountId, messageId, senderEmail),
    staleTime: 10 * 60_000,
  });
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const info = query.data;
  if (!info) return null;
  const who = senderName || senderEmail;

  if (info.unsubscribed) {
    return <span className="shrink-0 text-[13px] text-muted-foreground/70">Unsubscribed</span>;
  }

  const run = async () => {
    setWorking(true);
    console.log("[UnsubscribeLink:run]", { method: info.method });
    try {
      const result = await gmailApi.unsubscribe(accountId, messageId);
      if ("openUrl" in result) {
        openLink(result.openUrl);
        toast.info(`Finish unsubscribing from ${who} on their page`);
      } else {
        qc.setQueryData(key, { ...info, unsubscribed: true });
        toast.success(`Unsubscribed from ${who}`);
      }
      setConfirming(false);
    } catch (error) {
      toast.error(
        `Couldn't unsubscribe: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setWorking(false);
    }
  };

  const explanation =
    info.method === "oneClick"
      ? `${who} will stop sending you mail to this list. It can take a few days.`
      : info.method === "mailto"
        ? `An unsubscribe request will be emailed to ${info.target}. It can take a few days.`
        : `The unsubscribe page on ${info.target} will open in your browser.`;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setConfirming(true);
        }}
        className="shrink-0 cursor-pointer text-[13px] text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
      >
        Unsubscribe
      </button>
      <Dialog
        open={confirming}
        onOpenChange={(open) => !working && setConfirming(open)}
        title={`Unsubscribe from ${who}?`}
        confirmLabel={
          working ? "Unsubscribing…" : info.method === "web" ? "Open page" : "Unsubscribe"
        }
        confirmVariant="accent"
        onConfirm={() => void run()}
      >
        <Text variant="small">{explanation}</Text>
      </Dialog>
    </>
  );
}
