import { Button } from "~/components/ui/button";
import { ImapPasswordForm } from "./add-mailbox";
import { gmailApi } from "./api";
import { signInName, signInProvider, signsInWithPassword } from "./capabilities";
import { useAddAccount } from "./hooks";
import { toast } from "./toast";
import type { GmailAccount } from "./types";

/**
 * A mailbox with nothing to show because this device isn't signed in to it:
 * typically one added on another device, through the Otter account. One
 * click signs in (with Google, or Microsoft for Outlook), with the address
 * prefilled; an IMAP mailbox asks for its password, which never leaves the
 * device it was typed on.
 */
export function SignedOutMailbox({ account }: { account: GmailAccount }) {
  const signIn = useAddAccount(signInProvider(account));
  if (signsInWithPassword(account)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center">
        <span className="text-sm font-medium text-foreground">Not signed in on this device</span>
        <span className="text-sm text-muted-foreground">
          Enter the password for {account.email} to see its mail here.
        </span>
        <ImapPasswordForm account={account} className="items-center pt-3" />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center">
      <span className="text-sm font-medium text-foreground">Not signed in on this device</span>
      <span className="text-sm text-muted-foreground">
        Sign in to {account.email} with {signInName(account)} to see its mail here.
      </span>
      <div className="pt-3">
        {signIn.isPending ? (
          <Button size="small" onClick={() => void gmailApi.cancelAddAccount()}>
            Cancel sign-in
          </Button>
        ) : (
          <Button
            size="small"
            variant="accent"
            onClick={() =>
              void signIn.mutateAsync(account.email).catch((err: unknown) => {
                toast.error(`Couldn't sign in to ${account.email}`, {
                  description: err instanceof Error ? err.message : String(err),
                });
              })
            }
          >
            Sign in with {signInName(account)}
          </Button>
        )}
      </div>
    </div>
  );
}
