import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { getAccountColor, getAccountDisplayName } from "./account-style";
import type { GmailAccount } from "./types";

/**
 * The account's Google profile picture, round unless `className` shapes it;
 * its colored initial until it loads, or without one.
 */
export function AccountPicture({
  account,
  className,
}: {
  account: GmailAccount;
  className?: string;
}) {
  return (
    <Avatar className={className} aria-hidden>
      {account.picture ? (
        <AvatarImage src={account.picture} alt="" referrerPolicy="no-referrer" />
      ) : null}
      <AvatarFallback
        className="rounded-[inherit] font-bold leading-none text-white"
        style={{ background: getAccountColor(account) }}
      >
        {(getAccountDisplayName(account)[0] ?? "?").toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
