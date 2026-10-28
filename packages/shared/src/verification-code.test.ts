import { describe, expect, it } from "vite-plus/test";
import { findVerificationCode, mentionsVerificationCode } from "./verification-code.ts";

describe("findVerificationCode", () => {
  it.each([
    [
      "Your verification code",
      "Your verification code is 482913. It expires in 10 minutes.",
      "482913",
    ],
    ["482913 is your Instagram code", "Hi Robin, someone tried to log in.", "482913"],
    ["Google verification", "G-482913 is your Google verification code.", "482913"],
    ["Slack confirmation code: Q5Z-7KJ", "Here it is.", "Q5Z-7KJ"],
    ["Sign in to Acme", "Your Acme sign-in code: K7P2QX", "K7P2QX"],
    ["Your verification code for Acme", "Your verification code for Acme is 551204", "551204"],
    [
      "Sign in to Acme",
      "Use the code below to sign in.\n\n  482 913  \n\nThis code expires in 10 minutes.",
      "482913",
    ],
    ["Your one-time passcode", "Hi Robin,\n\n918273\n\nDon't share it with anyone.", "918273"],
    ["Code de vérification", "Votre code de vérification est : 739201", "739201"],
    ["Anmeldung", "Ihr Bestätigungscode lautet 5531.", "5531"],
    ["Verificación", "Tu código de verificación es 120934", "120934"],
    ["Login", "Code: 650 113", "650113"],
  ])("finds the code in %j", (subject, body, code) => {
    expect(findVerificationCode(subject, body)).toBe(code);
  });

  it.each([
    [
      "Your flight to Lisbon is confirmed",
      "Booking reference: 7XQ2LM\n\nFlight TP 1352 · Fri 16 Oct",
    ],
    ["20% off this week", "Use code SAVE20 for 20% off everything."],
    ["Your order has shipped", "Your order #482913 has shipped. Tracking: 1Z999AA10123456784"],
    ["Verify your phone", "Enter the code we texted to your phone.\n\nAcme Inc, 1600 Main Street"],
    ["Your verification code", "Your verification code expires on Oct 28, 2026."],
    ["Need help?", "Call us at (650) 253-0000 if you need a verification code."],
    ["Address", "Please confirm your zip code: 94043"],
    ["Deploy finished", "Your code runs 1000 times faster since the last deploy."],
    ["Weekly digest", "We rewrote your code review flow: 12000 lines in 3 weeks."],
    ["Dinner Saturday?", "Saturday at 7? Bring the bread from the corner bakery."],
    ["Your code", "Sign in with the link: https://acme.example/login?code=482913"],
  ])("finds nothing in %j", (subject, body) => {
    expect(findVerificationCode(subject, body)).toBeNull();
  });

  it("tells a preview that names a code", () => {
    expect(
      mentionsVerificationCode("Your Linden sign-in code\nHi, Use this code to sign in: 518306"),
    ).toBe(true);
    expect(mentionsVerificationCode("Dinner Saturday?\nBring the bread.")).toBe(false);
  });
});
