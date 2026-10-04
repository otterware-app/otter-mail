import type { CSSProperties } from "react";

/**
 * The setup's backdrop: lines of
 * real-sounding mail drifting past, too soft to read. The middle stays clear
 * for the step in front of it, and the field fades out at the top and bottom.
 */

const LINES = [
  "Hi Sam, our contract renews on 1 November. We'd like to add 40 seats and move to annual billing.",
  "Thanks for the time today. As promised, the order form is attached. Let me know if legal wants changes.",
  "Can we move the sync to 2pm? I have a dentist appointment, and I'd rather not rush the agenda.",
  "Priya has invited you to Design review on Friday at 2:00 PM. Reply to let her know if you can make it.",
  "Your invoice for September is ready. The total is $4,812.33 and it is due in 30 days.",
  "Élodie passed the technical screen and was strong on distributed systems. Can we schedule the onsite?",
  "Everything looks right to me, except SSO: it is Enterprise-only for now, so keep that off the pricing page.",
  "Brewery! Some of us have kids to pick up, so an early start works better than dinner.",
  "Reminder: the annual security training is due by 15 October. It takes about twenty minutes.",
  "I went through the components and left comments on the doc. Nothing blocking, just a few naming things.",
  "This week we shipped faster builds, a new profiler and a fix for the flaky test everyone hated.",
  "Glad the numbers work. SSO can be live well before your freeze, and I'll send our SOC 2 report tomorrow.",
];

/** Seconds per loop, row by row: slow enough to feel still. */
const PACE = [1800, 2200, 1600, 2000, 2400, 1700, 2100, 1500, 2300, 1900];

// Each row repeats one period twice, so sliding it by half loops seamlessly.
// Enough rows for the tallest window (~2,100px); the rest are clipped.
const ROWS = Array.from({ length: 80 }, (_, i) => {
  let period = "";
  for (let j = 0; j < 8; j++) period += LINES[(i * 5 + j * 7) % LINES.length] + "          ";
  return period + period;
});

const MASK = [
  "linear-gradient(to bottom, transparent 0%, #000 14%, #000 86%, transparent 100%)",
  "radial-gradient(ellipse 50% 56% at 50% 50%, transparent 0%, transparent 58%, #000 100%)",
].join(", ");

const MASK_STYLE: CSSProperties = {
  maskImage: MASK,
  WebkitMaskImage: MASK,
  maskComposite: "intersect",
  WebkitMaskComposite: "source-in",
};

export function MailField() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      style={MASK_STYLE}
    >
      <div className="whitespace-pre text-[13px] leading-[1.65rem] text-foreground opacity-[0.055] dark:opacity-[0.06]">
        {ROWS.map((text, i) => (
          <div
            key={text}
            className="w-max motion-safe:animate-[mail-field-slide_1s_linear_infinite]"
            style={{
              animationDuration: `${PACE[i % PACE.length]}s`,
              animationDirection: i % 2 ? "reverse" : undefined,
            }}
          >
            {text}
          </div>
        ))}
      </div>
    </div>
  );
}
