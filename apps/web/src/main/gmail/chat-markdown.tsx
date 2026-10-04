import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { openLink } from "../browser/store";

const COMPONENTS: Components = {
  p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) openLink(href);
      }}
      className="text-primary underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="my-1">{children}</li>,
  h1: ({ children }) => <h1 className="text-base font-semibold text-foreground">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="text-[0.9375rem] font-semibold text-foreground">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="text-sm font-semibold text-foreground">{children}</h3>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-2.5 text-muted-foreground">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) =>
    className?.includes("language-") ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded-md bg-foreground/8 px-1.5 py-0.5 font-mono text-[0.88em]">
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-xl bg-code px-4 py-3 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border/60 px-2.5 py-1.5 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border/60 px-2.5 py-1.5">{children}</td>,
  hr: () => <hr className="border-border/60" />,
};

/**
 * Agent replies rendered as GitHub-flavored markdown, styled for the app palette.
 * Links open in a browser tab (never navigate the app window). Memoized
 * on the text so streaming deltas only re-parse the growing string.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="flex select-text flex-col gap-3 text-sm leading-relaxed text-foreground">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
});
