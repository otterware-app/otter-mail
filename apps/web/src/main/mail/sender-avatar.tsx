import { useQuery } from "@tanstack/react-query";
import { gmailApi } from "./api";

/** Deterministic hue per sender so people keep a stable identity color. */
function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

/**
 * Real sender photo when one exists (backend cascade: People API contact
 * photo → Gravatar → sender-domain logo, cached in the mail store), otherwise
 * the colored-initial tile.
 */
export function SenderAvatar({
  name,
  email,
  accountId,
  size = "md",
  className,
}: {
  name?: string;
  email: string;
  /** Account whose contacts may know this sender; omit to skip photo lookup. */
  accountId?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const normalizedEmail = email.trim().toLowerCase();
  const photoQuery = useQuery({
    queryKey: ["gmail:senderAvatar", normalizedEmail],
    queryFn: () => gmailApi.getSenderAvatar(accountId!, normalizedEmail),
    enabled: !!accountId && normalizedEmail.includes("@"),
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
    retry: false,
  });
  const photo = photoQuery.data?.dataUrl ?? null;

  const sizeClasses = size === "sm" ? "size-6 text-2xs rounded-md" : "size-9 text-sm rounded-lg";

  if (photo) {
    // Transparent logos need a white backing, but painting it under the whole
    // tile leaves a white fringe where the rounded corners antialias. Inset it
    // 1px so the edge blends into the surface instead.
    return (
      <span
        className={[
          "relative shrink-0 select-none overflow-hidden",
          sizeClasses,
          className ?? "",
        ].join(" ")}
        aria-hidden
      >
        <span className="absolute inset-px rounded-[inherit] bg-white" />
        <img
          src={photo}
          alt=""
          draggable={false}
          className="relative block size-full rounded-[inherit] object-cover"
        />
      </span>
    );
  }

  const source = (name ?? "").trim() || email;
  const initial = (source[0] ?? "?").toUpperCase();
  const hue = hueFor(normalizedEmail);
  return (
    <span
      className={[
        "shrink-0 flex items-center justify-center font-medium select-none",
        sizeClasses,
        className ?? "",
      ].join(" ")}
      style={{ backgroundColor: `hsl(${hue} 48% 52%)`, color: "#fff" }}
      aria-hidden
    >
      {initial}
    </span>
  );
}
