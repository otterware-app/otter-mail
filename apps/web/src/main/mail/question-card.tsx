/**
 * The agent asking the user something mid-run (OpenClaw's `ask_user`), in
 * place of the composer like an approval: each question with its options
 * (one or several), room for an answer of the user's own, and Skip (Esc) or
 * Answer (↩). A single question with one choice answers on a click.
 */

import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatQuestion } from "./api";
import { COMPOSER_SURFACE } from "./composer-kit";
import { Btn, cn, Kbd } from "./ui";

export function QuestionCard({
  agent,
  question,
  pendingCount,
  responding,
  onAnswer,
}: {
  /** Who is asking ("OpenClaw"). */
  agent: string;
  question: ChatQuestion;
  pendingCount: number;
  responding: boolean;
  /** Answers by question id; null skips. */
  onAnswer: (answers: Record<string, string[]> | null) => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const card = useRef<HTMLDivElement>(null);
  // Secrets only go through the agent's own masked prompt.
  const secret = question.questions.some((q) => q.secret);
  const quick = question.questions.length === 1 && !question.questions[0].multiSelect && !secret;

  // The card takes the focus the composer had, so Esc skips.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) card.current?.focus();
  }, []);

  const answers = Object.fromEntries(
    question.questions.map((q) => {
      const typed = own[q.id]?.trim();
      return [q.id, [...(chosen[q.id] ?? []), ...(typed ? [typed] : [])]];
    }),
  );
  const complete = !secret && question.questions.every((q) => answers[q.id].length > 0);

  const choose = (id: string, label: string, multi: boolean) => {
    if (quick) return onAnswer({ [id]: [label] });
    setChosen((all) => {
      const current = all[id] ?? [];
      const next = multi
        ? current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
        : [label];
      return { ...all, [id]: next };
    });
    // One choice replaces a typed answer.
    if (!multi) setOwn((all) => ({ ...all, [id]: "" }));
  };

  return (
    <div
      ref={card}
      tabIndex={-1}
      role="group"
      aria-label={`${agent} asks`}
      onKeyDown={(event) => {
        if (responding) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onAnswer(null);
        } else if (event.key === "Enter" && !event.shiftKey && complete) {
          event.preventDefault();
          onAnswer(answers);
        }
      }}
      className={cn("flex flex-col gap-3 px-4 pt-3.5 pb-3 outline-none", COMPOSER_SURFACE)}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageCircleQuestionIcon className="size-3.5" aria-hidden />
        <span>{agent} asks</span>
        {pendingCount > 1 ? (
          <span className="ml-auto tabular-nums">1 of {pendingCount}</span>
        ) : null}
      </div>
      <div className="flex max-h-[45vh] min-w-0 flex-col gap-4 overflow-auto [scrollbar-width:thin]">
        {question.questions.map((q) => (
          <div key={q.id} className="flex flex-col gap-1.5">
            <p className="text-[15px] leading-snug text-foreground">{q.question}</p>
            {q.secret ? (
              <p className="text-[13px] text-muted-foreground">
                This asks for a secret, which only goes through {agent}&rsquo;s own app.
              </p>
            ) : (
              <>
                {q.multiSelect ? (
                  <p className="text-xs text-muted-foreground">Choose any that apply.</p>
                ) : null}
                <div className="flex flex-col gap-1">
                  {q.options.map((option) => {
                    const on = chosen[q.id]?.includes(option.label) ?? false;
                    return (
                      <button
                        key={option.label}
                        type="button"
                        role={q.multiSelect ? "checkbox" : "radio"}
                        aria-checked={on}
                        disabled={responding}
                        onClick={() => choose(q.id, option.label, q.multiSelect)}
                        className={cn(
                          "flex w-full cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-64",
                          on
                            ? "border-primary/60 bg-primary/8"
                            : "border-border/70 hover:bg-accent-surface",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                            q.multiSelect ? "rounded" : "rounded-full",
                            on
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border",
                          )}
                          aria-hidden
                        >
                          {on ? <CheckIcon className="size-3" /> : null}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="text-foreground">{option.label}</span>
                          {option.description ? (
                            <span className="text-muted-foreground">{option.description}</span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <input
                  value={own[q.id] ?? ""}
                  disabled={responding}
                  placeholder="Or answer in your own words"
                  aria-label={`Your own answer to: ${q.question}`}
                  onChange={(event) => {
                    const value = event.target.value;
                    setOwn((all) => ({ ...all, [q.id]: value }));
                    // Typing replaces a single choice.
                    if (!q.multiSelect && value) setChosen((all) => ({ ...all, [q.id]: [] }));
                  }}
                  className="h-8 rounded-lg border border-border/70 bg-transparent px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Btn
          size="sm"
          disabled={responding}
          onClick={() => onAnswer(null)}
          className="rounded-full pr-1.5"
        >
          Skip
          <Kbd>Esc</Kbd>
        </Btn>
        {secret ? null : (
          <Btn
            size="sm"
            disabled={responding || !complete}
            onClick={() => onAnswer(answers)}
            className="rounded-full pr-1.5"
          >
            Answer
            <Kbd>↩</Kbd>
          </Btn>
        )}
      </div>
    </div>
  );
}
