/**
 * The one-time code a sign-in or verification email carries ("Your
 * verification code is 482913"), for the reader's card and the Copy code
 * button on new-mail notifications. Like Gmail's, it is a guess, so it
 * stays narrow: the mail has to name a code, and the code has to be right
 * beside the name ("code: 482913", "482913 is your code") or on its own
 * line just after it. Promo, order, booking and postal codes are left alone.
 */

// `\b` only knows ASCII letters, even with the `u` flag.
const START = String.raw`(?<![\p{L}\p{N}])`;
const END = String.raw`(?![\p{L}\p{N}])`;

/** What names a one-time code, in the languages it's most often mailed in. */
const NAMES = new RegExp(
  `${START}(?:${[
    // English
    String.raw`(?:verification|verify|security|confirmation|authentication|auth|log-?in|sign[- ]?in|sign[- ]?up|one-time|single-use|temporary|access|activation|2fa|mfa|otp|reset|recovery|approval|identity)[ -](?:code|pin|passcode|password)`,
    String.raw`passcode|otp`,
    // French
    String.raw`code (?:de vérification|de sécurité|de confirmation|d['’]accès|d['’]activation|de connexion|d['’]authentification|à usage unique|temporaire)`,
    String.raw`mot de passe (?:à usage unique|temporaire)`,
    // German
    String.raw`(?:bestätigungs|sicherheits|verifizierungs|verifikations|anmelde|einmal|zugangs|freischalt|aktivierungs|authentifizierungs|login-?)code|einmal(?:passwort|kennwort)`,
    // Spanish and Portuguese
    String.raw`código de (?:verificación|verificação|seguridad|segurança|confirmación|confirmação|acceso|acesso|activación|inicio de sesión)`,
    // Italian
    String.raw`codice (?:di verifica|di sicurezza|di conferma|di accesso|monouso)`,
    // Dutch
    String.raw`(?:verificatie|beveiligings|inlog|bevestigings|toegangs)code`,
  ].join("|")})${END}`,
  "giu",
);

/**
 * Plain names, in the same languages. A name that says what the code is for
 * may sit a few words from it; these only right beside it, as "your code" is
 * also what developer mail talks about.
 */
const PLAIN_NAMES = new RegExp(
  `${START}(?:${[
    String.raw`(?:your|enter|use|following)(?: [\p{L}\p{N}'’.-]+)? code|code(?=\s*:)`,
    String.raw`(?:votre|ton) code|(?:saisissez|entrez|utilisez|voici) (?:le|ce|votre) code`,
    String.raw`(?:ihr|dein|diesen|folgenden) code`,
    String.raw`(?:tu|su|seu|este) código|(?:il tuo|questo) codice|(?:je|uw) code`,
  ].join("|")})${END}`,
  "giu",
);

/** Codes that aren't for signing in, named near the code. */
const OTHER_CODES =
  /promo|coupon|discount|voucher|% off|checkout|gift|referral|invit|zip|postal|post ?code|postleitzahl|tracking|order (?:number|no|#)|booking|reservation|réservation|buchung|itinerary|flight|invoice|qr|bar ?code|source code|error code|status code|area code|country code|dress code|réduction|rabatt|gutschein|descuento|cupón|sconto/iu;

/** 482913, 482 913, 4829-1234, Q5Z-7KJ, K7P2QX (letters only with digits). */
const CODE = String.raw`\d{3}[ -]\d{3}|\d{4}[ -]\d{4}|\d{4,8}|(?=[A-Z\d-]*\d)(?=[A-Z\d-]*[A-Z])[A-Z\d]{3}-[A-Z\d]{3}|(?=[A-Z\d]*\d)(?=[A-Z\d]*[A-Z])[A-Z\d]{5,8}`;

/** A code among words: not part of a longer number, a price, a date or a time. */
const CODE_IN_TEXT = new RegExp(
  String.raw`(?<![\p{L}\p{N}$€£¥#+/.,_]|\d-)(?:${CODE})(?![\p{L}\p{N}%€$£_]|[.,:/-]\d)`,
  "gu",
);

/** A line that is only a code, as the big number in a sign-in email's HTML. */
const CODE_LINE = new RegExp(String.raw`^[\s*"'“”«»()[\]]*(${CODE})[\s*"'“”«».()[\]]*$`, "u");

/** From a plain name to its code: "your code is 482913", "Code: 482913". */
const RIGHT_BESIDE = /^\s*(?:is|est|ist|lautet|es|é|è)?\s*:?\s*$/iu;

/** From a name to its code: the same sentence, and close. */
const CLOSE = /^[^.!?。]{0,40}$/u;

/** Before the name, the code leads the sentence: "482913 is your code". */
const LEADS = /^\s*(?:is|est|ist|es|é|è|är|[-–—:|])\s[^.!?。\n]{0,30}$/iu;

type Found = { code: string; index: number };

/** Whether text names a one-time code: a preview worth reading the whole message for. */
export function mentionsVerificationCode(text: string): boolean {
  return text.search(NAMES) !== -1 || text.search(PLAIN_NAMES) !== -1;
}

/** The one-time code in a message, or null. `body` is its text (not HTML). */
export function findVerificationCode(subject: string, body: string): string | null {
  const text = `${subject}\n\n${body}`
    .slice(0, 6000)
    // Links carry numbers that aren't codes.
    .replace(/(?:https?:\/\/|www\.)\S+/giu, " ")
    .replace(/[   ]/gu, " ");

  const names = [
    ...[...text.matchAll(NAMES)].map((name) => ({ name, gap: CLOSE })),
    ...[...text.matchAll(PLAIN_NAMES)].map((name) => ({ name, gap: RIGHT_BESIDE })),
  ];
  for (const { name, gap } of names) {
    const start = name.index;
    const end = start + name[0].length;
    const found =
      codeAfter(text, end, gap) ?? codeBefore(text, start) ?? codeOnLineAfter(text, end);
    if (!found) continue;
    const around = text.slice(
      Math.max(0, Math.min(start, found.index) - 40),
      Math.max(end, found.index + found.code.length) + 40,
    );
    if (OTHER_CODES.test(around)) continue;
    // A copied code is pasted into a field that takes it whole: digits without spaces.
    return /^[\d -]+$/.test(found.code) ? found.code.replace(/[ -]/g, "") : found.code;
  }
  return null;
}

/** "Your verification code for Acme is 482913", "Code: Q5Z-7KJ". */
function codeAfter(text: string, end: number, gap: RegExp): Found | null {
  CODE_IN_TEXT.lastIndex = end;
  const match = CODE_IN_TEXT.exec(text);
  if (!match || !isCode(match[0]) || !gap.test(text.slice(end, match.index))) return null;
  return { code: match[0], index: match.index };
}

/** "482913 is your verification code". */
function codeBefore(text: string, start: number): Found | null {
  let last: RegExpExecArray | null = null;
  CODE_IN_TEXT.lastIndex = Math.max(0, start - 50);
  for (let m = CODE_IN_TEXT.exec(text); m && m.index < start; m = CODE_IN_TEXT.exec(text)) {
    last = m;
  }
  if (!last || !isCode(last[0])) return null;
  if (!LEADS.test(text.slice(last.index + last[0].length, start))) return null;
  return { code: last[0], index: last.index };
}

/** "Use the code below to sign in:\n\n482913\n\nIt expires in 10 minutes." */
function codeOnLineAfter(text: string, end: number): Found | null {
  const lineEnd = text.indexOf("\n", end);
  if (lineEnd === -1) return null;
  let index = lineEnd + 1;
  for (const line of text
    .slice(index, index + 400)
    .split("\n")
    .slice(0, 8)) {
    const match = CODE_LINE.exec(line);
    if (match && isCode(match[1])) return { code: match[1], index: index + line.indexOf(match[1]) };
    index += line.length + 1;
  }
  return null;
}

/** Years read as numbers, not codes. */
function isCode(code: string): boolean {
  return !/^(?:19|20)\d\d$/.test(code);
}
