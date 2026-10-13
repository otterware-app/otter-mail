import type { MailProviderKind } from "@otter-mail/contracts";
import { ServerIcon } from "lucide-react";
import gmailMark from "../assets/gmail.svg";

export function GmailMark({ className = "size-4" }: { className?: string }) {
  return <img src={gmailMark} className={`${className} object-contain`} alt="" aria-hidden />;
}

/** Microsoft's four squares, for Outlook. */
export function MicrosoftMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 21" className={className} aria-hidden>
      <path fill="#f25022" d="M1 1h9v9H1z" />
      <path fill="#7fba00" d="M11 1h9v9h-9z" />
      <path fill="#00a4ef" d="M1 11h9v9H1z" />
      <path fill="#ffb900" d="M11 11h9v9h-9z" />
    </svg>
  );
}

/** The connection's provider, beside its mailbox name. Older accounts are Gmail. */
export function ProviderMark({
  provider = "gmail",
  className = "size-3.5",
}: {
  provider?: MailProviderKind;
  className?: string;
}) {
  const label = provider === "gmail" ? "Gmail" : provider === "outlook" ? "Outlook" : "IMAP";
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0 items-center">
      {provider === "gmail" ? (
        <GmailMark className={className} />
      ) : provider === "outlook" ? (
        <MicrosoftMark className={className} />
      ) : (
        <ServerIcon className={className} aria-hidden />
      )}
    </span>
  );
}
