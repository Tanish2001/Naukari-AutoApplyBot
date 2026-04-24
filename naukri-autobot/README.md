# NaukriBot — Auto Apply Chrome Extension

Automatically applies to jobs on Naukri.com. Skips any job that redirects to an external company site.

---

## Features

- **Auto-scans** job listings on Naukri search/results pages
- **Skips external-apply jobs** — never lands on a third-party company site
- **Form filler** — maps your profile (name, exp, CTC, notice, location) to Naukri apply forms
- **Smart field detection** — fuzzy label matching handles Naukri's inconsistent form labels
- **Human-like delays** — randomised timing between applications to avoid detection
- **Pause on unknown fields** — stops and highlights any field it can't fill automatically
- **Persistent log** — tracks all applications with company, role, status, and timestamp
- **Session memory** — never applies to the same job twice (stored in chrome.storage.local)

---

## Project Structure

```
naukri-autobot/
├── manifest.json
├── src/
│   ├── content/
│   │   └── content.js          # Main bot engine (injected into Naukri)
│   ├── background/
│   │   └── service-worker.js   # Background SW + message relay
│   ├── popup/
│   │   ├── popup.html          # Extension popup UI
│   │   └── popup.js            # Popup controller
│   └── utils/
│       ├── storage.js          # Storage helpers (reference/import version)
│       └── helpers.js          # Filters + form mapper (reference/import version)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Installation (Developer Mode)

1. **Add icons** — Create or drop PNG icons into the `icons/` folder:
   - `icon16.png` (16×16)
   - `icon48.png` (48×48)
   - `icon128.png` (128×128)
   Any solid-colour square PNG works. You can use a free tool like https://favicon.io

2. **Open Chrome** and go to `chrome://extensions`

3. Enable **Developer mode** (top-right toggle)

4. Click **"Load unpacked"** and select the `naukri-autobot/` folder

5. The extension icon will appear in your toolbar

---

## Usage

1. **Fill your profile** — Click the extension icon → Profile tab → enter your details → Save Profile

2. **Configure settings** — Settings tab — enable/disable auto-submit, pause-on-unknown, delays

3. **Go to Naukri.com** — Open a job search results page (e.g., search for "React Developer Mumbai")

4. **Start the bot** — Click the extension icon → Dashboard tab → **▶ Start Bot**

5. The bot will:
   - Scan all visible job cards
   - Skip external-apply jobs (logged as "skipped")
   - Click Apply on eligible jobs
   - Wait for Naukri's apply form/modal
   - Fill all recognised fields from your profile
   - Submit (if auto-submit is on)
   - Log the result and wait for the configured delay
   - Continue to the next job

6. **Monitor** — Watch the log in the Dashboard tab update in real time

---

## How External-Site Detection Works

The bot checks three signals before clicking Apply:

1. **`data-is-external` / `data-redirect` attributes** on the job card — Naukri sets these server-side
2. **Apply button `href`** — if it points outside `naukri.com`, skip
3. **Button text** — phrases like "Apply on company site", "Apply on LinkedIn" trigger a skip

Any job that passes all three checks is considered a Naukri-native application.

---

## Field Mapping

The form filler matches these profile fields:

| Profile field      | Matched form labels (examples)                          |
|--------------------|--------------------------------------------------------|
| fullName           | Full name, Your name, Applicant name                   |
| email              | Email, Email ID, E-mail address                        |
| phone              | Mobile, Phone, Contact number                          |
| totalExpYears      | Total experience, Years of experience, Experience      |
| currentCTC         | Current CTC, Current salary, Present CTC               |
| expectedCTC        | Expected CTC, Expected salary, Desired CTC             |
| noticePeriodDays   | Notice period, Notice, Joining period, Availability    |
| currentLocation    | Current location, City, Present location               |
| preferredLocations | Preferred location, Desired location                   |

---

## Anti-Detection Tips

- Keep **Human-like delays** on with a min of 5s and max of 20s
- Don't run for more than 2–3 hours continuously
- Naukri may show a CAPTCHA if it detects automation — the bot will stop and the form will remain open
- Rotate between different job search pages rather than hammering one results page

---

## Limitations

- Does not handle CAPTCHA challenges
- Does not upload/change resume (Naukri uses the resume already on your profile)
- Multi-step apply flows (chatbot-style questionnaires) are partially supported — the bot fills text fields and selects on each step but may not handle complex branching
- Cover letter fields are left blank (extend `LABEL_MAP` in `content.js` to add support)

---

## Extending the Field Mapper

To add a new field (e.g., cover letter), edit the `LABEL_MAP` array in `src/content/content.js`:

```js
{ keys: ["cover letter", "why do you want to join", "about yourself"], profile: "coverLetter" },
```

Then add `coverLetter` to the profile object in `src/popup/popup.html` and `manifest.json` defaults.

---

## Disclaimer

This tool is for personal productivity. Use responsibly and in accordance with Naukri.com's Terms of Service. Excessive automated usage may result in account restrictions.
