import { useRef, useState, type DragEvent } from "react";
import { toast } from "./toast";
import { PaperclipIcon, XIcon } from "lucide-react";
import { gmailApi } from "./api";
import { AttachmentPreview, attachmentPreview } from "./attachment-preview";
import type { ComposeAttachment } from "./types";

/** Mirror of the backend cap (core services/outgoing.ts) so renderer-side drops fail early. */
const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentBytes(a: ComposeAttachment): number {
  return a.size || Math.floor((a.base64.length * 3) / 4);
}

/** Loads a saved message's attachments into memory (drafts must re-send them
    on every save, so they're needed before any edit is saved). */
export async function loadMessageAttachments(
  accountId: string,
  messageId: string,
  attachments: { id: string; filename: string; mimeType: string }[],
): Promise<ComposeAttachment[]> {
  const out: ComposeAttachment[] = [];
  for (const att of attachments) {
    const data = await gmailApi.getAttachmentData({ accountId, messageId, attachmentId: att.id });
    out.push({
      key: att.id,
      name: att.filename,
      mimeType: att.mimeType,
      size: data.size,
      base64: data.base64,
    });
  }
  return out;
}

/** Open the native file picker; the backend enforces the 25 MB total cap. */
export async function pickComposeAttachments(
  existing: ComposeAttachment[],
): Promise<ComposeAttachment[]> {
  const existingBytes = existing.reduce((sum, a) => sum + attachmentBytes(a), 0);
  try {
    const res = await gmailApi.pickAttachments(existingBytes);
    if (res.error) toast.error(res.error);
    return (res.attachments ?? []).map((attachment) => ({
      ...attachment,
      key: crypto.randomUUID(),
    }));
  } catch {
    toast.error("Could not attach files");
    return [];
  }
}

function readFileAsAttachment(file: File): Promise<ComposeAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(reader.error ?? new Error("read failed")), {
      once: true,
    });
    reader.addEventListener(
      "load",
      () => {
        // FileReader gives a `data:<mime>;base64,<payload>` URL — keep the payload.
        const result = String(reader.result ?? "");
        const comma = result.indexOf(",");
        resolve({
          key: crypto.randomUUID(),
          name: file.name || "attachment",
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          base64: comma >= 0 ? result.slice(comma + 1) : "",
        });
      },
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

/**
 * Read dropped/pasted files into attachments in the renderer (base64), skipping
 * any that would push the running total past the 25 MB cap.
 */
export async function filesToComposeAttachments(
  files: File[],
  existing: ComposeAttachment[],
): Promise<ComposeAttachment[]> {
  let total = existing.reduce((sum, a) => sum + attachmentBytes(a), 0);
  const out: ComposeAttachment[] = [];
  let skipped = false;
  for (const file of files) {
    if (total + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
      skipped = true;
      continue;
    }
    try {
      out.push(await readFileAsAttachment(file));
      total += file.size;
    } catch {
      skipped = true;
    }
  }
  if (skipped) toast.error("Some files were skipped (25 MB total limit)");
  return out;
}

/**
 * Gmail-style drag-and-drop: drop files anywhere on the composer to attach.
 * Returns `dropProps` to spread on the drop container and `isDragging` for the
 * overlay. Ignores internal drags (e.g. dragging an attachment out to Finder),
 * which carry no `Files` type.
 */
export function useComposeFileDrop(
  onFiles: (files: File[]) => void,
  disabled?: boolean,
): { isDragging: boolean; dropProps: Record<string, (e: DragEvent) => void> } {
  const [isDragging, setIsDragging] = useState(false);
  const depth = useRef(0);
  const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return {
    isDragging,
    dropProps: {
      onDragEnter: (e) => {
        if (disabled || !carriesFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setIsDragging(true);
      },
      onDragOver: (e) => {
        if (disabled || !carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (e) => {
        if (disabled || !carriesFiles(e)) return;
        // dragenter/leave fire per child element; count depth so leaving a child
        // doesn't dismiss the overlay while still over the container.
        depth.current -= 1;
        if (depth.current <= 0) {
          depth.current = 0;
          setIsDragging(false);
        }
      },
      onDrop: (e) => {
        if (disabled) return;
        e.preventDefault();
        depth.current = 0;
        setIsDragging(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) onFiles(files);
      },
    },
  };
}

/** Full-cover "Drop files to attach" hint; pointer-events-none so the drop lands on the container. */
export function ComposeDropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035] text-foreground backdrop-blur-sm">
      <PaperclipIcon className="size-6 text-primary" />
      <span className="text-sm font-semibold">Drop files to attach</span>
    </div>
  );
}

/** Above this, autosave waits longer: every save re-uploads the attachments. */
const HEAVY_ATTACHMENT_BYTES = 1024 * 1024;

/** Autosave debounce for a draft carrying these attachments. */
export function autosaveDelayMs(attachments: ComposeAttachment[] | null): number {
  const bytes = (attachments ?? []).reduce((sum, a) => sum + attachmentBytes(a), 0);
  return bytes > HEAVY_ATTACHMENT_BYTES ? 5000 : 1500;
}

/** Stable signature for autosave dirty-checks. */
export function attachmentSignature(attachments: ComposeAttachment[] | null): string {
  return (attachments ?? []).map((a) => `${a.name}:${a.size}`).join("|");
}

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: ComposeAttachment[] | null;
  onRemove: (index: number) => void;
}) {
  const [previewing, setPreviewing] = useState<ComposeAttachment | null>(null);
  if (!attachments || attachments.length === 0) return null;
  const openInApp = (att: ComposeAttachment) => {
    void gmailApi
      .openComposeAttachment({ name: att.name, base64: att.base64 })
      .catch(() => toast.error("Could not open attachment"));
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-5 pb-1 pt-2">
      {attachments.map((att, i) => (
        <span
          key={att.key ?? `${att.name}:${att.mimeType}:${att.size}`}
          className="flex h-8 max-w-64 items-center gap-1.5 rounded-xl border border-border/40 bg-accent-surface/60 pl-2.5 pr-1 text-sm text-foreground"
        >
          <button
            type="button"
            title={att.name}
            aria-label={`Open ${att.name}`}
            onClick={() =>
              attachmentPreview(att.name, att.mimeType) ? setPreviewing(att) : openInApp(att)
            }
            className="flex min-w-0 cursor-pointer items-center gap-1.5 hover:text-foreground"
          >
            <PaperclipIcon className="size-3 shrink-0 text-muted-foreground/70" />
            <span className="min-w-0 truncate">{att.name}</span>
          </button>
          <span className="shrink-0 text-muted-foreground/70">{formatBytes(att.size)}</span>
          <button
            type="button"
            aria-label={`Remove ${att.name}`}
            onClick={() => onRemove(i)}
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <AttachmentPreview
        file={
          previewing && {
            name: previewing.name,
            mimeType: previewing.mimeType,
            size: attachmentBytes(previewing),
            load: async () => previewing.base64,
            onOpen: () => openInApp(previewing),
          }
        }
        onClose={() => setPreviewing(null)}
      />
    </div>
  );
}
