import { createServer } from "node:http";
import { signInPage } from "@otter-mail/shared/sign-in-page";

import { requestMain } from "../main-link.js";

/** A loopback callback owned by this attempt; no token enters the renderer. */
export async function todoistSignIn(
  authorize: (redirectUri: string) => Promise<string>,
): Promise<string> {
  let finish!: (url: string) => void;
  const callback = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let expectedState = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (
      url.pathname !== "/todoist/callback" ||
      !expectedState ||
      url.searchParams.get("state") !== expectedState
    ) {
      res.writeHead(400).end("Invalid sign-in callback.");
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      })
      .end(
        signInPage({
          title: "Connected to Todoist",
          detail: "You can close this window and return to Otter Mail.",
          ok: true,
        }),
      );
    finish(req.url!);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "localhost", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Could not start Todoist sign-in.");
    const origin = `http://localhost:${address.port}`;
    const url = await authorize(`${origin}/todoist/callback`);
    expectedState = new URL(url).searchParams.get("state") ?? "";
    await requestMain("openExternal", { url });
    return await Promise.race([
      callback.then((path) => `${origin}${path}`),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Todoist sign-in timed out. Try again.")),
          300000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    server.close();
    server.closeAllConnections();
  }
}
