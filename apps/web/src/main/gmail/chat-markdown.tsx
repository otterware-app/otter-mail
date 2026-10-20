import { createContext, memo, useContext, useEffect, useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageIcon, LoaderCircleIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog";
import { chatUrlTransform, isChatFileLink, isChatImageLink } from "./chat-links";

import { openLink } from "../browser/store";
import { isModClick } from "../keybindings/keys";

type ImagePreview = { src: string; alt: string };

/**
 * Where a web link in a chat opens, where a view decides (the workspace: as
 * the chat's tab); elsewhere, `openLink`'s place. `flip` is a ⌘-click.
 */
export const ChatLinkOpener = createContext<((url: string, flip: boolean) => void) | null>(null);
const LinkContext = createContext<{
  onOpenFile?: (href: string) => void;
  loadImage?: (href: string) => Promise<string>;
  showImage: (image: ImagePreview) => void;
}>({ showImage: () => {} });

function ChatLink({ href, children }: React.ComponentProps<"a">) {
  const { onOpenFile, showImage } = useContext(LinkContext);
  const open = useContext(ChatLinkOpener);
  return (
    <a
      href={href}
      className="text-primary underline underline-offset-2 hover:opacity-80"
      onClick={(event) => {
        event.preventDefault();
        if (!href) return;
        if (isChatFileLink(href)) onOpenFile?.(href);
        else if (isChatImageLink(href))
          showImage({ src: href, alt: typeof children === "string" ? children : "Image" });
        else if (open) open(href, isModClick(event));
        else openLink(href, { flip: isModClick(event) });
      }}
    >
      {children}
    </a>
  );
}

function ChatImage({ src, alt }: React.ComponentProps<"img">) {
  const { onOpenFile, showImage, loadImage } = useContext(LinkContext);
  const [loaded, setLoaded] = useState<{ href: string; src?: string; error?: string } | null>(null);
  const local = Boolean(src && isChatFileLink(src));
  useEffect(() => {
    if (!src || !local || !loadImage) return;
    let current = true;
    void loadImage(src).then(
      (resolved) => {
        if (current) setLoaded({ href: src, src: resolved });
      },
      (error: unknown) => {
        if (current)
          setLoaded({
            href: src,
            error: error instanceof Error ? error.message : "Couldn't load the image.",
          });
      },
    );
    return () => {
      current = false;
    };
  }, [src, local, loadImage]);
  if (!src) return <span>{alt || "Image unavailable"}</span>;
  const resolved = local ? (loaded?.href === src ? loaded.src : undefined) : src;
  if (!resolved)
    return (
      <button
        type="button"
        onClick={() => onOpenFile?.(src)}
        className="inline-flex min-h-28 w-full items-center justify-center gap-2 rounded-xl border border-border/60 bg-background/70 px-3 text-sm text-muted-foreground"
      >
        {loaded?.error || !loadImage ? (
          <ImageIcon className="size-4" />
        ) : (
          <LoaderCircleIcon className="size-4 animate-spin" />
        )}
        {loaded?.error || (loadImage ? "Loading image…" : alt || "View image")}
      </button>
    );
  return (
    <button
      type="button"
      aria-label={`View ${alt || "image"}`}
      className="inline-block max-w-full cursor-zoom-in overflow-hidden rounded-xl border border-border/60 align-middle"
      onClick={() => showImage({ src: resolved, alt: alt || "Image" })}
    >
      <img
        src={resolved}
        alt={alt || "Image"}
        loading="lazy"
        className="block max-h-80 max-w-full object-contain"
      />
    </button>
  );
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
  a: ChatLink,
  img: ChatImage,
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
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  onOpenFile,
  loadImage,
}: {
  text: string;
  onOpenFile?: (href: string) => void;
  loadImage?: (href: string) => Promise<string>;
}) {
  const [image, setImage] = useState<ImagePreview | null>(null);
  const links = useMemo(
    () => ({ onOpenFile, loadImage, showImage: setImage }),
    [onOpenFile, loadImage],
  );
  return (
    <>
      <LinkContext.Provider value={links}>
        <div className="flex select-text flex-col gap-3 text-sm leading-relaxed text-foreground wrap-break-word">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={COMPONENTS}
            urlTransform={chatUrlTransform}
          >
            {text}
          </Markdown>
        </div>
      </LinkContext.Provider>
      <Dialog open={image !== null} onOpenChange={(open) => !open && setImage(null)}>
        {image ? (
          <DialogContent aria-describedby={undefined} className="max-w-5xl">
            <DialogTitle className="sr-only">{image.alt}</DialogTitle>
            <img src={image.src} alt={image.alt} className="max-h-[80vh] w-full object-contain" />
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
});
