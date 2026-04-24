// ============================================================
// content.js — NaukriBot (Naukri.com 2025)
//
// TWO-MODE ARCHITECTURE:
//   LISTING PAGE → collect job URLs → navigate to first job
//   DETAIL PAGE  → click Apply → solve chatbot → submit → next job
//
// CHATBOT SOLVER:
//   Watches chatbot_MessageContainer for new bot messages
//   Maps each question to a profile value or smart default
//   Fills contenteditable input via execCommand
//   Waits for Save button to enable → clicks it
//   Loops until chatbot completes
// ============================================================

(async function () {
  "use strict";

  // ── Storage ────────────────────────────────────────────────

  const syncGet  = k  => new Promise(r => chrome.storage.sync.get(k, r));
  const localGet = k  => new Promise(r => chrome.storage.local.get(k, r));
  const localSet = obj => new Promise(r => chrome.storage.local.set(obj, r));

  async function getQueue()           { return (await localGet("botQueue")).botQueue || []; }
  async function setQueue(q)          { await localSet({ botQueue: q }); }
  async function isRunning()          { return !!((await localGet("botRunning")).botRunning); }
  async function getAppliedIds()      { return new Set(((await localGet("appliedIds")).appliedIds || [])); }
  async function markApplied(id)      { const s = await getAppliedIds(); s.add(String(id)); await localSet({ appliedIds: [...s] }); }

  async function appendLog(entry) {
    const d = await localGet("appLog");
    const log = d.appLog || [];
    log.unshift({ ...entry, time: new Date().toISOString() });
    await localSet({ appLog: log.slice(0, 500) });
    chrome.runtime.sendMessage({ type: "LOG_UPDATE", entry }).catch(() => {});
  }
  async function incrementStat(key) {
    const d = await localGet("stats");
    const s = d.stats || { applied: 0, skipped: 0, failed: 0 };
    s[key] = (s[key] || 0) + 1;
    await localSet({ stats: s });
    chrome.runtime.sendMessage({ type: "STATS_UPDATE", stats: s }).catch(() => {});
  }

  // ── Helpers ────────────────────────────────────────────────

  const delay = (min, max) => new Promise(r =>
    setTimeout(r, (Math.random() * (max - min) + min) * 1000)
  );

  function waitForAny(sels, ms = 10000) {
    return new Promise(resolve => {
      const check = () => { for (const s of sels) { const e = document.querySelector(s); if (e) return { el: e, sel: s }; } return null; };
      const hit = check(); if (hit) return resolve(hit);
      const obs = new MutationObserver(() => { const h = check(); if (h) { obs.disconnect(); resolve(h); } });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, ms);
    });
  }

  function showToast(msg, type = "info") {
    const old = document.getElementById("nb-toast"); if (old) old.remove();
    const el = document.createElement("div"); el.id = "nb-toast";
    el.style.cssText = `position:fixed;bottom:20px;right:20px;z-index:2147483647;
      background:${type==="warn"?"#d97706":type==="error"?"#dc2626":"#059669"};
      color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:500;
      max-width:320px;line-height:1.4;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.25);`;
    el.textContent = "NaukriBot: " + msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  // Fill a React-controlled <input> or <select>
  function fillInput(el, value) {
    el.focus();
    if (el.tagName === "SELECT") {
      const s = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (s) s.call(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (s) s.call(el, value);
      ["input","change"].forEach(n => el.dispatchEvent(new Event(n, { bubbles: true })));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    }
    el.blur();
  }

  // Fill a React contenteditable div (Naukri chatbot input)
  // Strategy: use clipboard paste — most reliable way to trigger React onChange
  // Falls back to execCommand("insertText") if clipboard API unavailable
  async function fillContentEditable(el, value) {
    el.focus();

    // Clear existing content first
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);

    // Try clipboard paste first (most reliable for React)
    try {
      await navigator.clipboard.writeText(String(value));
      document.execCommand("paste");
      // Give React time to process
      await new Promise(r => setTimeout(r, 100));
      // If content didn't appear (clipboard blocked), fall back
      if (!el.textContent.trim()) throw new Error("clipboard blocked");
      return;
    } catch (e) {
      // Clipboard not available (common in extensions) — use execCommand insertText
    }

    // execCommand insertText — triggers React synthetic onChange
    el.focus();
    document.execCommand("selectAll", false, null);
    const inserted = document.execCommand("insertText", false, String(value));

    if (!inserted || !el.textContent.trim()) {
      // Final fallback: manual DOM + InputEvent
      el.innerHTML = "";
      const textNode = document.createTextNode(String(value));
      el.appendChild(textNode);
      // Move cursor to end
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      // Fire InputEvent that React listens to
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: String(value),
        inputType: "insertText",
      }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // ── Page type ──────────────────────────────────────────────

  async function isDetailPage() {
    const path = location.pathname;
    // Standard detail page URL
    if (path.includes("job-listings-")) return true;
    // Naukri redirects expired jobs to a listing URL with ?expJD=true
    if (location.search.includes("expJD=true")) return true;
    // Check if current URL contains queue[0].jobId (handles Naukri URL redirects)
    const queue = await getQueue();
    if (queue.length > 0) {
      const jobId = queue[0].jobId;
      if (jobId && location.href.includes(jobId)) return true;
    }
    return false;
  }

  // Reusable expired check (used in detail mode too)
  function isExpiredJobPage() {
    // Fastest check: Naukri redirects expired jobs to listing page with ?expJD=true
    if (location.search.includes("expJD=true")) return true;
    // Fallback: check rendered page text
    const bodyText = document.body?.innerText?.toLowerCase() || "";
    return [
      "job you are looking for is expired",
      "this job is no longer available",
      "job has expired",
      "job is expired",
      "no longer accepting applications",
      "position has been filled",
    ].some(p => bodyText.includes(p));
  }

  // ── QUESTION → ANSWER MAPPER ───────────────────────────────
  // Maps chatbot question text to a profile value or smart default
  // YES-BIAS: unknown yes/no questions → "Yes"

  // Generate a date string offset from today, in the right format
  function buildDate(offsetDays, formatHint = "DD/MM/YYYY") {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    if (formatHint === "YYYY-MM-DD") return `${yyyy}-${mm}-${dd}`;
    if (formatHint === "MM/DD/YYYY") return `${mm}/${dd}/${yyyy}`;
    return `${dd}/${mm}/${yyyy}`; // default DD/MM/YYYY
  }

  // Detect date format from an input element's attributes
  function detectDateFormat(inputEl) {
    if (!inputEl) return "DD/MM/YYYY";
    const type = inputEl.getAttribute("type") || "";
    if (type === "date") return "YYYY-MM-DD"; // native date input
    const ph = (inputEl.placeholder || "").toLowerCase();
    if (ph.includes("yyyy-mm") || ph.includes("yyyy/mm")) return "YYYY-MM-DD";
    if (ph.includes("mm/dd") || ph.match(/mm.*dd.*yyyy/)) return "MM/DD/YYYY";
    return "DD/MM/YYYY";
  }

  function answerQuestion(questionText, profile, inputEl = null) {
    const q = questionText.toLowerCase().replace(/[*:?]/g, "").trim();

    // ── Direct profile field matches ──

    const fmt = detectDateFormat(inputEl);

    // ── Interview availability date ──
    // Must come BEFORE notice period check to avoid collision
    if (matches(q, [
      "when are you available for interview", "available for interview",
      "interview availability", "when can we interview", "available to interview",
      "preferred interview date", "interview date", "when can you attend interview",
    ])) return buildDate(1, fmt); // tomorrow — seem immediately available

    // ── Joining / start date ──
    if (matches(q, [
      "when can you join", "joining date", "expected joining", "start date",
      "when can you start", "date of joining", "earliest joining", "joining from",
      "when will you be available to join", "available to join",
    ])) {
      const days = parseInt(profile.noticePeriodDays) || 30;
      return buildDate(days, fmt);
    }

    // ── Date of birth ──
    if (matches(q, ["date of birth","dob","birth date","born on","your dob"]))
      return profile.dateOfBirth || null; // null = unknown, don't guess

    if (matches(q, ["current company","current employer","company name","present company","current organisation","where do you work","your company"]))
      return profile.currentCompany || "Self Employed";

    if (matches(q, ["full name","your name","name","applicant name"]))
      return profile.fullName || null;

    if (matches(q, ["skill","technology","tech stack","primary skill","key skill","expertise","proficiency in","experience with","knowledge of"]))
      return profile.skills || profile.totalExpYears + " years experience in Java and related technologies" || null;

    if (matches(q, ["email","email id","email address","mail id"]))
      return profile.email || "";

    if (matches(q, ["mobile","phone","contact number","mobile number","phone number"]))
      return profile.phone || "";

    if (matches(q, ["total experience","years of experience","experience","work experience","total exp","exp in years","years of exp","how many years"]))
      return profile.totalExpYears || "";

    if (matches(q, ["current ctc","current salary","present ctc","current package","existing ctc","last drawn","current compensation","what is your current"]))
      return profile.currentCTC || "";

    if (matches(q, ["expected ctc","expected salary","desired ctc","expected package","salary expectation","expected compensation","what salary"]))
      return profile.expectedCTC || "";

    if (matches(q, ["notice period","notice","joining period","days notice","notice (days)","serving notice","notice remaining"]))
      return profile.noticePeriodDays || "";

    if (matches(q, ["current location","present location","current city","your city","where are you located","current location"]))
      return profile.currentLocation || "";

    if (matches(q, ["preferred location","preferred city","desired location","work location preference"]))
      return profile.preferredLocations || "";

    if (matches(q, ["github","github url","github profile","github link"]))
      return profile.githubUrl || "";

    if (matches(q, ["linkedin","linkedin url","linkedin profile","linkedin link"]))
      return profile.linkedinUrl || "";

    if (matches(q, ["portfolio","portfolio url","portfolio link","website","personal website"]))
      return profile.portfolioUrl || "";

    if (matches(q, ["gender","your gender","male or female","sex"]))
      return profile.gender || "Male"; // default Male if not set

    if (matches(q, ["highest qualification","education","degree","qualification","highest degree"]))
      return profile.qualification || "B.Tech/B.E.";

    if (matches(q, ["are you a fresher","fresher or experienced","fresher"]))
      return parseInt(profile.totalExpYears) > 0 ? "Experienced" : "Fresher";

    // ── YES-BIAS section ──
    // For all soft questions we don't recognise → answer Yes/affirmative

    // Explicit yes/no patterns
    if (yesNoQuestion(q)) return "Yes";

    // Willing / open / comfortable / available questions → Yes
    if (matches(q, ["willing","open to","comfortable","available","can you","are you able","would you","do you agree","do you consent"]))
      return "Yes";

    // Relocate
    if (q.includes("reloc")) return "Yes";

    // Shift / timing
    if (matches(q, ["shift","night shift","rotational","weekend","work from office","wfo","hybrid","remote","on-site","onsite"]))
      return "Yes";

    // Immediate joiner
    if (matches(q, ["immediate","join immediately","15 days","30 days","joining notice"]))
      return profile.noticePeriodDays || "30";

    // Skill rating (1-5 or 1-10) → confident 4 or 8
    if (matches(q, ["rate","rating","out of 5","out of 10","scale of","proficiency","expertise level","skill level"])) {
      if (q.includes("10")) return "8";
      return "4";
    }

    // Years of experience in specific skill → use profile exp or reasonable default
    if (matches(q, ["how many years","years of experience in","experience with","experience in"])) {
      return profile.totalExpYears || "3";
    }

    // Currently employed / working
    if (matches(q, ["currently employed","currently working","are you working","present employer","current company"]))
      return "Yes";

    // Number of offers / current offers
    if (matches(q, ["offer in hand","current offer","other offers","competing offers"]))
      return "No";

    // Background verification / drug test / criminal record
    if (matches(q, ["background check","background verification","drug test","criminal record","police verification"]))
      return "Yes";

    // Last working day
    if (matches(q, ["last working day","last day","relieving date"]))
      return "30 days from joining";

    // Have you applied before / interviewed before
    if (matches(q, ["applied before","previously applied","interviewed before","previous interview"]))
      return "No";

    // Salary negotiable
    if (matches(q, ["negotiable","salary negotiable","open to negotiation"]))
      return "Yes";

    // Default fallback — return empty string so bot knows it's unknown
    return null;
  }

  function matches(text, keywords) {
    return keywords.some(k => text.includes(k));
  }

  function yesNoQuestion(q) {
    const yesNoPatterns = [
      /^(do|does|are|is|can|will|have|has|would|should|did)\s/,
      /\b(do you|are you|have you|can you|will you|would you)\b/,
    ];
    return yesNoPatterns.some(p => p.test(q));
  }

  // ── CHATBOT SOLVER ─────────────────────────────────────────

  async function solveChatbot(profile, settings) {
    console.log("[NaukriBot] Starting chatbot solver");

    const drawer = document.querySelector(".chatbot_Drawer, [class*='chatbot_Drawer']");
    if (!drawer) {
      console.warn("[NaukriBot] Chatbot drawer not found");
      return { status: "failed", reason: "Chatbot drawer not found", answered: 0 };
    }

    const msgContainer = drawer.querySelector(".chatbot_MessageContainer, [class*='MessageContainer']");
    if (!msgContainer) {
      console.warn("[NaukriBot] Message container not found");
      return { status: "failed", reason: "Message container not found", answered: 0 };
    }

    let answered = 0;
    let unknownQuestions = [];
    let completed = false;
    const MAX_QUESTIONS = 30;
    let lastQuestion = "";
    let repeatCount = 0;

    // Helper: get the last bot message text
    function getLastBotQuestion() {
      const items = msgContainer.querySelectorAll("li.botItem, .botItem");
      if (!items.length) return null;
      const last = items[items.length - 1];
      return last.textContent.trim();
    }

    // Helper: get the input box
    function getInputBox() {
      return drawer.querySelector(".textArea[contenteditable], [contenteditable='true'].textArea, [id*='InputBox'][contenteditable]");
    }

    // Helper: get the Save button
    // DOM: div.sendMsgbtn_container > div.send[.disabled] > div.sendMsg
    // Disabled state is on div.send, clickable target is div.sendMsg
    function getSaveBtn() {
      return drawer.querySelector(".sendMsg");
    }

    function isSaveBtnEnabled() {
      const btn = getSaveBtn();
      if (!btn) return false;
      // Check if the parent div.send has the disabled class
      const sendWrap = btn.closest(".send, [class*='send']");
      if (sendWrap && sendWrap.classList.contains("disabled")) return false;
      return true;
    }

    // Helper: wait for Save button to become enabled
    async function waitForSaveEnabled(ms = 5000) {
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (isSaveBtnEnabled()) return getSaveBtn();
        await delay(0.15, 0.25);
      }
      return getSaveBtn(); // return anyway and let it try
    }

    // Helper: wait for a NEW bot message to appear after answering
    function waitForNewBotMessage(previousCount, ms = 10000) {
      return new Promise(resolve => {
        const start = Date.now();
        const check = () => {
          const count = msgContainer.querySelectorAll("li.botItem, .botItem").length;
          if (count > previousCount) return resolve(true);
          if (Date.now() - start > ms) return resolve(false);
        };
        const obs = new MutationObserver(() => {
          const count = msgContainer.querySelectorAll("li.botItem, .botItem").length;
          if (count > previousCount) { obs.disconnect(); resolve(true); }
        });
        obs.observe(msgContainer, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); resolve(false); }, ms);
      });
    }

    // Helper: check if chatbot shows option chips/buttons to click
    function getOptionChips() {
      // Radio options: label.ssrc__label
      const radio = [...drawer.querySelectorAll("label.ssrc__label, [class*='ssrc__label']")]
        .filter(c => c.textContent.trim().length > 0);
      if (radio.length) return { chips: radio, type: "radio" };

      // MCQ (multi-select) options: label.mcc__label
      const mcq = [...drawer.querySelectorAll("label.mcc__label, [class*='mcc__label']")]
        .filter(c => c.textContent.trim().length > 0);
      if (mcq.length) return { chips: mcq, type: "mcq" };

      // Fallback
      const fallback = [...drawer.querySelectorAll(".chatbot_chip, .userChip")]
        .filter(c => c.textContent.trim().length > 0);
      return { chips: fallback, type: "radio" };
    }

    // Helper: detect if chatbot completed (success message or submit button)
    function isChatbotDone() {
      const text = msgContainer.textContent.toLowerCase();
      return text.includes("successfully applied") ||
             text.includes("application submitted") ||
             text.includes("thank you for applying") ||
             text.includes("thank you for your responses") ||
             text.includes("thanks for your responses") ||
             text.includes("you have already applied") ||
             text.includes("your application has been") ||
             text.includes("we have received your application") ||
             !!drawer.querySelector("[class*='success'], [class*='applied']");
    }

    // Main solve loop
    for (let i = 0; i < MAX_QUESTIONS && !completed; i++) {
      await delay(0.8, 1.5); // wait for question to fully render

      // Check done FIRST before reading question
      if (isChatbotDone()) { completed = true; console.log("[NaukriBot] Chatbot completed"); break; }

      const question = getLastBotQuestion();
      if (!question) { console.log("[NaukriBot] No question found, stopping"); break; }

      // Stuck-loop guard — same question 3 times = skip it
      if (question === lastQuestion) {
        repeatCount++;
        if (repeatCount >= 3) {
          console.warn(`[NaukriBot] Stuck on question (${repeatCount}x), skipping: "${question}"`);
          unknownQuestions.push(question);
          // Try clicking Skip if available
          const skipChipFallback = getOptionChips().chips.find(c => c.textContent.trim().toLowerCase().includes("skip"));
          if (skipChipFallback) {
            skipChipFallback.click();
            const prevCount = msgContainer.querySelectorAll("li.botItem, .botItem").length;
            await waitForNewBotMessage(prevCount, 5000);
          }
          repeatCount = 0;
          lastQuestion = "";
          continue;
        }
      } else {
        lastQuestion = question;
        repeatCount = 0;
      }

      console.log(`[NaukriBot] Question [${i}]: "${question}"`);

      // Check for option chips (radio or MCQ)
      const { chips, type: chipType } = getOptionChips();
      const realChips = chips.filter(c => !c.textContent.trim().toLowerCase().includes("skip"));
      const skipChip = chips.find(c => c.textContent.trim().toLowerCase().includes("skip"));

      if (chips.length > 0) {
        console.log(`[NaukriBot] ${chipType.toUpperCase()} chips: [${chips.map(c=>'"'+c.textContent.trim()+'"').join(", ")}]`);

        if (chipType === "mcq") {
          // ── MCQ: select ALL real options ──
          for (const chip of realChips) {
            const checkbox = chip.previousElementSibling?.matches?.('input[type="checkbox"]')
              ? chip.previousElementSibling
              : chip.closest("label")?.querySelector('input[type="checkbox"]')
                || (chip.getAttribute("for") ? document.getElementById(chip.getAttribute("for")) : null);
            if (checkbox && !checkbox.checked) {
              checkbox.click();
              await delay(0.1, 0.2);
            } else if (!checkbox) {
              chip.click();
              await delay(0.1, 0.2);
            }
            console.log(`[NaukriBot] MCQ selected: "${chip.textContent.trim()}"`);
          }
          answered++;
          await delay(0.3, 0.5);
          const saveBtn = await waitForSaveEnabled(4000);
          if (saveBtn) {
            const prevCount = msgContainer.querySelectorAll("li.botItem, .botItem").length;
            saveBtn.click();
            await waitForNewBotMessage(prevCount, 8000);
          }
          continue;
        }

        // ── Radio: pick best single option ──
        const answer = answerQuestion(question, profile, null);
        let clicked = false;

        if (answer) {
          for (const chip of realChips) {
            const chipText = chip.textContent.trim().toLowerCase();
            if (chipText.includes(answer.toLowerCase()) || answer.toLowerCase().includes(chipText)) {
              chip.click(); clicked = true;
              console.log(`[NaukriBot] Clicked matching chip: "${chip.textContent.trim()}"`);
              break;
            }
          }
        }

        if (!clicked) {
          const yesChip = realChips.find(c => c.textContent.trim().toLowerCase() === "yes");
          if (yesChip) { yesChip.click(); clicked = true; console.log(`[NaukriBot] Clicked Yes chip`); }
        }

        if (!clicked && realChips.length > 0) {
          realChips[0].click(); clicked = true;
          console.log(`[NaukriBot] Clicked first chip: "${realChips[0].textContent.trim()}"`);
        }

        if (clicked) {
          answered++;
          const prevCount = msgContainer.querySelectorAll("li.botItem, .botItem").length;
          const gotNext = await waitForNewBotMessage(prevCount, 6000);
          if (!gotNext) {
            const saveBtn = getSaveBtn();
            if (saveBtn) { saveBtn.click(); await waitForNewBotMessage(prevCount, 5000); }
          }
          continue;
        }
      }

      // No chips — use text input
      const inputBox = getInputBox();
      const answer = answerQuestion(question, profile, inputBox);

      if (!answer) {
        console.warn(`[NaukriBot] Unknown question: "${question}"`);
        unknownQuestions.push(question);

        const q_lower = question.toLowerCase();
        let fallback = null;

        const isDateQuestion = q_lower.includes("date") || q_lower.includes("when") ||
                               q_lower.includes("schedule") || q_lower.includes("time slot");
        if (isDateQuestion) {
          fallback = buildDate(1, detectDateFormat(inputBox));
          console.log(`[NaukriBot] Date fallback: "${fallback}" for: "${question}"`);
        }

        const skipPatterns = ["date of birth","dob","birth date","pan card","aadhar","passport","pin code","zip","postal"];
        const isSkippable = !fallback && skipPatterns.some(p => q_lower.includes(p));

        if (!fallback && !isSkippable) fallback = "Yes";

        if (fallback) {
          if (inputBox) {
            fillContentEditable(inputBox, fallback);
            await delay(0.5, 0.8);
            const saveBtn = await waitForSaveEnabled(3000);
            if (saveBtn) {
              saveBtn.click();
              answered++;
              console.log(`[NaukriBot] Fallback "${fallback}" for: "${question}"`);
              const prevCount = msgContainer.querySelectorAll("li.botItem, .botItem").length;
              await waitForNewBotMessage(prevCount, 8000);
            }
          }
        } else {
          console.log(`[NaukriBot] Skipping unanswerable: "${question}"`);
          if (inputBox) {
            inputBox.focus();
            inputBox.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13 }));
            await delay(0.5, 1);
          }
        }
        continue;
      }

      // Fill the contenteditable input
      if (!inputBox) {
        console.warn("[NaukriBot] Input box not found");
        break;
      }

      console.log(`[NaukriBot] Answering: "${answer}"`);
      fillContentEditable(inputBox, answer);
      await delay(0.4, 0.8);

      // Wait for Save button to become clickable
      const saveBtn = await waitForSaveEnabled(5000);
      if (!saveBtn) {
        console.warn("[NaukriBot] Save button not found");
        break;
      }

      // Click Save
      const prevCount = msgContainer.querySelectorAll("li.botItem, .botItem").length;
      saveBtn.click();
      answered++;
      console.log(`[NaukriBot] Saved answer #${answered}`);

      // Wait for next bot message
      const gotNext = await waitForNewBotMessage(prevCount, 10000);
      if (!gotNext) {
        console.log("[NaukriBot] No new message after save — checking if done");
        if (isChatbotDone()) { completed = true; break; }
        // Maybe the last question was answered and submit appeared
        break;
      }

      // Check done after each answer
      if (isChatbotDone()) { completed = true; break; }
    }

    console.log(`[NaukriBot] Chatbot done. Answered: ${answered}, Unknown: ${unknownQuestions.length}`);
    return {
      status: completed ? "applied" : "chatbot_done",
      reason: `Answered ${answered} questions`,
      answered,
      unknownQuestions,
    };
  }

  // ── LABEL → PROFILE KEY (for regular forms) ───────────────

  const LABEL_MAP = [
    { keys: ["full name","your name","name","applicant name","candidate name"], profile: "fullName" },
    { keys: ["email","email id","email address","e-mail","mail id"], profile: "email" },
    { keys: ["mobile","phone","contact number","mobile number","phone number","contact no","mobile no"], profile: "phone" },
    { keys: ["total experience","years of experience","experience","work experience","total exp","experience in years","years"], profile: "totalExpYears" },
    { keys: ["current ctc","current salary","present ctc","current package","existing ctc","last drawn"], profile: "currentCTC" },
    { keys: ["expected ctc","expected salary","desired ctc","expected package","salary expectation"], profile: "expectedCTC" },
    { keys: ["notice period","notice","joining period","availability","joining time"], profile: "noticePeriodDays" },
    { keys: ["current location","present location","current city","city","location"], profile: "currentLocation" },
    { keys: ["preferred location","preferred city","desired location"], profile: "preferredLocations" },
    { keys: ["date of birth","dob","birth date"], profile: "dateOfBirth" },
    { keys: ["gender","sex"], profile: "gender" },
    { keys: ["github"], profile: "githubUrl" },
    { keys: ["linkedin"], profile: "linkedinUrl" },
    { keys: ["portfolio","website"], profile: "portfolioUrl" },
  ];

  function labelToKey(text) {
    const n = text.toLowerCase().replace(/[*:()\[\]\/]/g, "").trim();
    for (const e of LABEL_MAP) {
      if (e.keys.includes(n)) return e.profile;
      if (e.keys.some(k => n.includes(k) || k.includes(n))) return e.profile;
    }
    return null;
  }

  function fieldKey(el) {
    const srcs = [];
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) srcs.push(l.textContent); }
    if (el.getAttribute("aria-label")) srcs.push(el.getAttribute("aria-label"));
    if (el.placeholder) srcs.push(el.placeholder);
    if (el.name) srcs.push(el.name.replace(/[-_]/g, " "));
    const pl = el.closest("label"); if (pl) srcs.push(pl.textContent);
    const wrap = el.closest("div, li, tr, .form-group, .field-wrap");
    if (wrap) { const l = wrap.querySelector("label, .label, .field-label, span.label"); if (l && l !== el) srcs.push(l.textContent); }
    for (const s of srcs) { const k = labelToKey(s); if (k) return k; }
    return null;
  }

  async function fillRegularForm(root, profile) {
    const inputs = root.querySelectorAll(
      'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]),select,textarea'
    );
    let filled = 0;
    const unknown = [];
    for (const el of inputs) {
      if (el.disabled || el.readOnly || el.type === "radio" || el.type === "checkbox") continue;
      const k = fieldKey(el);
      if (k && profile[k]) {
        await delay(0.15, 0.4);
        fillInput(el, profile[k]);
        filled++;
      } else {
        const wrap = el.closest("div, li, .form-group");
        const lbl = wrap?.querySelector("label, .label, .field-label");
        const t = lbl?.textContent?.trim() || el.placeholder || el.name || "";
        if (t && !["search","submit","cancel","close","filter"].includes(t.toLowerCase())) unknown.push(t);
      }
    }
    return { filled, unknown };
  }

  // ── Button detection ───────────────────────────────────────

  const APPLY_TEXTS   = ["apply", "apply now", "quick apply", "easy apply"];
  const INTEREST_TEXTS = ["i'm interested", "i am interested", "share my interest", "show interest", "interested"];
  const EXTERNAL_PHRASES = ["apply on company site","apply at company","apply on linkedin","apply on indeed","external apply","visit company","company website","apply on company's site"];
  const ALREADY_APPLIED_TEXTS = ["applied", "already applied", "application submitted", "you've applied"];

  function findApplyBtn() {
    // Class-based first
    const SELS = ["button.apply-button","a.apply-button","[class*='apply-button']","[class*='applyButton']","button[id*='apply']"];
    for (const s of SELS) {
      const e = document.querySelector(s);
      if (e && !ALREADY_APPLIED_TEXTS.includes(e.textContent.trim().toLowerCase())) return e;
    }
    // Text-based
    for (const el of document.querySelectorAll("button, a[role='button']")) {
      const t = el.textContent.trim().toLowerCase();
      if (APPLY_TEXTS.includes(t)) return el;
    }
    return null;
  }

  function findInterestBtn() {
    // Class-based (faster, more reliable)
    const byClass = document.querySelector("button.walkin-button, [class*='walkin-button'], [class*='walkin_button']");
    if (byClass) return byClass;
    // Text-based fallback
    for (const el of document.querySelectorAll("button, a[role='button'], a")) {
      const t = el.textContent.trim().toLowerCase();
      if (INTEREST_TEXTS.some(p => t.includes(p))) return el;
    }
    return null;
  }

  function isExternalBtn(btn) {
    if (!btn) return false;
    const t = btn.textContent.toLowerCase();
    if (EXTERNAL_PHRASES.some(p => t.includes(p))) return true;
    const href = btn.getAttribute("href") || "";
    return !!(href && !href.startsWith("/") && !href.includes("naukri.com"));
  }

  // Check if this job is already applied (Naukri shows a badge/button)
  function isAlreadyApplied() {
    // Check for "Applied" badge/button on the detail page
    for (const el of document.querySelectorAll("button, span, div, a")) {
      const t = el.textContent.trim().toLowerCase();
      if (ALREADY_APPLIED_TEXTS.some(p => t === p)) return true;
    }
    // Also check URL — Naukri sometimes keeps applied state in meta
    const meta = document.querySelector('meta[name="applied"], [class*="applied-tag"], [class*="alreadyApplied"]');
    if (meta) return true;
    return false;
  }

  // ── LISTING MODE ───────────────────────────────────────────

  // Extracts job info from a card element — works for both SRP and recommended pages
  function extractJobFromCard(card, appliedIds, settings) {
    const jobId = card.getAttribute("data-job-id");
    if (!jobId) return null;
    if (settings.skipAlreadyApplied && appliedIds.has(String(jobId))) return null;

    // ── URL ──
    // SRP page: has a[href*="job-listings"] inside the card
    // Recommended page: no link — construct from jobId (Naukri redirects automatically)
    const titleLink = card.querySelector("a[href*='job-listings']");
    const url = titleLink?.href || `https://www.naukri.com/job-listings-${jobId}`;

    // ── Title ──
    // SRP: title link text / href
    // Recommended: p.title[title] attribute
    let title = "";
    if (titleLink) {
      title = titleLink.textContent.trim() || titleLink.getAttribute("title") || "";
    }
    if (!title) {
      // Recommended jobs page uses <p class="title" title="...">
      const titleEl = card.querySelector("p.title, [class*='title'][title]");
      title = titleEl?.getAttribute("title") || titleEl?.textContent?.trim() || "";
    }
    // Reject non-titles
    if (!title || title.match(/^\d/) || title.toLowerCase().includes("review") || title.length < 4) return null;

    // ── Company ──
    let company = "Unknown Company";
    const compSelectors = [
      "a.comp-name", "[class*='comp-name'] a", "a[class*='compName']",
      "[class*='company-name'] a", "[class*='companyName'] a",
      // Recommended page: span.subTitle[title]
      "span.subTitle[title]", "[class*='subTitle'][title]",
    ];
    for (const sel of compSelectors) {
      const el = card.querySelector(sel);
      if (el) {
        const t = el.getAttribute("title") || el.textContent.trim();
        if (t && !t.match(/^\d/) && !t.toLowerCase().includes("review")) { company = t; break; }
      }
    }

    return { jobId, title, company, url };
  }

  async function runListingMode(settings, profile) {
    console.log("[NaukriBot] LISTING MODE:", location.href);

    // If queue already has items, resume — but first check we're not stuck
    const existingQueue = await getQueue();
    if (existingQueue.length > 0) {
      const topJob = existingQueue[0];
      const currentUrl = location.href;

      // Stuck detection: if we're already on queue[0]'s page (or an expired version of it)
      // it means detail mode failed to process it — skip it and move on
      const onTopJobPage = currentUrl.includes(topJob.jobId) ||
                           currentUrl.includes("job-listings-");
      const isExpired = isExpiredJobPage();

      if (onTopJobPage || isExpired) {
        if (isExpired) {
          console.warn(`[NaukriBot] Expired page detected in listing mode, skipping: ${topJob.title}`);
          await appendLog({ ...topJob, status: "skipped", reason: "Job expired", time: new Date().toISOString() });
          await incrementStat("skipped");
        } else {
          console.warn(`[NaukriBot] Stuck on queue[0] page, skipping: ${topJob.title}`);
          await appendLog({ ...topJob, status: "failed", reason: "Stuck — skipped", time: new Date().toISOString() });
          await incrementStat("failed");
        }
        const next = existingQueue.slice(1);
        await setQueue(next);
        if (next.length === 0) {
          showToast("All jobs done!");
          await localSet({ botRunning: false });
          return;
        }
        showToast(`Skipped expired. Next: ${next[0].title}`);
        await delay(1, 2);
        location.href = next[0].url;
        return;
      }

      // Normal resume — we're on the listing page with jobs queued
      console.log(`[NaukriBot] Resuming existing queue (${existingQueue.length} jobs)`);
      showToast(`Resuming — ${existingQueue.length} jobs in queue`);
      await delay(1, 2);
      location.href = topJob.url;
      return;
    }

    showToast("Scanning job cards...");
    await delay(1, 2);

    const appliedIds = await getAppliedIds();
    const jobs = [];

    // Both SRP (div[data-job-id]) and recommended (article[data-job-id]) pages
    const cards = document.querySelectorAll('[data-job-id]');
    console.log(`[NaukriBot] Found ${cards.length} cards with data-job-id`);

    cards.forEach(card => {
      const job = extractJobFromCard(card, appliedIds, settings);
      if (!job) return;
      jobs.push(job);
      console.log(`[NaukriBot] Queued: "${job.title}" @ "${job.company}"`);
    });

    if (jobs.length === 0) {
      showToast("No new jobs found on this page", "warn");
      await localSet({ botRunning: false });
      return;
    }

    await setQueue(jobs);
    await localSet({ listingPageUrl: location.href });
    showToast(`Queued ${jobs.length} jobs. Starting...`);
    await delay(1, 2);
    location.href = jobs[0].url;
  }

  // ── DETAIL MODE ────────────────────────────────────────────

  async function runDetailMode(settings, profile) {
    console.log("[NaukriBot] DETAIL MODE:", location.href);

    const queue = await getQueue();
    if (queue.length === 0) {
      showToast("All jobs done!");
      await localSet({ botRunning: false });
      const d = await localGet("listingPageUrl");
      if (d.listingPageUrl) { await delay(2, 3); location.href = d.listingPageUrl; }
      return;
    }

    const currentJob = queue[0];
    const remaining = queue.slice(1);

    // ── Guard: make sure we're on this job's page ──
    // Skip this guard entirely if it's an expired redirect — let the expired check handle it
    const currentUrl = location.href.split("?")[0];
    const expectedUrl = currentJob.url.split("?")[0];
    const onExpiredRedirect = location.search.includes("expJD=true") || isExpiredJobPage();

    if (!onExpiredRedirect &&
        !currentUrl.includes(currentJob.jobId) &&
        !currentUrl.includes(expectedUrl)) {
      console.warn(`[NaukriBot] URL mismatch. Expected job ${currentJob.jobId}, got ${location.href}`);
      location.href = currentJob.url;
      return;
    }

    await delay(1.5, 2.5);
    showToast(`Processing: ${currentJob.title} (${remaining.length} remaining)`);

    const result = { jobId: currentJob.jobId, title: currentJob.title, company: currentJob.company, status: "failed", reason: "" };

    try {
      // ── Instant already-applied check (no waiting needed) ──
      if (settings.skipAlreadyApplied && isAlreadyApplied()) {
        result.status = "skipped";
        result.reason = "Already applied";
        showToast(`Skipped (already applied): ${currentJob.title}`, "warn");
        console.log(`[NaukriBot] Already applied: ${currentJob.title}`);
        await appendLog(result);
        await incrementStat("skipped");
        await setQueue(remaining);
        await navigateNext(remaining, settings);
        return;
      }

      // ── Expired job check — wait for React to render first ──
      await delay(1.5, 2.5);
      if (isExpiredJobPage()) {
        result.status = "skipped";
        result.reason = "Job expired";
        showToast(`Skipped (expired): ${currentJob.title}`, "warn");
        console.log(`[NaukriBot] Expired: ${currentJob.title}`);
        await appendLog(result);
        await incrementStat("skipped");
        await setQueue(remaining);
        await navigateNext(remaining, settings);
        return;
      }

      // ── Keyword filter ──
      // If keywords are configured, skip job if none appear in the page text
      const keywords = settings.keywords || [];
      if (keywords.length > 0) {
        const jdText = document.body.innerText.toLowerCase();
        const matched = keywords.some(kw => jdText.includes(kw));
        if (!matched) {
          result.status = "skipped";
          result.reason = `No keyword match (${keywords.slice(0,3).join(", ")})`;
          showToast(`Skipped (no keyword): ${currentJob.title}`, "warn");
          console.log(`[NaukriBot] No keyword match for: ${currentJob.title}`);
          await appendLog(result);
          await incrementStat("skipped");
          await setQueue(remaining);
          await navigateNext(remaining, settings);
          return;
        }
        console.log(`[NaukriBot] Keyword matched in: ${currentJob.title}`);
      }

      // Find action button — wait up to 10s for page to render
      let applyBtn = null;
      let interestBtn = null;

      for (let i = 0; i < 8; i++) {
        applyBtn = findApplyBtn();
        interestBtn = !applyBtn ? findInterestBtn() : null;
        if (applyBtn || interestBtn) break;
        console.log(`[NaukriBot] Waiting for button (${i+1}/8)...`);
        await delay(1, 1.5);
      }

      const actionBtn = applyBtn || interestBtn;
      const isInterest = !applyBtn && !!interestBtn;

      if (!actionBtn) {
        result.reason = "No apply or interest button found";

      } else if (!isInterest && settings.skipExternal && isExternalBtn(actionBtn)) {
        // ── Instant external skip ──
        result.status = "skipped";
        result.reason = "External apply site";
        showToast(`Skipped (external): ${currentJob.title}`, "warn");
        console.log(`[NaukriBot] External: ${currentJob.title}`);

      } else if (isInterest) {
        // ── Interest button — just click it, no form ──
        await delay(0.3, 0.8);
        actionBtn.click();
        result.status = "applied";
        result.reason = "Clicked interest button";
        showToast(`✓ Interest shown: ${currentJob.title}`);
        console.log(`[NaukriBot] Clicked interest: "${actionBtn.textContent.trim()}"`);
        await delay(1, 2); // let the click register

      } else {
        // ── Standard Apply flow ──
        await delay(0.5, 1);
        actionBtn.click();
        showToast(`Opened form: ${currentJob.title}`);
        console.log("[NaukriBot] Clicked Apply");

        // Wait for chatbot drawer OR regular modal
        const formHit = await waitForAny([
          ".chatbot_Drawer",
          "[class*='chatbot_Drawer']",
          '[role="dialog"]',
          ".apply-modal", "[class*='applyModal']",
          "form.apply-form", "[class*='apply-form']",
        ], 12000);

        if (!formHit) {
          result.reason = "Apply form did not appear";
        } else {
          console.log(`[NaukriBot] Form appeared: "${formHit.sel}"`);
          await delay(1, 2);

          const isChatbot = formHit.sel.includes("chatbot") || !!document.querySelector(".chatbot_Drawer");

          if (isChatbot) {
            console.log("[NaukriBot] Using chatbot solver");
            const chatResult = await solveChatbot(profile, settings);
            result.status = chatResult.status;
            result.reason = chatResult.reason;
            if (chatResult.unknownQuestions?.length) {
              result.reason += ` | Unknown: ${chatResult.unknownQuestions.slice(0,2).join(", ")}`;
            }
            showToast(`${result.status === "applied" ? "✓ Applied" : "Chatbot done"}: ${currentJob.title}`);
          } else {
            console.log("[NaukriBot] Using regular form filler");
            const { filled, unknown } = await fillRegularForm(formHit.el, profile);
            console.log(`[NaukriBot] Filled: ${filled}, Unknown: [${unknown.join(", ")}]`);

            if (settings.autoSubmit) {
              const submitBtn =
                formHit.el.querySelector('button[type="submit"],input[type="submit"]') ||
                formHit.el.querySelector('[class*="submit"i]') ||
                [...formHit.el.querySelectorAll("button")].find(b =>
                  ["submit","done","confirm","apply"].includes(b.textContent.trim().toLowerCase())
                );
              if (submitBtn && !submitBtn.disabled) {
                await delay(0.8, 1.5);
                submitBtn.click();
                await delay(2, 3);
                result.status = "submitted";
                result.reason = `Filled ${filled} fields`;
                showToast(`Submitted: ${currentJob.title}`);
              } else {
                result.status = "form_filled";
                result.reason = `Filled ${filled} fields (no submit btn)`;
              }
            } else {
              result.status = "form_filled";
              result.reason = `Filled ${filled} fields, auto-submit off`;
            }
          }
        }
      }
    } catch (err) {
      result.status = "failed";
      result.reason = err.message;
      console.error("[NaukriBot] Error:", err);
    }

    // Log + stats
    await appendLog(result);
    if (["applied","submitted","form_filled","chatbot_done"].includes(result.status)) {
      await markApplied(currentJob.jobId);
      await incrementStat("applied");
    } else if (result.status === "skipped") {
      await incrementStat("skipped");
    } else {
      await incrementStat("failed");
    }

    await setQueue(remaining);
    console.log(`[NaukriBot] Done: ${currentJob.title} [${result.status}]. Remaining: ${remaining.length}`);
    await navigateNext(remaining, settings);
  }

  async function navigateNext(remaining, settings) {
    if (remaining.length === 0) {
      showToast("✓ All jobs processed!");
      // Set botRunning false BEFORE navigating back — prevents listing page from re-scanning
      await localSet({ botRunning: false });
      await delay(2, 3);
      const d = await localGet("listingPageUrl");
      if (d.listingPageUrl) location.href = d.listingPageUrl;
      return;
    }
    const min = settings.delayMin || 5;
    const max = settings.delayMax || 15;
    showToast(`Next job in ~${min}s... (${remaining.length} left)`);
    await delay(min, max);
    console.log(`[NaukriBot] → ${remaining[0].url}`);
    location.href = remaining[0].url;
  }

  // ── BOOT ───────────────────────────────────────────────────

  const DEFAULT_SETTINGS = {
    autoSubmit: true, pauseOnUnknown: false,
    humanDelay: true, delayMin: 5, delayMax: 15,
    skipExternal: true, skipAlreadyApplied: true,
  };

  async function boot() {
    const syncData = await syncGet(["profile", "settings"]);
    const profile  = syncData.profile  || {};
    const settings = { ...DEFAULT_SETTINGS, ...(syncData.settings || {}) };

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "BOT_START") startBot(settings, profile);
      if (msg.type === "BOT_STOP")  stopBot();
      if (msg.type === "SETTINGS_UPDATED") {
        if (msg.settings) Object.assign(settings, msg.settings);
        if (msg.profile)  Object.assign(profile, msg.profile);
      }
    });

    const running = await isRunning();
    if (running) { await startBot(settings, profile); }
    else { console.log("[NaukriBot] Ready."); }
  }

  async function startBot(settings, profile) {
    await localSet({ botRunning: true });
    showToast("Bot started");
    const detailPage = await isDetailPage();
    if (detailPage) await runDetailMode(settings, profile);
    else await runListingMode(settings, profile);
  }

  async function stopBot() {
    await localSet({ botRunning: false, botQueue: [] });
    showToast("Bot stopped");
  }

  window.naukriBotStart = startBot;
  window.naukriBotStop  = stopBot;
  window.naukriBotDebug = async () => {
    const q = await getQueue();
    const detailPage = await isDetailPage();
    console.group("[NaukriBot] Debug");
    console.log("Page:", detailPage ? "DETAIL" : "LISTING");
    console.log("Running:", await isRunning());
    console.log("Queue:", q.length, q.slice(0,3));
    console.log("Chatbot open:", !!document.querySelector(".chatbot_Drawer"));
    console.log("Apply btn:", findApplyBtn()?.textContent?.trim() || "none");
    console.groupEnd();
  };

  await boot();
  console.log("[NaukriBot] Loaded. naukriBotDebug() | naukriBotStop()");

})();
