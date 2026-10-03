import {
  createBrowserHistory,
  createHashHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { HomeView } from "./home-view";
import { RootView } from "./root-view";
import { QueryClient } from "@tanstack/react-query";
import { ErrorBoundaryView } from "~/components/ui/error-boundary-view";
import type { SettingsPane } from "./gmail/api";
import { COMBINED_ACCOUNT_ID } from "./gmail/custom-views";
import { SEARCH_MAILBOX } from "./gmail/gmail-query";
import { PROJECTS_SPACE } from "./gmail/spaces";

const rootRoute = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootView,
  errorComponent: ErrorBoundaryView,
  notFoundComponent: () => {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <div className="drag-region fixed top-0 left-0 right-0 h-(--workspace-topbar-height)" />
        <p className="text-[13px] text-muted-foreground">Route not found</p>
      </div>
    );
  },
});

/**
 * Mail and Settings share one layout (HomeView), which reads where it is from
 * the route below it; those routes render nothing themselves, so moving
 * between them never remounts the list or the reader (Otter Code's `_chat`).
 */
const mailRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "mail",
  component: HomeView,
});

/** Nowhere yet: HomeView reopens the last mailbox (or the default one). */
const indexRoute = createRoute({
  getParentRoute: () => mailRoute,
  path: "/",
  component: () => null,
});

const SETTINGS_PANES = new Set<string>([
  "general",
  "appearance",
  "keybindings",
  "accounts",
  "agents",
  "browser",
  "integrations",
  "otter",
]);

/** `?target=` a setting to scroll to. */
export type SettingsSearch = { target?: string };

const settingsRoute = createRoute({
  getParentRoute: () => mailRoute,
  path: "settings/$pane",
  params: {
    // A pane there isn't (any more) is General.
    parse: ({ pane }) => ({
      pane: SETTINGS_PANES.has(pane) ? (pane as SettingsPane) : "general",
    }),
    stringify: ({ pane }) => ({ pane }),
  },
  validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
    target: typeof search.target === "string" ? search.target : undefined,
  }),
  component: () => null,
});

// Spaces are account ids (their email addresses), `all` (the combined
// mailbox), a view's id (its one label is `all`), or `projects` (labels `all`
// and project ids). Labels are Gmail's (or IMAP's) ids and views' ids, but
// the app's own `__name__` ones read as `name`: the combined mailbox's
// built-in views and Search.
const toMailbox = (segment: string) =>
  segment === "all" ? COMBINED_ACCOUNT_ID : segment === "projects" ? PROJECTS_SPACE : segment;
const fromMailbox = (id: string) =>
  id === COMBINED_ACCOUNT_ID ? "all" : id === PROJECTS_SPACE ? "projects" : id;
const BUILT_IN_VIEWS = new Set([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "important",
  "allmail",
  "junk",
  "trash",
]);
const toLabel = (mailbox: string, segment: string) =>
  segment === "search"
    ? SEARCH_MAILBOX
    : mailbox === COMBINED_ACCOUNT_ID && BUILT_IN_VIEWS.has(segment)
      ? `__${segment}__`
      : segment;
const fromLabel = (id: string) => /^__([a-z]+)__$/.exec(id)?.[1] ?? id;
type MailParams = { mailbox: string; label: string };
const parseMail = (params: MailParams): MailParams => {
  const mailbox = toMailbox(params.mailbox);
  return { mailbox, label: toLabel(mailbox, params.label) };
};
const stringifyMail = (params: MailParams): MailParams => ({
  mailbox: fromMailbox(params.mailbox),
  label: fromLabel(params.label),
});

/** A mailbox's label or view: the list, with nothing open. */
const labelRoute = createRoute({
  getParentRoute: () => mailRoute,
  path: "$mailbox/$label",
  params: { parse: parseMail, stringify: stringifyMail },
  component: () => null,
});

/**
 * `?account=` the message's own mailbox, where it isn't this one (the
 * combined mailbox, searches); `?message=` one message of the conversation,
 * shown alone.
 */
export type MessageSearch = { account?: string; message?: string };

/** A conversation (or message) open in the reader. */
const messageRoute = createRoute({
  getParentRoute: () => mailRoute,
  path: "$mailbox/$label/$messageId",
  params: {
    parse: ({ messageId, ...params }) => ({ ...parseMail(params), messageId }),
    stringify: ({ messageId, ...params }) => ({ ...stringifyMail(params), messageId }),
  },
  validateSearch: (search: Record<string, unknown>): MessageSearch => ({
    account: typeof search.account === "string" ? search.account : undefined,
    message: typeof search.message === "string" ? search.message : undefined,
  }),
  component: () => null,
});

/** mail.otterware.app/app, the app's address before it moved to /. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "app",
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});

const routeTree = rootRoute.addChildren([
  mailRoute.addChildren([indexRoute, settingsRoute, labelRoute, messageRoute]),
  appRoute,
]);

const queryClient = new QueryClient();

const router = createRouter({
  routeTree,
  // The Mac app's pages are files (ottermail://app/index.html), so it keeps
  // the route in the hash; the web app's are real paths, which the site
  // Worker answers with the app.
  history: window.desktopBridge.platform === "web" ? createBrowserHistory() : createHashHistory(),
  // Mailboxes are email addresses: keep them readable.
  pathParamsAllowedCharacters: ["@"],
  // The query holds only strings (ids, addresses): plainly, where the default
  // would quote the ids that look like numbers.
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: (search) => {
    const entries = Object.entries(search).filter(([, value]) => value !== undefined);
    const query = new URLSearchParams(entries).toString().replaceAll("%40", "@");
    return query ? `?${query}` : "";
  },
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  context: {
    queryClient,
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export { router, queryClient };
