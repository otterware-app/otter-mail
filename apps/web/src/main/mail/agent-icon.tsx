import type { SVGProps } from "react";

/** Otterware's agent (assets/agent): a face with two eyes, the set's one path. */
const FACE =
  "M305 194C422 176 592 178 700 210C786 236 839 298 845 388C851 472 834 585 795 669C747 773 655 823 543 827C424 832 310 791 244 707C186 633 168 529 180 425C191 311 219 214 305 194Z M300 454C350 441 412 441 465 449C474 460 472 479 461 489C409 500 350 493 315 480C303 474 296 463 300 454Z M565 451C616 442 672 439 721 450C731 463 723 478 709 484C665 499 610 499 574 488C562 478 559 462 565 451Z";

/**
 * The agent, wherever the app shows it, in the current color. It stands in
 * for a Lucide icon: 24 by default, sized by its class or its parent.
 */
export function AgentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    // The set's 1024 square less its margin, so the face is as large as the icons beside it.
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="96 88 832 832"
      aria-hidden
      {...props}
    >
      <path fill="currentColor" fillRule="evenodd" d={FACE} />
    </svg>
  );
}
