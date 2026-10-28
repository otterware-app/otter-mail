/**
 * The card above a sign-in or verification email, like Gmail's: the
 * one-time code it carries, so it never has to be selected by hand. A code
 * is spent once used, so Copy also moves the mail to the Trash (with the
 * usual Undo). The code is found by @otter-mail/shared/verification-code.
 */

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, KeyRoundIcon } from "lucide-react";
import { toast } from "./toast";
import { Btn } from "./ui";

export function CodeCard({ code, onTrash }: { code: string; onTrash?: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () =>
    void navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        onTrash?.();
      },
      () => toast.error("Couldn't copy"),
    );

  return (
    <div className="mb-4 flex items-center gap-3 rounded-2xl border border-border/60 bg-card p-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-surface">
        <KeyRoundIcon className="size-4 text-muted-foreground" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-muted-foreground">Verification code</div>
        <div className="truncate font-mono text-lg font-semibold tracking-wider text-foreground select-all">
          {code}
        </div>
      </div>
      <Btn size="sm" onClick={copy}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : onTrash ? "Copy & trash" : "Copy"}
      </Btn>
    </div>
  );
}
