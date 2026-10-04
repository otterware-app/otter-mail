/**
 * Attachments open in the app, as Otter Code shows files: PDFs and HTML in a
 * frame, images, video and audio in place, text as text, Markdown rendered and
 * CSV as a table. One header row: the name, a rendered/source toggle where
 * there is one, then Open in the default app (Mac), Save and Close. Anything
 * else (Word, Keynote, zips, …) still opens in its app (Mac) or downloads (web).
 */

/* oxlint-disable react/no-array-index-key -- Table rows and columns have stable positions and may contain identical values. */
import { useEffect, useMemo, useState } from "react";
import {
  AppWindowIcon,
  Code2Icon,
  DownloadIcon,
  EyeIcon,
  LoaderCircleIcon,
  Table2Icon,
  XIcon,
} from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "~/components/ui/dialog";
import { features } from "../features";
import { ChatMarkdown } from "./chat-markdown";
import { formatAttachmentSize } from "./chat-attachments";
import { HintTooltip, IconBtn } from "./ui";

type PreviewKind = "pdf" | "html" | "markdown" | "table" | "text" | "image" | "video" | "audio";

export type PreviewFile = {
  name: string;
  mimeType: string;
  size: number;
  /** The file's bytes, as base64. */
  load: () => Promise<string>;
  /** Saves a copy (not offered for a file you're attaching: it's yours already). */
  onSave?: () => void;
  /** Opens it in its default app (the Mac app only). */
  onOpen?: () => void;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  htm: "text/html",
  html: "text/html",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp4: "video/mp4",
  webm: "video/webm",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  json: "application/json",
  log: "text/plain",
  txt: "text/plain",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

/** Images, video and audio Chromium plays itself (no HEIC, TIFF or AVI). */
const MEDIA_MIME =
  /^(image\/(avif|bmp|gif|x-icon|vnd\.microsoft\.icon|jpeg|png|svg\+xml|webp)|video\/(mp4|quicktime|webm)|audio\/(aac|flac|mp4|x-m4a|mpeg|mp3|ogg|wav|x-wav|webm))$/;

/**
 * What an attachment previews as, and the type to show it with. Mail often
 * labels files `application/octet-stream` (or `text/plain`), so a generic
 * type defers to the extension.
 */
export function attachmentPreview(
  name: string,
  mimeType: string,
): { kind: PreviewKind; mimeType: string } | null {
  let mime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!mime || mime === "application/octet-stream" || mime === "text/plain") {
    const extension = name.toLowerCase().split(".").at(-1) ?? "";
    mime = MIME_BY_EXTENSION[extension] ?? mime;
  }
  const kind: PreviewKind | null =
    mime === "application/pdf"
      ? "pdf"
      : mime === "text/html"
        ? "html"
        : mime === "text/markdown" || mime === "text/x-markdown"
          ? "markdown"
          : mime === "text/csv" || mime === "text/tab-separated-values"
            ? "table"
            : MEDIA_MIME.test(mime)
              ? (mime.split("/")[0] as "image" | "video" | "audio")
              : mime.startsWith("text/") ||
                  /^application\/(json|.*\+json|xml|.*\+xml|javascript|yaml|x-yaml|toml|sql)$/.test(
                    mime,
                  )
                ? "text"
                : null;
  return kind ? { kind, mimeType: mime } : null;
}

const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

/** Rejects binary data rather than showing replacement characters as a document. */
function decodeText(bytes: Uint8Array): { text: string; truncated: boolean } {
  const bounded = bytes.subarray(0, TEXT_PREVIEW_MAX_BYTES);
  if (bounded.includes(0)) throw new Error("This file contains binary data.");
  const truncated = bytes.length > bounded.length;
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bounded, { stream: truncated }),
      truncated,
    };
  } catch {
    throw new Error("This file is not UTF-8 text.");
  }
}

function decodeHtmlSource(bytes: Uint8Array): Loaded["text"] {
  try {
    return decodeText(bytes);
  } catch {
    return null;
  }
}

const MEDIA_KINDS = new Set<PreviewKind>(["image", "video", "audio"]);

/** Keeps quoted delimiters, escaped quotes and multiline cells; the source view has every byte. */
function parseDelimited(text: string, delimiter: "," | "\t") {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  let rowStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endCell = () => {
    if (row.length < 30) row.push(cell);
    else truncated = true;
    cell = "";
  };
  for (let index = rowStart; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        if (cell.length < 2000) cell += '"';
        else truncated = true;
        index++;
        continue;
      }
      if (quoted || cell === "") {
        quoted = !quoted;
        continue;
      }
    }
    if (!quoted && (char === delimiter || char === "\n" || char === "\r")) {
      endCell();
      if (char !== delimiter) {
        rows.push(row);
        row = [];
        if (char === "\r" && text[index + 1] === "\n") index++;
        rowStart = index + 1;
        if (rows.length === 100) return { rows, truncated: truncated || index < text.length - 1 };
      }
    } else if (cell.length < 2000) cell += char;
    else truncated = true;
  }
  if (rowStart < text.length) {
    endCell();
    rows.push(row);
  }
  return { rows, truncated: truncated || quoted };
}

/**
 * The preview window for one file, or none. The rest of the app keeps its
 * place underneath; Esc or Close puts it back.
 */
export function AttachmentPreview({
  file,
  onClose,
}: {
  file: PreviewFile | null;
  onClose: () => void;
}) {
  const preview = file ? attachmentPreview(file.name, file.mimeType) : null;
  return (
    <Dialog open={file !== null && preview !== null} onOpenChange={(open) => !open && onClose()}>
      {file && preview ? (
        <DialogContent
          aria-describedby={undefined}
          className="h-[85vh] max-w-5xl overflow-hidden bg-canvas!"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <PreviewSurface key={`${file.name}:${file.size}`} file={file} {...preview} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

type Loaded = { url: string; text: { text: string; truncated: boolean } | null };

function PreviewSurface({
  file,
  kind,
  mimeType,
}: {
  file: PreviewFile;
  kind: PreviewKind;
  mimeType: string;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const toggles = kind === "markdown" || kind === "html" || kind === "table";

  // The surface is keyed by its file; only Try again reloads it.
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    // oxlint-disable-next-line react/set-state-in-effect -- Start an external attachment load with its loading state before the async result arrives.
    setLoaded(null);
    setError(null);
    void (async () => {
      try {
        const base64 = await file.load();
        if (cancelled) return;
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        // Text that isn't text fails here rather than showing garbled. A page
        // in another charset still renders; only its source can't be shown.
        let text: Loaded["text"] = null;
        if (kind === "html") text = decodeHtmlSource(bytes);
        else if (kind !== "pdf" && !MEDIA_KINDS.has(kind)) text = decodeText(bytes);
        url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        setLoaded({ url, text });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load this file.");
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-run this DOM/reset lifecycle when its explicit trigger changes, even when the callback reads refs.
  }, [attempt, file, kind, mimeType]);

  const media = (message: string) => () => setError(message);
  const body = error ? (
    <div
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm"
    >
      <p className="text-muted-foreground">{error}</p>
      <button
        type="button"
        onClick={() => setAttempt((n) => n + 1)}
        className="rounded-lg border border-border px-2.5 py-1 text-xs text-foreground hover:bg-accent-surface"
      >
        Try again
      </button>
    </div>
  ) : !loaded ? (
    <div
      role="status"
      aria-label="Loading file"
      className="flex flex-1 items-center justify-center"
    >
      <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
    </div>
  ) : kind === "pdf" ? (
    // Chromium's viewer, with the header above as its only chrome: the page
    // alone, fitted to the width. Zoom, scrolling and find still work.
    // oxlint-disable-next-line react/iframe-missing-sandbox -- the PDF viewer needs an unsandboxed frame; a PDF runs no scripts
    <iframe
      src={`${loaded.url}#toolbar=0&view=FitH`}
      title={file.name}
      className="min-h-0 flex-1 border-0 bg-white"
    />
  ) : kind === "html" && rendered ? (
    // Mail's HTML is untrusted: no scripts, forms or popups, and an opaque origin.
    <iframe
      src={loaded.url}
      title={file.name}
      sandbox=""
      className="min-h-0 flex-1 border-0 bg-white"
    />
  ) : kind === "image" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        src={loaded.url}
        alt={file.name}
        className="max-h-full max-w-full object-contain"
        onError={media("Could not show this image.")}
      />
    </div>
  ) : kind === "video" ? (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video
        controls
        autoPlay
        playsInline
        src={loaded.url}
        aria-label={file.name}
        className="max-h-full max-w-full"
        onError={media("Could not play this video.")}
      />
    </div>
  ) : kind === "audio" ? (
    <div className="flex flex-1 items-center justify-center p-6">
      <audio
        controls
        autoPlay
        src={loaded.url}
        aria-label={file.name}
        className="w-full max-w-md"
        onError={media("Could not play this audio.")}
      />
    </div>
  ) : kind === "table" && rendered && loaded.text ? (
    <DelimitedTable
      name={file.name}
      text={loaded.text.text}
      delimiter={mimeType === "text/csv" ? "," : "\t"}
    />
  ) : kind === "markdown" && rendered && loaded.text ? (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-5">
        <ChatMarkdown text={loaded.text.text} />
      </div>
    </div>
  ) : !loaded.text ? (
    <p className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
      This file is not UTF-8 text.
    </p>
  ) : (
    <pre className="min-h-0 flex-1 overflow-auto px-5 py-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground select-text">
      {loaded.text.text}
    </pre>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 ps-4 pe-2">
        <DialogTitle className="min-w-0 truncate text-sm font-medium">{file.name}</DialogTitle>
        <span className="ms-1 shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatAttachmentSize(file.size)}
        </span>
        <span className="flex-1" />
        {toggles ? (
          <HintTooltip
            label={rendered ? "Show source" : kind === "table" ? "Show table" : "Show rendered"}
          >
            <IconBtn
              label={rendered ? "Show source" : kind === "table" ? "Show table" : "Show rendered"}
              active={!rendered}
              onClick={() => setRendered((value) => !value)}
            >
              {!rendered ? (
                kind === "table" ? (
                  <Table2Icon className="size-4" />
                ) : (
                  <EyeIcon className="size-4" />
                )
              ) : (
                <Code2Icon className="size-4" />
              )}
            </IconBtn>
          </HintTooltip>
        ) : null}
        {features.openFiles && file.onOpen ? (
          <HintTooltip label="Open in default app">
            <IconBtn label="Open in default app" onClick={file.onOpen}>
              <AppWindowIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
        ) : null}
        {file.onSave ? (
          <HintTooltip label="Save…">
            <IconBtn label="Save" onClick={file.onSave}>
              <DownloadIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
        ) : null}
        <HintTooltip label="Close">
          <DialogClose asChild>
            <IconBtn label="Close">
              <XIcon className="size-4" />
            </IconBtn>
          </DialogClose>
        </HintTooltip>
      </div>
      {loaded?.text?.truncated && !(kind === "html" && rendered) ? (
        <div className="shrink-0 border-b border-border/60 px-4 py-1.5 text-xs text-muted-foreground">
          Showing the first 1 MB. Save the file to read all of it.
        </div>
      ) : null}
      {body}
    </div>
  );
}

/** A bounded, readable table for CSV and TSV; the source view keeps every byte. */
function DelimitedTable({
  name,
  text,
  delimiter,
}: {
  name: string;
  text: string;
  delimiter: "," | "\t";
}) {
  const table = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  const [header, ...body] = table.rows;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {table.truncated ? (
        <div className="shrink-0 border-b border-border/60 px-4 py-1.5 text-xs text-muted-foreground">
          Showing the first 100 rows and 30 columns. Show the source for the rest.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-xs" aria-label={name}>
          {header ? (
            <thead className="sticky top-0 z-10">
              <tr>
                {header.map((cell, column) => (
                  <th
                    key={column}
                    scope="col"
                    className="max-w-80 border-b border-border bg-secondary px-3 py-1.5 text-left align-bottom font-medium whitespace-pre-wrap break-words"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, index) => (
              <tr key={index} className="even:bg-foreground/[0.03]">
                {row.map((cell, column) => (
                  <td
                    key={column}
                    className="max-w-80 border-b border-border/60 px-3 py-1.5 align-top whitespace-pre-wrap break-words tabular-nums"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
