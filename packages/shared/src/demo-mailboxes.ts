/**
 * The demo's mailboxes: two accounts with a few weeks of
 * made-up mail. Everything here is fixed; only the dates are relative, to
 * when the demo was first opened, so the mail always looks recent.
 */

type Person = { name: string; email: string };

export type SeedAttachment = {
  filename: string;
  mimeType: string;
  /** The file's text (all demo files are text: PDF, SVG, ICS, CSV). */
  content: string;
  /** Referenced from the HTML as `cid:…`. */
  contentId?: string;
};

type SeedMessage = {
  /** Omitted: the account itself. */
  from?: Person;
  /** Omitted: the account (mail to it), or the thread's first sender (mail from it). */
  to?: Person[];
  cc?: Person[];
  hoursAgo: number;
  text: string;
  html?: string;
  attachments?: SeedAttachment[];
  unread?: boolean;
  starred?: boolean;
  draft?: boolean;
  headers?: Record<string, string>;
};

export type SeedThread = {
  subject: string;
  /** Label ids or user label names, on every received message of the thread. */
  labels: string[];
  messages: SeedMessage[];
};

export type SeedAccount = {
  email: string;
  name: string;
  displayName: string;
  color: string;
  /** The profile picture, like Google's: an image URL. */
  picture?: string;
  signature: string;
  /** User labels; "A/B" nests B under A. */
  labels: { name: string; color?: { backgroundColor: string; textColor: string } }[];
  threads: (seededAt: number) => SeedThread[];
};

const p = (name: string, email: string): Person => ({ name, email });

// ── Files ────────────────────────────────────────────────────────────────────

/** A one-page PDF with a title and a few lines (ASCII only: Helvetica). */
function pdf(title: string, lines: string[]): string {
  const esc = (s: string) => s.replace(/[\\()]/g, "\\$&");
  const content = [
    "BT /F1 20 Tf 72 720 Td",
    `(${esc(title)}) Tj`,
    "/F1 12 Tf",
    ...lines.map((line) => `0 -24 Td (${esc(line)}) Tj`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

function picture(label: string, sky: string, ground: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <rect width="640" height="400" fill="${sky}"/>
  <circle cx="500" cy="110" r="50" fill="#fde68a"/>
  <path d="M0 260 L160 140 L300 250 L420 170 L640 290 L640 400 L0 400 Z" fill="${ground}"/>
  <rect y="300" width="640" height="100" fill="#1e3a8a" opacity=".55"/>
  <text x="24" y="380" font-family="system-ui, sans-serif" font-size="28" fill="#fff">${label}</text>
</svg>`;
}

/** A friendly head-and-shoulders profile picture, as Google shows for an account. */
function portrait(background: string, skin: string, hair: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <rect width="96" height="96" fill="${background}"/>
  <path d="M14 96 C14 74 30 68 48 68 C66 68 82 74 82 96 Z" fill="#fff" opacity=".9"/>
  <path d="M41 56 H55 V70 C52 73 44 73 41 70 Z" fill="${skin}"/>
  <circle cx="48" cy="40" r="19" fill="${skin}"/>
  <path d="M28 40 C26 22 38 16 50 17 C62 18 70 28 68 40 C63 33 54 29 44 29 C37 29 31 33 28 40 Z" fill="${hair}"/>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const icsStamp = (time: number) =>
  new Date(time)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** `days` after the demo was seeded, at a whole UTC hour. */
function slot(seededAt: number, days: number, hourUtc: number): number {
  const date = new Date(seededAt + days * 86_400_000);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date.getTime();
}

function invite(opts: {
  uid: string;
  summary: string;
  start: number;
  minutes: number;
  location: string;
  organizer: Person;
  attendees: Person[];
}): SeedAttachment {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `DTSTART:${icsStamp(opts.start)}`,
    `DTEND:${icsStamp(opts.start + opts.minutes * 60_000)}`,
    `DTSTAMP:${icsStamp(opts.start - 3 * 86_400_000)}`,
    `ORGANIZER;CN=${opts.organizer.name}:mailto:${opts.organizer.email}`,
    `UID:${opts.uid}`,
    ...opts.attendees.map(
      (a) =>
        `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=${a.name}:mailto:${a.email}`,
    ),
    `LOCATION:${opts.location.replace(/,/g, "\\,")}`,
    "SEQUENCE:0",
    "STATUS:CONFIRMED",
    `SUMMARY:${opts.summary}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return { filename: "invite.ics", mimeType: "text/calendar", content: lines.join("\r\n") };
}

const when = (time: number) =>
  new Date(time).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });

function unsubscribe(domain: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<mailto:unsubscribe@${domain}?subject=unsubscribe>, <https://${domain}/unsubscribe/demo>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** A newsletter's HTML: a header band, sections and a footer, table-laid like the real ones. */
function newsletter(opts: {
  brand: string;
  accent: string;
  heroCid?: string;
  intro: string;
  sections: { title: string; body: string; cta?: string }[];
  footer: string;
}): string {
  const section = (s: { title: string; body: string; cta?: string }) => `
      <tr><td style="padding:20px 32px;border-top:1px solid #eee">
        <h2 style="margin:0 0 8px;font:600 18px/1.3 Georgia,serif;color:#111">${s.title}</h2>
        <p style="margin:0 0 12px;font:15px/1.6 Georgia,serif;color:#333">${s.body}</p>
        ${s.cta ? `<a href="https://example.com/read" style="display:inline-block;padding:8px 16px;border-radius:6px;background:${opts.accent};color:#fff;font:600 13px system-ui,sans-serif;text-decoration:none">${s.cta}</a>` : ""}
      </td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#f4f1ea">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:10px;overflow:hidden">
      <tr><td style="background:${opts.accent};padding:28px 32px;color:#fff;font:700 26px/1.2 Georgia,serif">${opts.brand}</td></tr>
      ${opts.heroCid ? `<tr><td><img src="cid:${opts.heroCid}" width="600" alt="" style="display:block;width:100%;height:auto"></td></tr>` : ""}
      <tr><td style="padding:24px 32px;font:16px/1.6 Georgia,serif;color:#333">${opts.intro}</td></tr>
      ${opts.sections.map(section).join("")}
      <tr><td style="padding:20px 32px;background:#fafafa;color:#888;font:12px/1.5 system-ui,sans-serif">${opts.footer}<br><a href="https://example.com/unsubscribe" style="color:#888">Unsubscribe</a> · <a href="https://example.com/preferences" style="color:#888">Email preferences</a></td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

// ── Personal ─────────────────────────────────────────────────────────────────

const maya = p("Maya Chen", "maya.chen@example.com");
const jose = p("José Álvarez", "jose@alvarez.example");
const zoe = p("Zoë Björklund", "zoe.bjorklund@example.org");
const asa = p("Åsa Lindqvist", "asa@bokcirkel.example");
const lukasz = p("Łukasz Wiśniewski", "lukasz.w@example.pl");
const lan = p("Nguyễn Thị Lan", "lan.nguyen@example.vn");
const sakura = p("田中 さくら", "sakura.tanaka@example.jp");
const jonas = p("Jonas Müller", "jonas.mueller@example.de");
const mum = p("Mum", "helen.otter@example.net");

const personal: SeedAccount = {
  email: "demo@otter.example",
  name: "Robin Otter",
  displayName: "Personal",
  color: "#0ea5e9",
  picture: portrait("#7dd3fc", "#f1c27d", "#5b3a29"),
  signature: "<div>Robin</div>",
  labels: [
    { name: "Family", color: { backgroundColor: "#fb4c2f", textColor: "#ffffff" } },
    { name: "Travel", color: { backgroundColor: "#16a766", textColor: "#ffffff" } },
    { name: "Receipts" },
    { name: "Projects" },
    { name: "Projects/Otter", color: { backgroundColor: "#4a86e8", textColor: "#ffffff" } },
    { name: "Projects/Garden", color: { backgroundColor: "#a4c2f4", textColor: "#000000" } },
  ],
  threads: (seededAt) => {
    const gardenStart = slot(seededAt, 5, 9);
    return [
      {
        subject: "Welcome to the Otter Mail demo",
        labels: ["INBOX", "IMPORTANT", "CATEGORY_PERSONAL"],
        messages: [
          {
            from: p("Otter Mail", "team@otter.example"),
            hoursAgo: 24 * 20,
            starred: true,
            text: "Hi Robin,\n\nEverything in this mailbox is made up: the people, the mail, the attachments. It lives in your browser only (the demo's own storage), and nothing you do here reaches Gmail.\n\nArchive, star, label, reply, draft, search: it all works against a pretend Gmail, and sync catches up the way it does with the real one.\n\nTo start over, open the app with ?reset-demo at the end of the address.\n\nHave fun,\nThe Otter Mail team",
          },
        ],
      },
      {
        subject: "Dinner Saturday? 🍝",
        labels: ["INBOX", "IMPORTANT", "CATEGORY_PERSONAL"],
        messages: [
          {
            from: maya,
            hoursAgo: 7,
            text: "Hey! We're finally doing the pasta night. Saturday at 7? Bring nothing but yourself (and maybe that bread from the corner bakery).\n\nMaya",
          },
          {
            to: [maya],
            hoursAgo: 5,
            text: "Saturday works! I'll bring the bread and a bottle of something red. Can I bring Jonas too?\n\nRobin",
          },
          {
            from: maya,
            hoursAgo: 1.5,
            unread: true,
            text: "Of course, the more the merrier. I'll make extra cacio e pepe. See you at 7!",
          },
        ],
      },
      {
        subject: "Your flight to Lisbon is confirmed — TP 1352, Fri 16 Oct",
        labels: ["INBOX", "Travel", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("TAP Air Portugal", "no-reply@flytap.example"),
            hoursAgo: 26,
            starred: true,
            text: "Booking reference: 7XQ2LM\n\nPassenger: ROBIN OTTER\nFlight TP 1352 · Fri 16 Oct\nDeparts 07:40 · Arrives 10:05 (local time)\nSeat 14A · 1 checked bag\n\nYour e-ticket is attached. Online check-in opens 36 hours before departure.\n\nManage your booking:\nhttps://booking.example.com/manage?ref=7XQ2LM&passenger=ROBIN%20OTTER&token=eyJhbGciOiJIUzI1NiJ9.eyJyZWYiOiI3WFEyTE0iLCJleHAiOjE3OTk5OTk5OTl9.c2lnbmF0dXJlLW9mLWEtbWFkZS11cC1ib29raW5nLXRva2Vu",
            attachments: [
              {
                filename: "e-ticket-7XQ2LM.pdf",
                mimeType: "application/pdf",
                content: pdf("E-ticket 7XQ2LM", [
                  "Passenger: ROBIN OTTER",
                  "Flight TP 1352, Fri 16 Oct",
                  "Departs 07:40, arrives 10:05",
                  "Seat 14A, 1 checked bag",
                ]),
              },
            ],
          },
        ],
      },
      {
        subject: `Invitation: Garden planning @ ${when(gardenStart)} (demo@otter.example)`,
        labels: ["INBOX", "Projects/Garden", "CATEGORY_PERSONAL"],
        messages: [
          {
            from: jonas,
            hoursAgo: 20,
            unread: true,
            text: `Jonas Müller has invited you to an event.\n\nGarden planning\nWhen: ${when(gardenStart)}\nWhere: Community garden, plot 12\n\nLet's decide what goes in the raised beds before the frost. Bring seed catalogues!`,
            attachments: [
              invite({
                uid: "garden-planning-demo@otter.example",
                summary: "Garden planning",
                start: gardenStart,
                minutes: 60,
                location: "Community garden, plot 12",
                organizer: jonas,
                attendees: [jonas, p("Robin Otter", "demo@otter.example")],
              }),
            ],
          },
        ],
      },
      {
        subject: "The Sunday Otter — Issue #112: Rivers, rafts, and remote work",
        labels: ["INBOX", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("The Sunday Otter", "hello@sundayotter.example"),
            hoursAgo: 30,
            unread: true,
            headers: unsubscribe("sundayotter.example"),
            text: "The Sunday Otter, issue #112.\n\nRivers are back: after three dry summers, the valley's rivers ran full this week.\n\nRafts, reconsidered: why a plank of wood is the best office chair.\n\nRemote work from the riverbank: five readers on their setups.",
            html: newsletter({
              brand: "The Sunday Otter",
              accent: "#0f766e",
              heroCid: "hero-river",
              intro:
                "Good morning! This week: rivers running full again, a surprising defence of rafts, and five readers who work from the riverbank.",
              sections: [
                {
                  title: "Rivers are back",
                  body: "After three dry summers, the valley's rivers ran full this week. We walked the old towpath from the mill to the weir and counted eleven herons.",
                  cta: "Read the story",
                },
                {
                  title: "Rafts, reconsidered",
                  body: "A plank of wood, lashed to three more planks, might be the best office chair ever made. Our columnist spent a week finding out.",
                  cta: "Continue reading",
                },
                {
                  title: "Remote work from the riverbank",
                  body: "Five readers share their setups: solar panels, dry bags, and one very patient dog.",
                },
              ],
              footer:
                "You're receiving this because you subscribed at sundayotter.example. The Sunday Otter, 1 Weir Lane, Rivertown.",
            }),
            attachments: [
              {
                filename: "river.svg",
                mimeType: "image/svg+xml",
                contentId: "hero-river",
                content: picture("Rivers are back", "#bae6fd", "#15803d"),
              },
            ],
          },
        ],
      },
      {
        subject: "Photos from the lake 📷",
        labels: ["INBOX", "Family", "CATEGORY_PERSONAL"],
        messages: [
          {
            from: mum,
            hoursAgo: 50,
            text: "Here are a couple from Sunday. Your father insists the fish was bigger than it looks.\n\nLove,\nMum",
            attachments: [
              {
                filename: "lake-morning.svg",
                mimeType: "image/svg+xml",
                content: picture("Lake, morning", "#fecaca", "#166534"),
              },
              {
                filename: "lake-evening.svg",
                mimeType: "image/svg+xml",
                content: picture("Lake, evening", "#312e81", "#14532d"),
              },
            ],
          },
          {
            to: [mum],
            hoursAgo: 46,
            text: "These are lovely! Tell Dad the fish looks enormous. 🐟",
          },
        ],
      },
      {
        subject: "Re: Otter Mail feedback — keyboard shortcuts",
        labels: ["INBOX", "Projects/Otter"],
        messages: [
          {
            from: jose,
            hoursAgo: 24 * 4,
            text: 'Hi Robin,\n\nI\'ve been using Otter Mail for a week. Love it. Two things:\n\n1. Could `e` archive and move to the next message rather than back to the list?\n2. Is there a shortcut for "mark as unread"?\n\nJosé',
          },
          {
            to: [jose],
            hoursAgo: 24 * 4 - 3,
            text: "Thanks José! 1 is a setting (Settings › Keyboard). 2 is Shift+U, same as Gmail.",
          },
          {
            from: jose,
            hoursAgo: 24 * 3,
            text: "Perfect, found it. One more: can I remap `j`/`k`? My muscle memory is from another client.",
          },
          {
            from: jose,
            hoursAgo: 24 * 3 - 1,
            unread: true,
            text: "Never mind, found the keybindings file. You thought of everything. 🙌",
          },
        ],
      },
      {
        subject: "Book club: next pick is “The Overstory”",
        labels: ["INBOX", "CATEGORY_FORUMS"],
        messages: [
          {
            from: asa,
            to: [p("Book club", "bokcirkel@bokcirkel.example")],
            hoursAgo: 24 * 6,
            text: "Hej alla! The votes are in: The Overstory by Richard Powers. We meet on the 24th at mine. Fika provided.\n\nÅsa",
          },
          {
            from: lukasz,
            to: [p("Book club", "bokcirkel@bokcirkel.example")],
            hoursAgo: 24 * 6 - 5,
            text: "Great pick. Fair warning: it's long. I'm starting tonight.",
          },
          {
            to: [p("Book club", "bokcirkel@bokcirkel.example")],
            hoursAgo: 24 * 5,
            text: "Count me in. I'll bring kanelbullar.",
          },
        ],
      },
      {
        subject:
          "A very long subject line, to see how the list truncates it when someone writes their entire message in the subject and then some more words just to be sure",
        labels: ["INBOX", "CATEGORY_PERSONAL"],
        messages: [
          {
            from: lukasz,
            hoursAgo: 24 * 2 + 3,
            text: "(see subject)",
          },
        ],
      },
      {
        subject: "Rent reminder — October",
        labels: ["INBOX", "IMPORTANT", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("Harbour View Lettings", "accounts@harbourview.example"),
            hoursAgo: 24 * 3 + 7,
            starred: true,
            text: "Dear Robin,\n\nA friendly reminder that October's rent is due on the 1st. You can pay by bank transfer to the usual account.\n\nKind regards,\nHarbour View Lettings",
          },
        ],
      },
      {
        subject: "京都の写真を送ります",
        labels: ["INBOX", "CATEGORY_PERSONAL"],
        messages: [
          {
            from: sakura,
            hoursAgo: 11,
            unread: true,
            text: "ロビンさん、\n\n先週の京都旅行の写真です。嵐山の竹林がとてもきれいでした。\n\nまた会いましょう！\nさくら",
            attachments: [
              {
                filename: "嵐山.svg",
                mimeType: "image/svg+xml",
                content: picture("Arashiyama", "#dcfce7", "#15803d"),
              },
            ],
          },
        ],
      },
      {
        subject: "Quick question about the bike",
        labels: ["INBOX", "CATEGORY_PERSONAL"],
        messages: [
          {
            to: [lan],
            hoursAgo: 24 * 7,
            text: "Hi Lan, is the blue bike still for sale? I'd love to have a look this weekend.",
          },
          {
            from: lan,
            hoursAgo: 24 * 7 - 6,
            text: "Yes it is! Sunday morning works. I'm at 14 Canal Street, ring the top bell.",
          },
        ],
      },
      {
        subject: "Receipt for your order #4821-OTTR",
        labels: ["Receipts", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("Paddle & Co.", "orders@paddleco.example"),
            hoursAgo: 24 * 9,
            text: "Thanks for your order!\n\n1 × Dry bag, 20 L — €24.00\n1 × Paddle leash — €9.50\nShipping — €4.90\nTotal — €38.40\n\nYour receipt is attached.",
            attachments: [
              {
                filename: "receipt-4821-OTTR.pdf",
                mimeType: "application/pdf",
                content: pdf("Receipt #4821-OTTR", [
                  "1 x Dry bag, 20 L - EUR 24.00",
                  "1 x Paddle leash - EUR 9.50",
                  "Shipping - EUR 4.90",
                  "Total - EUR 38.40",
                ]),
              },
            ],
          },
        ],
      },
      {
        subject: "Security alert: new sign-in on a Mac",
        labels: ["INBOX", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("Account security", "no-reply@accounts.example"),
            hoursAgo: 24 * 8,
            text: "Your account was just signed in to from a new Mac (Safari, Lisbon, Portugal).\n\nIf this was you, you don't need to do anything. If not, secure your account now.",
          },
        ],
      },
      {
        subject: "48 hours only: 30% off all hiking gear",
        labels: ["INBOX", "CATEGORY_PROMOTIONS"],
        messages: [
          {
            from: p("Trailhead Outfitters", "deals@trailhead.example"),
            hoursAgo: 24 * 1 + 4,
            unread: true,
            headers: unsubscribe("trailhead.example"),
            text: "30% off everything for 48 hours. Boots, packs, tents. Use code AUTUMN30 at checkout.",
            html: newsletter({
              brand: "Trailhead Outfitters",
              accent: "#c2410c",
              intro:
                "<strong>30% off everything</strong> for the next 48 hours. Boots, packs, tents: use code <code>AUTUMN30</code> at checkout.",
              sections: [
                {
                  title: "Waterproof boots",
                  body: "Our best-selling boots, now from €89.",
                  cta: "Shop boots",
                },
                {
                  title: "Ultralight tents",
                  body: "Two-person tents under 1.2 kg, from €199.",
                  cta: "Shop tents",
                },
              ],
              footer: "Trailhead Outfitters, 8 Summit Road.",
            }),
          },
        ],
      },
      {
        subject: "Zoë Björklund mentioned you in a comment",
        labels: ["INBOX", "CATEGORY_SOCIAL"],
        messages: [
          {
            from: p("Pebble", "notifications@pebble.example"),
            hoursAgo: 14,
            unread: true,
            text: 'Zoë Björklund mentioned you: "@robin you have to see this otter holding hands 🦦🦦"\n\nReply on Pebble.',
          },
        ],
      },
      {
        subject: "Fwd: Otter sanctuary volunteering",
        labels: ["INBOX", "CATEGORY_PERSONAL"],
        messages: [
          {
            from: zoe,
            hoursAgo: 24 * 2,
            text: "Thought of you! They're looking for weekend volunteers.\n\n---------- Forwarded message ---------\nFrom: Rivertown Otter Sanctuary\nSubject: Volunteering\n\nWe're looking for volunteers on Saturdays and Sundays, 9–13h. No experience needed; waders provided.",
          },
        ],
      },
      {
        subject: "[otter-mail] Fix sync when the history cursor expires (#42)",
        labels: ["Projects/Otter", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("Forge", "notifications@forge.example"),
            hoursAgo: 24 * 5,
            text: "jose-alvarez opened a pull request: Fix sync when the history cursor expires.\n\nWhen Gmail answers 404 for an old startHistoryId, fall back to a full resync.",
          },
          {
            from: p("Forge", "notifications@forge.example"),
            hoursAgo: 24 * 5 - 2,
            text: "maya-chen approved these changes.\n\nLooks good. Nice test.",
          },
          {
            from: p("Forge", "notifications@forge.example"),
            hoursAgo: 24 * 4 - 8,
            text: "Merged #42 into main.",
          },
        ],
      },
      {
        subject: "Your library books are due Friday",
        labels: ["INBOX", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("Rivertown Library", "library@rivertown.example"),
            hoursAgo: 24 * 12,
            text: "Two items are due on Friday:\n\n• The Wind in the Willows\n• Tarka the Otter\n\nRenew online or at the desk.",
          },
        ],
      },
      {
        subject: "Your weekly screen time report",
        labels: ["CATEGORY_UPDATES"],
        messages: [
          {
            from: p("Screen Time", "reports@screentime.example"),
            hoursAgo: 24 * 14,
            text: "You averaged 3 h 12 min a day, down 18% from last week.",
          },
        ],
      },
      {
        subject: "Trip ideas for November",
        labels: [],
        messages: [
          {
            to: [maya],
            hoursAgo: 3,
            draft: true,
            text: "Maya, what about Porto for a long weekend? Trains from Lisbon are only 3 hours, and",
          },
        ],
      },
      {
        subject: "Heating in the flat",
        labels: [],
        messages: [
          {
            to: [],
            hoursAgo: 24 * 2 + 1,
            draft: true,
            text: "Dear Harbour View,\n\nThe radiator in the bedroom has stopped working again.",
          },
        ],
      },
      {
        subject: "You've WON a $1,000 gift card!!!",
        labels: ["SPAM"],
        messages: [
          {
            from: p("Prize Center", "winner@prizes.example"),
            hoursAgo: 24 * 3,
            text: "Congratulations! Click here to claim your $1,000 gift card before it expires.",
          },
        ],
      },
      {
        subject: "Urgent: verify your account within 24 hours",
        labels: ["SPAM"],
        messages: [
          {
            from: p("Support Team", "security@verify-now.example"),
            hoursAgo: 24 * 6,
            text: "Your mailbox will be suspended. Verify your account now to keep receiving mail.",
          },
        ],
      },
      {
        subject: "Summer sale: last chance",
        labels: ["TRASH", "CATEGORY_PROMOTIONS"],
        messages: [
          {
            from: p("Trailhead Outfitters", "deals@trailhead.example"),
            hoursAgo: 24 * 18,
            text: "The summer sale ends tonight.",
          },
        ],
      },
    ];
  },
};

// ── Work ─────────────────────────────────────────────────────────────────────

const priya = p("Priya Natarajan", "priya@acme.example");
const tom = p("Tom Becker", "tom.becker@acme.example");
const karim = p("Karim Haddad", "karim@acme.example");
const hanna = p("Hanna Schäfer", "hanna.schaefer@acme.example");
const olu = p("Oluwaseun Adeyemi", "olu@northwind.example");
const team = p("Platform team", "platform@acme.example");

const work: SeedAccount = {
  email: "sam@acme.example",
  name: "Sam Park",
  displayName: "Work",
  color: "#f97316",
  picture: portrait("#fdba74", "#c68642", "#1f1a17"),
  signature: "<div>Sam Park<br>Engineering Manager, Acme</div>",
  labels: [
    { name: "Clients" },
    { name: "Clients/Northwind", color: { backgroundColor: "#8e63ce", textColor: "#ffffff" } },
    { name: "Hiring", color: { backgroundColor: "#ffad47", textColor: "#000000" } },
    { name: "Finance" },
  ],
  threads: (seededAt) => {
    const reviewStart = slot(seededAt, 3, 14);
    return [
      {
        subject: "Q4 planning — draft agenda",
        labels: ["INBOX", "IMPORTANT"],
        messages: [
          {
            from: priya,
            to: [p("Sam Park", "sam@acme.example"), tom],
            hoursAgo: 24 * 2,
            text: "Hi both,\n\nDraft agenda for Thursday's Q4 planning attached. Main questions:\n\n1. Do we ship offline search before or after the redesign?\n2. Headcount: one or two backend hires?\n\nComments welcome before Wednesday.\n\nPriya",
            attachments: [
              {
                filename: "Q4-planning-agenda.pdf",
                mimeType: "application/pdf",
                content: pdf("Q4 planning - agenda", [
                  "1. Review Q3 goals (15 min)",
                  "2. Offline search vs. redesign (30 min)",
                  "3. Hiring plan (20 min)",
                  "4. Risks and open questions (15 min)",
                ]),
              },
            ],
          },
          {
            from: tom,
            to: [priya, p("Sam Park", "sam@acme.example")],
            hoursAgo: 24 * 2 - 3,
            text: "Offline search first, IMO: the redesign depends on the new index anyway.",
          },
          {
            to: [priya, tom],
            hoursAgo: 24 * 1 + 20,
            text: "Agree with Tom. On hiring: two, if we can find them. I'll bring numbers.",
          },
          {
            from: priya,
            to: [p("Sam Park", "sam@acme.example"), tom],
            hoursAgo: 24 * 1 + 2,
            text: "Great, updated the agenda. Sam, can you own item 3?",
          },
          {
            from: tom,
            to: [priya, p("Sam Park", "sam@acme.example")],
            hoursAgo: 4,
            unread: true,
            starred: true,
            text: "Also: can we move it to 2pm? I have a dentist appointment in the morning. 🦷",
          },
        ],
      },
      {
        subject: `Invitation: Design review @ ${when(reviewStart)} (sam@acme.example)`,
        labels: ["INBOX", "IMPORTANT"],
        messages: [
          {
            from: priya,
            hoursAgo: 9,
            unread: true,
            text: `Priya Natarajan has invited you to an event.\n\nDesign review: new reader layout\nWhen: ${when(reviewStart)}\nWhere: Room Rhine / video call`,
            attachments: [
              invite({
                uid: "design-review-demo@acme.example",
                summary: "Design review: new reader layout",
                start: reviewStart,
                minutes: 60,
                location: "Room Rhine, video call",
                organizer: priya,
                attendees: [priya, tom, hanna, p("Sam Park", "sam@acme.example")],
              }),
            ],
          },
        ],
      },
      {
        subject: "Northwind: contract renewal",
        labels: ["INBOX", "Clients/Northwind"],
        messages: [
          {
            from: olu,
            hoursAgo: 24 * 5,
            text: "Hi Sam,\n\nOur contract renews on 1 November. We'd like to add 40 seats and discuss the SSO add-on. Could we find 30 minutes next week?\n\nBest,\nOluwaseun",
          },
          {
            to: [olu],
            hoursAgo: 24 * 5 - 4,
            text: "Hi Oluwaseun, great to hear. How about Tuesday at 15:00 CET? I'll bring Karim from sales.",
          },
          {
            from: olu,
            hoursAgo: 24 * 4,
            starred: true,
            text: "Tuesday at 15:00 works. Talk then!",
          },
        ],
      },
      {
        subject: "Northwind renewal: order form",
        labels: ["INBOX", "Clients/Northwind"],
        messages: [
          {
            from: karim,
            hoursAgo: 24 * 3 + 5,
            text: "Sam,\n\nFirst draft of Northwind's renewal order form attached: 160 seats, SSO add-on, 12 months from 1 November. Can you check the SSO wording before I send it?\n\nKarim",
            attachments: [
              {
                filename: "Northwind_Order_Form_v1.pdf",
                mimeType: "application/pdf",
                content: pdf("Northwind order form - v1", [
                  "Seats: 160",
                  "SSO add-on: included",
                  "Term: 12 months from 1 November",
                  "Price: 38 EUR per seat per month",
                ]),
              },
            ],
          },
          {
            to: [karim],
            hoursAgo: 24 * 3 + 1,
            text: "Looks good. SSO should say 'SAML 2.0 and OIDC'. Send it over.",
          },
          {
            from: olu,
            to: [karim, p("Sam Park", "sam@acme.example")],
            hoursAgo: 24 * 2 + 3,
            text: "Thanks both. Our legal team's redlines are in the attached v2: mostly the liability cap and a 30-day notice period.\n\nOluwaseun",
            attachments: [
              {
                filename: "Northwind Order Form v2 (redlines).pdf",
                mimeType: "application/pdf",
                content: pdf("Northwind order form - v2 (redlines)", [
                  "Seats: 160",
                  "SSO add-on: SAML 2.0 and OIDC",
                  "Liability cap: 12 months of fees (was 6)",
                  "Notice period: 30 days",
                ]),
              },
            ],
          },
        ],
      },
      {
        subject: "Northwind order form — final for signature",
        labels: ["INBOX", "Clients/Northwind"],
        messages: [
          {
            from: karim,
            to: [olu],
            cc: [p("Sam Park", "sam@acme.example")],
            hoursAgo: 20,
            unread: true,
            text: "Hi Oluwaseun,\n\nWe accept the liability cap; the notice period stays at 60 days. Final version attached, ready for signature on your side.\n\nKarim",
            attachments: [
              {
                filename: "Northwind_Order_Form_FINAL.pdf",
                mimeType: "application/pdf",
                content: pdf("Northwind order form - final", [
                  "Seats: 160",
                  "SSO add-on: SAML 2.0 and OIDC",
                  "Liability cap: 12 months of fees",
                  "Notice period: 60 days",
                ]),
              },
            ],
          },
        ],
      },
      {
        subject: "Northwind — kickoff notes & next steps",
        labels: ["Clients/Northwind"],
        messages: [
          {
            from: karim,
            hoursAgo: 24 * 16,
            text: "Notes from the kickoff:\n\n• 120 seats to start, 40 more in Q1\n• SSO required by January\n• Weekly check-in, Tuesdays\n\nNext steps: Sam sends the security questionnaire, I send the order form.",
          },
        ],
      },
      {
        subject: "Candidate: Élodie Fournier — Senior Backend Engineer",
        labels: ["INBOX", "Hiring"],
        messages: [
          {
            from: p("Acme Recruiting", "recruiting@acme.example"),
            hoursAgo: 24 * 1 + 6,
            unread: true,
            text: "Hi Sam,\n\nÉlodie passed the technical screen (strong on distributed systems, great communicator). Her CV is attached. Can you do the final interview this week?\n\nThanks,\nRecruiting",
            attachments: [
              {
                filename: "Elodie_Fournier_CV.pdf",
                mimeType: "application/pdf",
                content: pdf("Elodie Fournier", [
                  "Senior Backend Engineer",
                  "8 years: Rust, Go, PostgreSQL",
                  "Led the sync engine at a note-taking startup",
                  "Speaks French, English, German",
                ]),
              },
            ],
          },
        ],
      },
      {
        subject: "Invoice INV-2026-0931 from Cloudly",
        labels: ["INBOX", "Finance", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("Cloudly Billing", "billing@cloudly.example"),
            hoursAgo: 24 * 3,
            text: "Your invoice for September is ready: $4,812.33, due in 30 days. The invoice and a usage breakdown are attached.",
            attachments: [
              {
                filename: "INV-2026-0931.pdf",
                mimeType: "application/pdf",
                content: pdf("Invoice INV-2026-0931", [
                  "Compute - $3,120.00",
                  "Storage - $1,204.33",
                  "Egress - $488.00",
                  "Total - $4,812.33",
                ]),
              },
              {
                filename: "usage-september.csv",
                mimeType: "text/csv",
                content:
                  "service,region,usage,cost\ncompute,eu-west,1560 h,3120.00\nstorage,eu-west,48 TB,1204.33\negress,global,6.1 TB,488.00\n",
              },
            ],
          },
        ],
      },
      {
        subject: "[Incident] API latency elevated in eu-west",
        labels: ["INBOX", "IMPORTANT"],
        messages: [
          {
            from: p("PagerBot", "pagerbot@acme.example"),
            to: [team],
            hoursAgo: 28,
            text: "TRIGGERED: p95 latency for api.acme.example in eu-west is 2.4 s (threshold 800 ms).",
          },
          {
            from: tom,
            to: [team],
            hoursAgo: 27.5,
            text: "Looking. Seems to be the new cache nodes: hit rate dropped to 12%.",
          },
          {
            from: tom,
            to: [team],
            hoursAgo: 26,
            text: "Rolled back the cache config. Latency is back to normal. Post-mortem tomorrow.",
          },
          {
            from: p("PagerBot", "pagerbot@acme.example"),
            to: [team],
            hoursAgo: 25.8,
            unread: true,
            text: "RESOLVED: p95 latency for api.acme.example in eu-west is 310 ms.",
          },
        ],
      },
      {
        subject: "Standup notes — Monday",
        labels: ["INBOX"],
        messages: [
          {
            from: tom,
            to: [team],
            hoursAgo: 24 * 7 + 2,
            text: "Yesterday: finished the search index migration.\nToday: offline search UI.\nBlockers: none.\n\nKarim is out Thursday.",
          },
        ],
      },
      {
        subject: "Offsite venue options",
        labels: ["INBOX"],
        messages: [
          {
            to: [team],
            hoursAgo: 24 * 6,
            text: "Three options for the November offsite:\n\n1. Lakeside lodge (2 h by train)\n2. Old brewery in town (walkable)\n3. Mountain hut (beautiful, no Wi-Fi)\n\nVote by Friday!",
          },
          {
            from: karim,
            to: [team],
            hoursAgo: 24 * 5 + 20,
            text: "Mountain hut, obviously. No Wi-Fi is a feature.",
          },
          {
            from: hanna,
            to: [team],
            hoursAgo: 24 * 5 + 18,
            text: "Brewery! Some of us have kids to pick up. 😅",
          },
        ],
      },
      {
        subject: "Re: Pricing page copy",
        labels: ["INBOX"],
        messages: [
          {
            from: hanna,
            hoursAgo: 24 * 4 + 5,
            text: "Hi Sam, could engineering sanity-check the new pricing page? Especially the SSO line: is it really included in Business?",
          },
          {
            to: [hanna],
            hoursAgo: 24 * 4 + 1,
            text: "SSO is Enterprise-only for now. Everything else looks right. Nice work!",
          },
        ],
      },
      {
        subject: "Security training due by 15 October",
        labels: ["INBOX", "IMPORTANT", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("IT", "it@acme.example"),
            hoursAgo: 24 * 2 + 9,
            unread: true,
            text: "Reminder: the annual security training is due by 15 October. It takes about 25 minutes.",
          },
        ],
      },
      {
        subject: "This week in DevTools: 12 things we shipped",
        labels: ["INBOX", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("DevTools Weekly", "news@devtoolsweekly.example"),
            hoursAgo: 24 * 1 + 12,
            headers: unsubscribe("devtoolsweekly.example"),
            text: "12 things we shipped this week: faster builds, a new profiler, and dark mode for the terminal.",
            html: newsletter({
              brand: "DevTools Weekly",
              accent: "#4338ca",
              intro: "Twelve things we shipped this week. Here are our three favourites.",
              sections: [
                {
                  title: "Builds are 40% faster",
                  body: "Incremental builds now skip unchanged modules entirely.",
                  cta: "See the benchmarks",
                },
                {
                  title: "A new profiler",
                  body: "Flame graphs, now with source maps and a timeline.",
                  cta: "Try it",
                },
                {
                  title: "Dark mode, everywhere",
                  body: "Including the terminal, finally.",
                },
              ],
              footer: "DevTools Weekly, sent every Tuesday.",
            }),
          },
        ],
      },
      {
        subject: "Customer feedback digest — September",
        labels: ["CATEGORY_UPDATES"],
        messages: [
          {
            from: p("Support digest", "digest@acme.example"),
            hoursAgo: 24 * 10,
            text: "Top requests this month: offline search (41), keyboard shortcuts (27), Outlook import (12).",
            html: "<h2>September feedback</h2><table border='1' cellpadding='6' style='border-collapse:collapse'><tr><th>Request</th><th>Votes</th></tr><tr><td>Offline search</td><td>41</td></tr><tr><td>Keyboard shortcuts</td><td>27</td></tr><tr><td>Outlook import</td><td>12</td></tr></table><p>NPS: <b>54</b> (+3)</p>",
          },
        ],
      },
      {
        subject: "Lunch & learn: Rust in production",
        labels: ["INBOX", "CATEGORY_FORUMS"],
        messages: [
          {
            from: karim,
            to: [p("Engineering", "eng@acme.example")],
            hoursAgo: 24 * 8,
            text: "This Friday at 12:30, Tom talks about moving the indexer to Rust. Pizza provided 🍕",
          },
          {
            from: priya,
            to: [p("Engineering", "eng@acme.example")],
            hoursAgo: 24 * 8 - 1,
            text: "Can we record it for the remote folks?",
          },
        ],
      },
      {
        subject: "Expense report approved",
        labels: ["Finance", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("Expenses", "expenses@acme.example"),
            hoursAgo: 24 * 11,
            text: 'Your expense report "Berlin conference" (€612.40) was approved and will be paid with your next salary.',
          },
        ],
      },
      {
        subject: "Your password expires in 5 days",
        labels: ["INBOX", "CATEGORY_UPDATES"],
        messages: [
          {
            from: p("IT", "it@acme.example"),
            hoursAgo: 24 * 13,
            text: "Your Acme password expires in 5 days. Change it at id.acme.example.",
          },
        ],
      },
      {
        subject: "Welcome aboard, Sam! 🎉",
        labels: ["IMPORTANT"],
        messages: [
          {
            from: p("People team", "people@acme.example"),
            hoursAgo: 24 * 25,
            starred: true,
            text: "Welcome to Acme, Sam! Your first week's schedule is below. Your buddy is Tom Becker.",
          },
        ],
      },
      {
        subject: "Performance review — self assessment",
        labels: [],
        messages: [
          {
            to: [priya],
            hoursAgo: 6,
            draft: true,
            text: "Highlights this half:\n\n• Shipped the search index migration\n• Hired two engineers\n• ",
          },
        ],
      },
      {
        subject: "Increase your B2B leads by 500%",
        labels: ["SPAM"],
        messages: [
          {
            from: p("Growth Hacker", "leads@growth.example"),
            hoursAgo: 24 * 2,
            text: "We guarantee 500% more leads or your money back!",
          },
        ],
      },
      {
        subject: "Printer on floor 3 is out of toner again",
        labels: ["TRASH"],
        messages: [
          {
            from: karim,
            hoursAgo: 24 * 9,
            text: "Does anyone know where the spare toner lives?",
          },
        ],
      },
    ];
  },
};

export const DEMO_ACCOUNTS: SeedAccount[] = [personal, work];

// ── Outlook ──────────────────────────────────────────────────────────────────
// A mailbox for the web demo's pretend Microsoft Graph (apps/web/src/web/demo/outlook.ts):
// folders rather than labels, categories, flags and importance. Not in the
// iPhone app's bundle (that's DEMO_ACCOUNTS).

/** A folder of the Outlook seed: one of Outlook's own, or a folder of yours. */
export type OutlookSeedFolder =
  | "inbox"
  | "archive"
  | "sentitems"
  | "drafts"
  | "junkemail"
  | "deleteditems"
  | "clients"
  | "acme";

export type OutlookSeedMessage = {
  folder: OutlookSeedFolder;
  /** Messages with the same key are one conversation, each replying to the one before. */
  conversation: string;
  subject: string;
  /** Omitted: the mailbox itself. */
  from?: Person;
  /** Omitted: the mailbox (mail to it), or the conversation's first sender (mail from it). */
  to?: Person[];
  cc?: Person[];
  hoursAgo: number;
  text: string;
  html?: string;
  attachments?: SeedAttachment[];
  unread?: boolean;
  flagged?: boolean;
  importance?: "low" | "high";
  categories?: string[];
  headers?: Record<string, string>;
};

export type OutlookSeedEvent = {
  uid: string;
  subject: string;
  start: number;
  minutes: number;
  allDay?: boolean;
  location: string;
  description: string;
  organizer: Person;
  attendees: Person[];
  /** Your answer so far (Graph's words); the organizer's own events are "organizer". */
  response: "notResponded" | "accepted" | "tentativelyAccepted" | "organizer";
};

export type OutlookSeedAccount = {
  email: string;
  name: string;
  displayName: string;
  color: string;
  picture?: string;
  /** Your own folders: "Clients", and "Acme" in it. */
  folders: { key: OutlookSeedFolder; name: string; parent?: OutlookSeedFolder }[];
  /** Outlook's categories, colored with its presets. */
  categories: { name: string; color: string }[];
  messages: (seededAt: number) => OutlookSeedMessage[];
  events: (seededAt: number) => OutlookSeedEvent[];
};

const jordan = p("Jordan Lee", "jordan.lee@contoso.example");
const ava = p("Ava Thompson", "ava.thompson@contoso.example");
const diego = p("Diego Ramírez", "diego.ramirez@contoso.example");
const mei = p("Mei Tanaka", "mei.tanaka@contoso.example");
const contosoIt = p("Contoso IT", "it@contoso.example");
const samPark = p("Sam Park", "sam@acme.example");

export const DEMO_OUTLOOK_ACCOUNT: OutlookSeedAccount = {
  email: jordan.email,
  name: jordan.name,
  displayName: "Contoso",
  color: "#0078d4",
  picture: portrait("#93c5fd", "#e0ac69", "#2b1d14"),
  folders: [
    { key: "clients", name: "Clients" },
    { key: "acme", name: "Acme", parent: "clients" },
  ],
  categories: [
    { name: "Finance", color: "preset4" },
    { name: "Travel", color: "preset7" },
    { name: "Urgent", color: "preset0" },
    { name: "Follow up", color: "preset1" },
  ],
  messages: (seededAt) => {
    const reviewStart = slot(seededAt, 2, 15);
    return [
      {
        folder: "inbox",
        conversation: "welcome",
        subject: "Welcome to your Outlook demo mailbox",
        from: p("Otter Mail", "team@otter.example"),
        hoursAgo: 24 * 18,
        text: "Hi Jordan,\n\nThis mailbox pretends to be Outlook: folders instead of labels, categories, flags and importance, all answered by a made-up Microsoft Graph in your browser. Nothing here reaches Microsoft.\n\nMove mail between folders, flag it, give it categories, reply, draft, search: sync catches up the way it does with the real one.\n\nThe Otter Mail team",
      },
      {
        folder: "inbox",
        conversation: "offsite",
        subject: "Contoso offsite: venue shortlist",
        from: ava,
        to: [jordan, diego],
        hoursAgo: 24 * 3,
        categories: ["Travel"],
        text: "Hi both,\n\nThree venues made the shortlist for the offsite next month:\n\n1. The Boathouse, Lake Union (fits 40, has a dock)\n2. Cedar Hall, Bainbridge (ferry ride, great food)\n3. The Foundry, downtown (easiest to get to)\n\nAny strong feelings before I book on Friday?\n\nAva",
      },
      {
        folder: "sentitems",
        conversation: "offsite",
        subject: "Contoso offsite: venue shortlist",
        to: [ava, diego],
        hoursAgo: 24 * 2 + 5,
        text: "Cedar Hall gets my vote: the ferry ride is half the fun. The Boathouse is a close second.\n\nJordan",
      },
      {
        folder: "inbox",
        conversation: "offsite",
        subject: "Contoso offsite: venue shortlist",
        from: ava,
        to: [jordan, diego],
        hoursAgo: 3,
        unread: true,
        categories: ["Travel"],
        text: "Cedar Hall it is! I've put a hold on the dates (it's in your calendar). Jordan, could you sketch an agenda for the design track?",
      },
      {
        folder: "inbox",
        conversation: "certificate",
        subject: "Action needed: renew your VPN certificate by Friday",
        from: contosoIt,
        hoursAgo: 9,
        unread: true,
        flagged: true,
        importance: "high",
        categories: ["Urgent"],
        text: "Hi Jordan,\n\nYour VPN certificate expires on Friday. To renew it, open the Company Portal and choose Devices → Renew certificate. It takes about two minutes.\n\nAfter Friday you won't be able to reach internal sites from outside the office.\n\nContoso IT",
      },
      {
        folder: "inbox",
        conversation: "invoice",
        subject: "Invoice INV-2041 from Fabrikam Print",
        from: p("Fabrikam Print", "billing@fabrikam.example"),
        hoursAgo: 26,
        unread: true,
        categories: ["Finance"],
        text: "Hello,\n\nPlease find attached invoice INV-2041 for the workshop posters (40 × A2, matte).\n\nAmount due: $612.00, by 30 days from today.\n\nThank you for your business,\nFabrikam Print",
        attachments: [
          {
            filename: "INV-2041.pdf",
            mimeType: "application/pdf",
            content: pdf("Invoice INV-2041", [
              "Fabrikam Print, 200 Press Street",
              "Bill to: Jordan Lee, Contoso",
              "40 x A2 posters, matte ........ $560.00",
              "Delivery ...................... $52.00",
              "Total due ..................... $612.00",
            ]),
          },
        ],
      },
      {
        folder: "inbox",
        conversation: "invite",
        subject: `Sprint review: reader redesign @ ${when(reviewStart)}`,
        from: priya,
        to: [jordan, samPark],
        hoursAgo: 14,
        unread: true,
        text: `Priya Natarajan has invited you to a meeting.\n\nSprint review: reader redesign\nWhen: ${when(reviewStart)}\nWhere: Video call\n\nWalkthrough of the phase 1 screens with the Acme team.`,
        attachments: [
          invite({
            uid: "sprint-review-demo@acme.example",
            summary: "Sprint review: reader redesign",
            start: reviewStart,
            minutes: 45,
            location: "Video call",
            organizer: priya,
            attendees: [priya, samPark, jordan],
          }),
        ],
      },
      {
        folder: "inbox",
        conversation: "design-weekly",
        subject: "Design Weekly #58: Calm interfaces",
        from: p("Design Weekly", "letters@designweekly.example"),
        hoursAgo: 30,
        headers: unsubscribe("designweekly.example"),
        text: "Design Weekly #58.\n\nCalm interfaces: what an inbox can learn from a library.\n\nType at small sizes: five fonts that hold up at 12px.\n\nThe case for fewer settings.",
        html: newsletter({
          brand: "Design Weekly",
          accent: "#7c3aed",
          heroCid: "hero-calm",
          intro:
            "This week: calm interfaces, small type that holds up, and the case for fewer settings.",
          sections: [
            {
              title: "What an inbox can learn from a library",
              body: "Quiet rooms, clear signs, and nothing blinking. A tour of interfaces that get out of the way.",
              cta: "Read the essay",
            },
            {
              title: "Type at small sizes",
              body: "Five typefaces that stay legible at 12px, tested on three screens and one very old phone.",
            },
            {
              title: "The case for fewer settings",
              body: "Every toggle is a question you ask the user. Ask fewer.",
              cta: "Continue reading",
            },
          ],
          footer:
            "You're receiving this because you subscribed at designweekly.example. Design Weekly, 9 Grid Street, Portland.",
        }),
        attachments: [
          {
            filename: "calm.svg",
            mimeType: "image/svg+xml",
            contentId: "hero-calm",
            content: picture("Calm interfaces", "#ddd6fe", "#4c1d95"),
          },
        ],
      },
      {
        folder: "inbox",
        conversation: "workshop-photos",
        subject: "Photos from Tuesday's workshop",
        from: mei,
        hoursAgo: 40,
        text: "Here's the whiteboard from the end of the day, before the cleaners got to it.",
        html: `<div style="font-family:system-ui,sans-serif"><p>Here's the whiteboard from the end of the day, before the cleaners got to it.</p><p><img src="cid:whiteboard" alt="The whiteboard" width="480"></p><p>Mei</p></div>`,
        attachments: [
          {
            filename: "whiteboard.svg",
            mimeType: "image/svg+xml",
            contentId: "whiteboard",
            content: picture("Workshop whiteboard", "#fef3c7", "#b45309"),
          },
        ],
      },
      {
        folder: "inbox",
        conversation: "lunch",
        subject: "Lunch on Thursday?",
        from: diego,
        hoursAgo: 5,
        unread: true,
        text: "The new ramen place on 3rd finally opened. Thursday at 12:30?\n\nDiego",
      },
      {
        folder: "drafts",
        conversation: "lunch",
        subject: "RE: Lunch on Thursday?",
        to: [diego],
        hoursAgo: 4,
        text: "Thursday works, but can we make it 1:00? I have a call until 12:45.",
      },
      {
        folder: "inbox",
        conversation: "expenses",
        subject: "Expense report EXP-388 approved",
        from: p("Contoso Expenses", "expenses@contoso.example"),
        hoursAgo: 24 * 4,
        categories: ["Finance"],
        text: "Your expense report EXP-388 (Seattle client visit, $1,284.50) was approved by Ava Thompson. It will be paid with your next salary.",
      },
      {
        folder: "inbox",
        conversation: "kudos",
        subject: "Thanks for the onboarding deck",
        from: p("Kim Abercrombie", "kim.abercrombie@contoso.example"),
        hoursAgo: 24 * 6,
        flagged: true,
        categories: ["Follow up"],
        text: "The new hires loved it. Could you share the source file so we can keep it up to date?",
      },
      {
        folder: "archive",
        conversation: "seattle",
        subject: "Your trip to Seattle: itinerary",
        from: p("Contoso Travel", "travel@contoso.example"),
        hoursAgo: 24 * 12,
        categories: ["Travel"],
        text: "Jordan Lee, your trip is booked.\n\nFlight AS 331 · Mon 08:10 → 10:45\nHotel: The Marqueen, 2 nights\nReturn AS 338 · Wed 18:20 → 20:55",
      },
      {
        folder: "archive",
        conversation: "logo",
        subject: "Logo files",
        from: mei,
        hoursAgo: 24 * 15,
        text: "Final logo files are on the shared drive under Brand/2026. The SVGs are the ones to use.",
      },
      {
        folder: "archive",
        conversation: "all-hands",
        subject: "Recording: Q3 all-hands",
        from: p("Contoso Communications", "comms@contoso.example"),
        hoursAgo: 24 * 20,
        text: "Missed the all-hands? The recording and slides are on the intranet for the next 30 days.",
      },
      {
        folder: "clients",
        conversation: "northwind",
        subject: "Northwind intro call: notes",
        from: olu,
        hoursAgo: 24 * 8,
        flagged: true,
        text: "Thanks for the call, Jordan. As discussed: a two-week discovery in November, then a proposal for the ordering app. I'll send our brand assets over this week.\n\nOluwaseun",
      },
      {
        folder: "clients",
        conversation: "wingtip",
        subject: "Referral: Wingtip Toys",
        from: p("Kim Abercrombie", "kim.abercrombie@contoso.example"),
        hoursAgo: 24 * 10,
        text: "Wingtip Toys are looking for help with their store's checkout. I said you might be interested; their contact is Lena at wingtip.example.",
      },
      {
        folder: "acme",
        conversation: "acme-scope",
        subject: "Reader redesign: phase 2 scope",
        from: samPark,
        to: [jordan],
        cc: [priya],
        hoursAgo: 24 * 2 + 2,
        text: "Hi Jordan,\n\nPhase 1 landed well. For phase 2 we'd like to cover the conversation view and the compose window. Could you send a rough estimate by Friday?\n\nSam",
      },
      {
        folder: "sentitems",
        conversation: "acme-scope",
        subject: "Reader redesign: phase 2 scope",
        to: [samPark],
        cc: [priya],
        hoursAgo: 24 + 6,
        text: "Hi Sam,\n\nGreat to hear. Rough estimate: three weeks for the conversation view, two for compose, with a review at the end of each. Proposal attached.\n\nJordan",
        attachments: [
          {
            filename: "Acme-phase-2-proposal.pdf",
            mimeType: "application/pdf",
            content: pdf("Reader redesign - phase 2", [
              "Conversation view: 3 weeks",
              "Compose window: 2 weeks",
              "Reviews at the end of each",
              "Contoso Design, Jordan Lee",
            ]),
          },
        ],
      },
      {
        folder: "acme",
        conversation: "acme-scope",
        subject: "Reader redesign: phase 2 scope",
        from: samPark,
        to: [jordan],
        cc: [priya],
        hoursAgo: 2,
        unread: true,
        flagged: true,
        categories: ["Urgent"],
        text: "Looks good. Legal needs the signed SOW before we start: can you get it to me by Wednesday?",
      },
      {
        folder: "acme",
        conversation: "acme-brand",
        subject: "Acme brand guidelines v3",
        from: hanna,
        hoursAgo: 24 * 5,
        text: "Here are the updated brand guidelines. The main change: the accent orange is now a little warmer.",
        attachments: [
          {
            filename: "acme-brand-guidelines.txt",
            mimeType: "text/plain",
            content:
              "Acme brand guidelines, v3\n\nPrimary: #f97316 (warmer than v2)\nText: #1f2937\nType: Inter for UI, Georgia for long reads\nLogo: keep 16px clear space on every side\n",
          },
        ],
      },
      {
        folder: "junkemail",
        conversation: "prize",
        subject: "You've won a $500 gift card!!!",
        from: p("Rewards Center", "winner@prizes.example"),
        hoursAgo: 24 * 2,
        unread: true,
        text: "Congratulations! Click here to claim your $500 gift card before it expires tonight!",
      },
      {
        folder: "junkemail",
        conversation: "phish",
        subject: "Your mailbox is almost full: verify now",
        from: p("Mail Support", "no-reply@mailbox-support.example"),
        hoursAgo: 24 * 4,
        text: "Your mailbox will be closed in 24 hours. Verify your password to keep receiving mail.",
      },
      {
        folder: "deleteditems",
        conversation: "digest",
        subject: "Weekly digest: 12 new comments",
        from: p("Tasks", "notifications@tasks.example"),
        hoursAgo: 24 * 7,
        text: "12 new comments on 4 tasks this week. Open Tasks to catch up.",
      },
    ];
  },
  events: (seededAt) => [
    {
      uid: "sprint-review-demo@acme.example",
      subject: "Sprint review: reader redesign",
      start: slot(seededAt, 2, 15),
      minutes: 45,
      location: "Video call",
      description: "Walkthrough of the phase 1 screens with the Acme team.",
      organizer: priya,
      attendees: [priya, samPark, jordan],
      response: "notResponded",
    },
    {
      uid: "design-sync-demo@contoso.example",
      subject: "Design sync",
      start: slot(seededAt, 1, 17),
      minutes: 30,
      location: "Room Puget",
      description: "Weekly design team sync.",
      organizer: jordan,
      attendees: [jordan, mei, diego],
      response: "organizer",
    },
    {
      uid: "offsite-demo@contoso.example",
      subject: "Contoso offsite",
      start: slot(seededAt, 34, 0),
      minutes: 2 * 24 * 60,
      allDay: true,
      location: "Cedar Hall, Bainbridge",
      description: "Two days on the island. Agenda to follow.",
      organizer: ava,
      attendees: [ava, jordan, diego, mei],
      response: "tentativelyAccepted",
    },
  ],
};
