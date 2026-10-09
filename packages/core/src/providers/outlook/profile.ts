/**
 * The mailbox's name and photo, from Graph: the photo as a small data URL
 * (it can only be read signed in).
 */

import { toBase64 } from "../../bytes.js";
import { GraphError, graph, graphBytes } from "./graph.js";

export async function readProfile(accountId: string): Promise<{ name?: string; picture?: string }> {
  const me = await graph<{ displayName?: string }>(accountId, "/me?$select=displayName");
  let picture: string | undefined;
  try {
    const bytes = await graphBytes(accountId, "/me/photos/64x64/$value");
    if (bytes.length > 0) picture = `data:image/jpeg;base64,${toBase64(bytes)}`;
  } catch (err) {
    // No photo set (404), or a personal account's photo Graph won't serve.
    if (!(err instanceof GraphError)) throw err;
  }
  return { name: me.displayName?.trim() || undefined, picture };
}
