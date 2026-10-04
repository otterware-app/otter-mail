import { useLatest } from "../use-latest";
/**
 * Attachments in the agent chat, as Otter Code does them: paste an image
 * (or files), drop files anywhere on the panel ("Drop files to attach"), or
 * pick them with the paperclip. Files dropped from Finder travel by path;
 * pasted bytes are copied by the backend. Images show as thumbnails, other
 * files as rows, in the composer and in the sent message.
 */

import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { FileTextIcon, ImageIcon, LoaderCircleIcon, PaperclipIcon, XIcon } from "lucide-react";
import { toast } from "./toast";
import { gmailApi, type ChatAttachment } from "./api";
import { cn } from "./ui";

/** Otter Code's image types, 10 MB per image, 50 MB per file. */
const IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const IMAGE_EXTENSIONS = /\.(gif|jpe?g|png|webp)$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

/** What a sent message keeps (thumbnails are small data URLs, fit for storage). */
export type SentAttachment = { name: string; kind: "image" | "file"; size: number; thumb?: string };

type DraftAttachment = {
  key: string;
  name: string;
  kind: "image" | "file";
  size: number;
  /** Object URL for the composer preview (images). */
  previewUrl?: string;
  thumb?: string;
  staged?: ChatAttachment;
};

export function formatAttachmentSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function isImage(file: File): boolean {
  return (
    IMAGE_TYPES.has(file.type) ||
    ((!file.type || file.type === "application/octet-stream") && IMAGE_EXTENSIONS.test(file.name))
  );
}

/** A ≤240px JPEG of an image, small enough to keep in the chat history. */
function thumbnail(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener(
      "load",
      () => {
        const scale = Math.min(1, 240 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      },
      { once: true },
    );
    img.addEventListener("error", () => resolve(undefined), { once: true });
    img.src = url;
  });
}

/** The composer's attachments: add (validate + stage), remove, take on send. */
export function useChatAttachments() {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const itemsRef = useLatest(items);

  // Object URLs die with the draft.
  useEffect(
    () => () => {
      for (const item of itemsRef.current)
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    },
    [itemsRef],
  );

  const add = async (files: File[]) => {
    const room = MAX_ATTACHMENTS - itemsRef.current.length;
    if (files.length > room) {
      toast.error(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
      files = files.slice(0, Math.max(0, room));
    }
    for (const file of files) {
      const image = isImage(file);
      if (!image && file.type.startsWith("image/") && !/heic|heif/i.test(file.type)) {
        toast.error(
          `'${file.name}' is not a supported image type. Attach GIF, JPEG, PNG, or WebP images.`,
        );
        continue;
      }
      if (file.size === 0) {
        toast.error(`'${file.name}' is empty or could not be read.`);
        continue;
      }
      const limit = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (file.size > limit) {
        toast.error(`'${file.name}' exceeds the ${limit / 1024 / 1024} MB attachment limit.`);
        continue;
      }
      const key = crypto.randomUUID();
      const previewUrl = image ? URL.createObjectURL(file) : undefined;
      const name = file.name || (image ? "Pasted image.png" : "Attachment");
      setItems((list) => [
        ...list,
        { key, name, kind: image ? "image" : "file", size: file.size, previewUrl },
      ]);
      void (async () => {
        try {
          const item = {
            name,
            mime: file.type || "application/octet-stream",
            bytes: new Uint8Array(await file.arrayBuffer()),
          };
          const [thumb, result] = await Promise.all([
            previewUrl ? thumbnail(previewUrl) : Promise.resolve(undefined),
            gmailApi.agentStageAttachments([item]),
          ]);
          const staged = result.attachments[0];
          if (!staged) throw new Error(result.errors[0] ?? `'${name}' could not be attached.`);
          setItems((list) => list.map((a) => (a.key === key ? { ...a, staged, thumb } : a)));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
          setItems((list) => list.filter((a) => a.key !== key));
          if (previewUrl) URL.revokeObjectURL(previewUrl);
        }
      })();
    }
  };

  const remove = (key: string) =>
    setItems((list) => {
      const gone = list.find((a) => a.key === key);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return list.filter((a) => a.key !== key);
    });

  /** Hands the staged files to a send and clears the composer. */
  const take = (): { staged: ChatAttachment[]; sent: SentAttachment[] } => {
    const ready = itemsRef.current.filter((a) => a.staged);
    for (const item of itemsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setItems([]);
    return {
      staged: ready.map((a) => a.staged!),
      sent: ready.map((a) => ({ name: a.name, kind: a.kind, size: a.size, thumb: a.thumb })),
    };
  };

  return {
    items,
    add,
    remove,
    take,
    staging: items.some((a) => !a.staged),
    count: items.length,
  };
}

// ---------------------------------------------------------------------------
// Drop target (the whole panel)
// ---------------------------------------------------------------------------

const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes("Files");
const movedWithin = (e: DragEvent) =>
  e.relatedTarget !== null && e.currentTarget.contains(e.relatedTarget as Node);

/** Otter Code's workspace file drop: handlers for the panel + overlay state. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [active, setActive] = useState(false);
  // Cancelling a drag with Escape may never fire dragleave.
  useEffect(() => {
    const clear = () => setActive(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  return {
    active,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        if (!movedWithin(e)) setActive(true);
      },
      onDragOver: (e: DragEvent) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setActive(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        if (!movedWithin(e)) setActive(false);
      },
      onDrop: (e: DragEvent) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setActive(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      },
    },
  };
}

export function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]">
      <div
        role="status"
        className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
      >
        <PaperclipIcon className="size-4 text-primary" aria-hidden />
        Drop files to attach
      </div>
    </div>
  );
}

/** Otter Code's paste rule: images (or files without text) attach; text pastes. */
export function filesFromPaste(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  if (files.length === 0) return [];
  const text = data.getData("text/plain");
  if (files.some((f) => f.type.startsWith("image/"))) return files;
  return text ? [] : files;
}

// ---------------------------------------------------------------------------
// Composer strip + sent message
// ---------------------------------------------------------------------------

/**
 * An attachment in the composer: a compact two-line chip (mostly mail, so
 * a name and a detail say more than a preview would): a tile with the kind's
 * icon or a thumbnail, the name over a muted detail, and remove on hover.
 */
export function AttachmentChip({
  tile,
  name,
  detail,
  title,
  pending,
  off,
  onClick,
  onRemove,
}: {
  tile: ReactNode;
  name: string;
  detail?: string;
  title?: string;
  /** Still uploading. */
  pending?: boolean;
  /** Left out of the message (the attached mail, toggled off). */
  off?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      title={title ?? name}
      className={cn(
        "group/attachment relative flex h-11 w-max min-w-0 max-w-60 shrink-0 items-center gap-2 rounded-xl border border-foreground/10 bg-card py-1.5 pl-1.5 pr-3 transition-opacity",
        off && "opacity-50",
      )}
    >
      {onClick ? (
        <button
          type="button"
          aria-pressed={!off}
          aria-label={name}
          onClick={onClick}
          className="absolute inset-0 z-10 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
        />
      ) : null}
      <span className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-foreground/[0.06] text-muted-foreground [&_svg]:size-4">
        {tile}
        {pending ? (
          <span className="absolute inset-0 flex items-center justify-center bg-card/70">
            <LoaderCircleIcon className="animate-spin" />
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col">
        <span
          className={cn("truncate text-[13px] leading-4 text-foreground", off && "line-through")}
        >
          {name}
        </span>
        {detail ? (
          <span className="truncate text-[11px] leading-4 text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="absolute -right-1.5 -top-1.5 z-20 flex size-4.5 cursor-pointer items-center justify-center rounded-full border border-foreground/10 bg-popover text-muted-foreground opacity-0 shadow-sm hover:text-foreground group-hover/attachment:opacity-100 focus-visible:opacity-100"
        >
          <XIcon className="size-2.5" />
        </button>
      ) : null}
    </div>
  );
}

/** A file's extension, for its chip ("PDF", "XLSX"). */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1, dot + 6).toUpperCase() : "File";
}

/**
 * The composer's attachments as chips in a row at its top; `children` go
 * first (the attached mail).
 */
export function ComposerAttachments({
  items,
  onRemove,
  children,
}: {
  items: DraftAttachment[];
  onRemove: (key: string) => void;
  children?: ReactNode;
}) {
  if (items.length === 0 && !children) return null;
  return (
    <div className="flex gap-2 overflow-x-auto px-3 pb-0.5 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {children}
      {items.map((item) => (
        <AttachmentChip
          key={item.key}
          name={item.name}
          detail={
            item.kind === "image"
              ? "Image"
              : `${extensionOf(item.name)} · ${formatAttachmentSize(item.size)}`
          }
          pending={!item.staged}
          onRemove={() => onRemove(item.key)}
          tile={
            item.kind === "image" && item.previewUrl ? (
              <img className="size-full object-cover" alt="" src={item.previewUrl} />
            ) : item.kind === "image" ? (
              <ImageIcon />
            ) : (
              <FileTextIcon />
            )
          }
        />
      ))}
    </div>
  );
}

/** Attachments inside a sent user bubble (Otter Code's MessagesTimeline). */
/* oxlint-disable react/no-array-index-key -- Sent messages keep immutable attachment snapshots, including repeated filenames. */
export function SentAttachments({ attachments }: { attachments: SentAttachment[] }) {
  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind === "file");
  return (
    <>
      {images.length > 0 ? (
        <div
          className={cn(
            "mb-2 grid max-w-[210px] gap-2",
            images.length > 1 ? "grid-cols-2" : "grid-cols-1",
          )}
        >
          {images.map((image, i) => (
            <div
              key={i}
              className="aspect-[4/3] overflow-hidden rounded-xl border border-border/60 bg-background/70"
              title={image.name}
            >
              {image.thumb ? (
                <img src={image.thumb} alt={image.name} className="block size-full object-cover" />
              ) : (
                <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                  {image.name}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="mb-2 flex flex-col gap-1">
          {files.map((file, i) => (
            <div key={i} className="flex min-w-0 items-center gap-2 py-0.5 text-sm">
              <FileTextIcon className="size-4 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className="shrink-0 text-xs opacity-60">{formatAttachmentSize(file.size)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
/* oxlint-enable react/no-array-index-key */
