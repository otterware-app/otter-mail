/**
 * The page a browser sign-in ends on (Google, Microsoft, Todoist): the
 * desktop app's loopback listeners, the relay's sign-in popups and the dev
 * runner's `--login`. One look for all of them, the app's own: its canvas,
 * text colors and font (apps/web/src/styles.css), light or dark with
 * the system.
 */

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CHECK = `<path d="M5 10.5l3.2 3.2L15 7" />`;
const CROSS = `<path d="M6.5 6.5l7 7M13.5 6.5l-7 7" />`;

export interface SignInPage {
  /** What happened, in a few words ("Signed in to Otter Mail"). */
  title: string;
  /** What to do next ("You can close this tab."). */
  detail?: string;
  /** Whether it worked: a check, or a cross in the destructive color. */
  ok: boolean;
  /** A script to run on the page (the relay's popups hand the result to the app). */
  script?: string;
  /** A CSP nonce for the style and script, where the page has a strict policy. */
  nonce?: string;
}

export function signInPage({ title, detail, ok, script, nonce }: SignInPage): string {
  const n = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · Otter Mail</title>
<style${n}>
:root{--canvas:#fcfcfc;--foreground:#27272a;--muted:#71717a;--ok:#16a34a;--bad:#dc2626;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--canvas:#0a0a0a;--foreground:#f5f5f5;--muted:#8a8a8a;--ok:#22c55e;--bad:#f87171}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--canvas);color:var(--foreground);font:13px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter Variable","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(360px,calc(100vw - 32px));text-align:center}
svg{width:36px;height:36px;margin-bottom:12px;color:${ok ? "var(--ok)" : "var(--bad)"}}
h1{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere}
p{margin:6px 0 0;color:var(--muted)}
</style></head>
<body><main>
<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="8.5" stroke-width="1.2" opacity=".35" />${ok ? CHECK : CROSS}</svg>
<h1>${escapeHtml(title)}</h1>
${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
</main>${script ? `\n<script${n}>${script}</script>` : ""}</body></html>`;
}
