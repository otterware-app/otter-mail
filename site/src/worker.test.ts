import { describe, expect, it, vi } from "vite-plus/test";

import worker from "./worker.ts";

/** The site's files: anything else is missing. */
const FILES = new Set(["/", "/assets/app.js", "/todoist-callback/"]);

function serve(url: string, accept?: string) {
  const fetch = vi.fn(async (request: Request) => {
    const file = FILES.has(new URL(request.url).pathname);
    return new Response(file ? "asset" : "not found", { status: file ? 200 : 404 });
  });
  const env = { ASSETS: { fetch } as unknown as Fetcher };
  const headers = new Headers();
  if (accept) headers.set("accept", accept);
  const response = worker.fetch(new Request(url, { headers }), env);
  return { response, fetch };
}

const html = "text/html,application/xhtml+xml,*/*;q=0.8";

describe("site domain migration", () => {
  it("sends the old domain's home page, the consent screen's, to Otter Mail's page", async () => {
    const { response, fetch } = serve("https://mail.otterware.dev/");
    const result = await response;
    expect(result.status).toBe(301);
    expect(result.headers.get("location")).toBe("https://otterware.app/mail/");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["/app?view=inbox", "/privacy/", "/assets/app.js?version=2", "/missing"])(
    "redirects the old domain's %s before serving assets",
    async (path) => {
      const { response, fetch } = serve(`https://mail.otterware.dev${path}`);
      const result = await response;
      expect(result.status).toBe(308);
      expect(result.headers.get("location")).toBe(`https://mail.otterware.app${path}`);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("pages that moved to otterware.app", () => {
  it.each([
    ["/privacy/", "https://otterware.app/mail/privacy/"],
    ["/privacy", "https://otterware.app/mail/privacy/"],
    ["/terms/", "https://otterware.app/mail/terms/"],
    ["/changelog/", "https://otterware.app/mail/changelog/"],
    ["/changelog", "https://otterware.app/mail/changelog/"],
    ["/changelog/0.5.17/", "https://otterware.app/mail/changelog/#0.5.17"],
    ["/changelog/0.5.17", "https://otterware.app/mail/changelog/#0.5.17"],
    [
      "/changelog/images/0.5.17-settings-search.webp",
      "https://otterware.app/mail/changelog/images/0.5.17-settings-search.webp",
    ],
  ])("sends %s to %s", async (path, location) => {
    const { response, fetch } = serve(`https://mail.otterware.app${path}`, html);
    const result = await response;
    expect(result.status).toBe(301);
    expect(result.headers.get("location")).toBe(location);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the app's pages", () => {
  it.each(["/", "/app", "/you@gmail.com/INBOX/18f3a2", "/all/inbox", "/settings/appearance"])(
    "serves the app at %s",
    async (path) => {
      const { response, fetch } = serve(`https://mail.otterware.app${path}`, html);
      expect((await response).status).toBe(200);
      expect(fetch.mock.calls.at(-1)![0].url).toBe("https://mail.otterware.app/");
    },
  );

  it("serves the app's files", async () => {
    const { response } = serve("https://mail.otterware.app/assets/app.js", "*/*");
    expect((await response).status).toBe(200);
  });

  it("keeps a missing file missing", async () => {
    const { response, fetch } = serve("https://mail.otterware.app/assets/gone.js", "*/*");
    expect((await response).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
