/**
 * In-place email translation through Apple's on-device translator: which
 * language a message is in, whether the user reads it, and swapping a body's
 * text for its translation while keeping the markup (links, formatting,
 * images) exactly as it was.
 */

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gmailApi, type TranslationStatus } from "./api";
import type { GmailMessageDetail } from "./types";
import { features } from "../features";

/** Languages Apple's translator offers (LanguageAvailability.supportedLanguages). */
export const TRANSLATION_LANGUAGES = [
  "ar",
  "zh-Hans",
  "zh-Hant",
  "da",
  "nl",
  "en",
  "fi",
  "fr",
  "de",
  "he",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "ms",
  "nb",
  "pl",
  "pt",
  "ru",
  "es",
  "sv",
  "th",
  "tr",
  "uk",
  "vi",
] as const;

const displayNames = new Intl.DisplayNames(["en"], { type: "language" });

/** "de" → "German", "zh-Hant" → "Traditional Chinese". */
export function languageName(code: string): string {
  try {
    return displayNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Compares languages, not regional variants: "fr-CA" reads as "fr". */
export function sameLanguage(a: string, b: string): boolean {
  return a.split("-")[0].toLowerCase() === b.split("-")[0].toLowerCase();
}

/** The system's languages that the translator offers — the default reading list. */
export function systemReadLanguages(): string[] {
  const out: string[] = [];
  for (const tag of navigator.languages) {
    const match = TRANSLATION_LANGUAGES.find((code) =>
      code.startsWith("zh") ? tag.startsWith(code) : sameLanguage(code, tag),
    );
    if (match && !out.includes(match)) out.push(match);
  }
  return out.length > 0 ? out : ["en"];
}

export type ResolvedTranslationSettings = {
  /** Never empty; the first one is where translations go by default. */
  readLanguages: string[];
  autoTranslate: boolean;
};

const SETTINGS_KEY = ["translation-settings"] as const;

/** The reading languages (system languages until set) and auto-translate. */
export function useTranslationSettings(): ResolvedTranslationSettings {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => gmailApi.getTranslationSettings(),
    staleTime: Infinity,
    enabled: features.translation,
  });
  // Settings may change in another window; the backend tells every one.
  useEffect(
    () =>
      window.desktopBridge.on("translation:settingsChanged", () => {
        void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      }),
    [queryClient],
  );
  const saved = query.data?.readLanguages ?? [];
  return {
    readLanguages: saved.length > 0 ? saved : systemReadLanguages(),
    autoTranslate: query.data?.autoTranslate ?? false,
  };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const NON_CONTENT = "script, style, noscript, template, title, head";

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** The first few thousand characters of what the message says. */
function sampleText(detail: GmailMessageDetail): string {
  let text = detail.bodyText ?? "";
  if (detail.bodyHtml) {
    const doc = parseHtml(detail.bodyHtml);
    doc.querySelectorAll(NON_CONTENT).forEach((el) => el.remove());
    text = doc.body?.textContent ?? "";
  }
  return `${detail.subject}\n${text}`.replace(/\s+/g, " ").trim().slice(0, 3000);
}

/** Below this, a guess isn't worth offering a translation for. */
const MIN_CONFIDENCE = 0.6;

/** The message's language (BCP-47), or null while unknown or undetermined. */
export function useMessageLanguage(
  accountId: string,
  detail: GmailMessageDetail | undefined,
): string | null {
  const query = useQuery({
    queryKey: ["message-language", accountId, detail?.id],
    queryFn: async () => {
      const sample = sampleText(detail!);
      // A one-liner ("Danke!") says too little to be sure of.
      if (sample.length < 12) return null;
      const detection = await gmailApi.detectLanguage(sample);
      console.log("[translation:detect]", { messageId: detail!.id, ...detection });
      return detection.confidence >= MIN_CONFIDENCE ? detection.language : null;
    },
    // Without the translator there's nothing to offer, so no need to know.
    enabled: Boolean(detail) && features.translation,
    staleTime: Infinity,
    retry: false,
  });
  return query.data ?? null;
}

// ---------------------------------------------------------------------------
// Translating a body in place
// ---------------------------------------------------------------------------

export class TranslationUnavailableError extends Error {
  constructor(readonly status: Exclude<TranslationStatus, "ok">) {
    super(status);
  }
}

/** Worth translating: has letters and isn't just a link or an address. */
function hasWords(text: string): boolean {
  const t = text.trim();
  return /\p{L}/u.test(t) && !/^(https?:\/\/|www\.)\S+$/i.test(t) && !/^\S+@\S+\.\S+$/.test(t);
}

const SKIPPED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE", "SVG", "MATH"]);

/** Inline formatting a sentence can run through ("Sehr <b>geehrter</b> Herr"). */
const INLINE_FORMATTING = new Set([
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "S",
  "STRIKE",
  "SPAN",
  "FONT",
  "SMALL",
  "BIG",
  "SUB",
  "SUP",
  "MARK",
  "ABBR",
  "CITE",
  "Q",
  "TIME",
]);

/** Only text and inline formatting inside — no links, images or line breaks. */
function isPlainRun(el: Element): boolean {
  for (const child of el.children) {
    if (!INLINE_FORMATTING.has(child.tagName) || !isPlainRun(child)) return false;
  }
  return true;
}

/** A piece of text to translate and where the translation goes. */
type Slot = { text: string; apply: (translated: string) => void };

/** Keeps the original's surrounding whitespace around the translation. */
function withSpacing(original: string, translated: string): string {
  const lead = original.match(/^\s*/)?.[0] ?? "";
  const trail = original.match(/\s*$/)?.[0] ?? "";
  return lead + translated.trim() + trail;
}

function collectSlots(root: Element, slots: Slot[]): void {
  // A sentence split by bold/italic translates as one — word order changes
  // across languages, so fragments would read badly. Its inline formatting is
  // dropped; links and images never are.
  if (
    root.tagName !== "BODY" &&
    root.children.length > 0 &&
    isPlainRun(root) &&
    hasWords(root.textContent ?? "")
  ) {
    const original = root.textContent ?? "";
    slots.push({
      text: original.replace(/\s+/g, " ").trim(),
      apply: (t) => {
        root.textContent = withSpacing(original, t);
      },
    });
    return;
  }
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const original = node.nodeValue ?? "";
      if (!hasWords(original)) continue;
      slots.push({
        text: original.replace(/\s+/g, " ").trim(),
        apply: (t) => {
          node.nodeValue = withSpacing(original, t);
        },
      });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (SKIPPED.has(el.tagName.toUpperCase())) continue;
      collectSlots(el, slots);
    }
  }
}

/** Translates each slot's text (identical texts once) and writes it back. */
async function fillSlots(slots: Slot[], source: string, target: string): Promise<void> {
  const unique = [...new Set(slots.map((s) => s.text))];
  if (unique.length === 0) return;
  const result = await gmailApi.translate({ segments: unique, source, target });
  if (result.status !== "ok") throw new TranslationUnavailableError(result.status);
  const byText = new Map(unique.map((text, i) => [text, result.texts[i] ?? text]));
  for (const slot of slots) slot.apply(byText.get(slot.text) ?? slot.text);
}

async function translateHtml(html: string, source: string, target: string): Promise<string> {
  const doc = parseHtml(html);
  const slots: Slot[] = [];
  if (doc.body) collectSlots(doc.body, slots);
  await fillSlots(slots, source, target);
  doc.documentElement.lang = target;
  return "<!DOCTYPE html>" + doc.documentElement.outerHTML;
}

async function translatePlain(text: string, source: string, target: string): Promise<string> {
  // Line by line, keeping quote markers ("> ") and blank lines.
  const lines = text.split("\n");
  const slots: Slot[] = [];
  lines.forEach((line, i) => {
    const [, prefix, rest] = line.match(/^(\s*(?:>\s*)*)(.*)$/) ?? ["", "", line];
    if (!hasWords(rest)) return;
    slots.push({ text: rest.trim(), apply: (t) => (lines[i] = prefix + withSpacing(rest, t)) });
  });
  await fillSlots(slots, source, target);
  return lines.join("\n");
}

export type TranslatedBody = { bodyHtml: string | null; bodyText: string | null };

/** The message's body in `target`, same markup — fetched while `enabled`. */
export function useTranslatedBody(
  accountId: string,
  detail: GmailMessageDetail | undefined,
  source: string | null,
  target: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["message-translation", accountId, detail?.id, source, target],
    queryFn: async (): Promise<TranslatedBody> => {
      const startedAt = performance.now();
      const [bodyHtml, bodyText] = await Promise.all([
        detail!.bodyHtml ? translateHtml(detail!.bodyHtml, source!, target) : null,
        !detail!.bodyHtml && detail!.bodyText
          ? translatePlain(detail!.bodyText, source!, target)
          : null,
      ]);
      console.log("[translation:body]", {
        messageId: detail!.id,
        source,
        target,
        ms: Math.round(performance.now() - startedAt),
      });
      return { bodyHtml, bodyText };
    },
    enabled: enabled && Boolean(detail) && Boolean(source),
    staleTime: Infinity,
    retry: false,
  });
}

/** Where Apple's translation languages are downloaded. */
export const TRANSLATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.Localization-Settings.extension";
