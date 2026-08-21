// Response Lens — standalone backend
//
// This server does three things:
//  1. Serves the frontend (public/index.html)
//  2. Proxies scoring requests to the Gemini API, keeping the API key on
//     the server so it's never exposed to the browser
//  3. Stores every run + feedback comment in local JSON files, acting as the
//     "shared log" that all agents' browsers read from and write to
//
// Setup:
//   1. npm install
//   2. Copy .env.example to .env and fill in your GEMINI_API_KEY
//      (get a free key at https://aistudio.google.com/apikey — no card needed)
//   3. npm start
//   4. Open http://localhost:3000 (or your server's address) in a browser
//
// This is intentionally simple (flat JSON files, no auth) so it's easy to
// stand up for a small pilot. See README.md for notes on hardening it
// before a wider rollout.

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const API_KEY = process.env.GEMINI_API_KEY;

const DATA_DIR = path.join(__dirname, 'data');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const TOOL_FEEDBACK_FILE = path.join(DATA_DIR, 'tool_feedback.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RUNS_FILE)) fs.writeFileSync(RUNS_FILE, '[]');
if (!fs.existsSync(TOOL_FEEDBACK_FILE)) fs.writeFileSync(TOOL_FEEDBACK_FILE, '[]');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const SYSTEM_PROMPT = `You are Response Lens, a coaching engine for Kapture CX support agents. Kapture CX sells a customer-support SaaS platform; agents reply to client tickets about configuration, access, bugs, billing, feature requests, and how-to questions.

You receive only two things: the customer's message and the agent's draft reply. You do NOT receive a ticket type — infer it yourself from context, silently, and use it to calibrate your judgment. Do not mention that you inferred it unless it changes your verdict in a way the agent needs to know.

Be terse everywhere. Agents read this in seconds between tickets. No sentence should run past ~15 words. No preamble anywhere in the JSON values.

STEP 1 — SILENTLY ASSESS RISK LEVEL
Decide if this ticket carries escalation / Critical Care risk: repeat-contact language ("second time," "again"), strong frustration or churn language, business-impact statements (missed SLAs, financial loss, team-wide disruption), or a direct threat to the relationship. If risk is present, apply a stricter bar on tone, ownership, and evidence.

STEP 2 — FATAL FLAW CHECK (run first, always)
Flag as FATAL if the draft:
- Blames the customer or their team
- Is factually evasive or dodges the actual question asked
- Is defensive, dismissive, or has a tone that could inflame a frustrated client
- Fails to acknowledge a clearly stated business impact
- Gives no next step at all on a ticket that needs one
If any fatal flag is present, verdict cannot be "Strong," and the fatal issue is the first thing named in the summary.

STEP 3 — SCORECARD (mirrors Kapture's live Email QA form — assessable subset only)
Score only these 10 parameters, each against what's visible in the customer message + draft reply. Do not attempt to score anything requiring ticket history, timestamps, JIRA status, or meeting records — that's out of scope for this tool.

Rate each "pass" (full weight), "partial" (half weight, rounded down), or "gap" (0). Be fair, not harsh — you're coaching a working agent, not grading an exam. When torn, pick the more generous rating.

1. Greeting (wt 4)
2. Paraphrase + action-oriented acknowledgement (wt 8)
3. Offered further assistance (wt 4)
4. Writing quality — no spelling/grammar errors (wt 5)
5. Professional, empathetic tone — apply the stricter bar if Step 1 flagged escalation risk (wt 5)
6. Referenced history/attachments before responding, where the customer's message implies there should be some (wt 7)
7. Right troubleshooting approach evident in the reply (wt 10)
8. Resolution analysis — cause clearly articulated (wt 5)
9. Clear work instructions/attachments referenced in the reply itself (wt 10)
10. ETA provided for next update, where the ticket isn't fully resolved (wt 7)

Sum scored points out of 65.

STEP 4 — PROBING + RESOLUTION REPLY
Split the ideal reply into two parts:
- "probing": if the draft resolved without checking something it should have (prior config, error logs, account state, repro steps), write the 1-2 questions or checks the agent should have done FIRST, in plain language. If nothing needs probing, set this to the literal string "Not needed — issue was clear enough to resolve directly."
- "resolution": the client-ready reply, plain business language, 130 words or fewer, with:
  - "greeting": "Hi [Name]," — use the literal placeholder [Name] since the agent will fill in the client's actual name.
  - "empathy": one short line acknowledging the inconvenience or impact, e.g. "We understand this is holding up your reporting." Keep it genuine, not generic — tie it to what the customer actually said. Skip only if the message carries no frustration or impact at all, and in that case set this to an empty string.
  - "opening": one line directly answering the client's core question or key finding.
  - "body": 1-3 short plain-language points with evidence/explanation. Use [square-bracket placeholders] where the draft lacks specifics.
  - "decision": the concrete choice or next step offered to the client.
  - "signoff": one short, warm closing line.

STEP 5 — COACHING POINTERS
2-3 tips, each ≤10 words, imperative + one clause of why. The FIRST tip must be the single most important fix — the "biggest win." Example: "Add ETA — client doesn't know when to expect an update." No jargon.

Respond with ONLY a JSON object. No preamble, no markdown fences:
{
  "verdict": "Strong" | "Needs work" | "Off track",
  "fatalFlag": { "present": true|false, "reason": "<max 15 words, or empty string>" },
  "riskLevel": "Standard" | "Escalation risk",
  "summary": "<one plain sentence, max 20 words>",
  "scorecard": {
    "totalScore": "<sum>/65",
    "parameters": [
      {"name":"Greeting","weight":4,"status":"pass"|"partial"|"gap"},
      {"name":"Paraphrase + action-oriented ack","weight":8,"status":"pass"|"partial"|"gap"},
      {"name":"Offered further assistance","weight":4,"status":"pass"|"partial"|"gap"},
      {"name":"Writing quality","weight":5,"status":"pass"|"partial"|"gap"},
      {"name":"Tone & empathy","weight":5,"status":"pass"|"partial"|"gap"},
      {"name":"Referenced history/attachments","weight":7,"status":"pass"|"partial"|"gap"},
      {"name":"Right troubleshooting","weight":10,"status":"pass"|"partial"|"gap"},
      {"name":"Resolution analysis articulated","weight":5,"status":"pass"|"partial"|"gap"},
      {"name":"Clear work instructions/attachments","weight":10,"status":"pass"|"partial"|"gap"},
      {"name":"ETA provided","weight":7,"status":"pass"|"partial"|"gap"}
    ],
    "notScored": "35 pts not assessable from a single reply: disposition tagging, follow-up cadence, escalation history, handoffs, and JIRA/meeting/MoM fatals. Track in full AQM audit."
  },
  "response": {
    "probing": "<1-2 questions/checks, or 'Not needed — issue was clear enough to resolve directly.'>",
    "resolution": {
      "greeting": "Hi [Name],",
      "empathy": "<one short empathy line, or empty string if not needed>",
      "opening": "<direct answer / key finding>",
      "body": ["<short plain point>"],
      "decision": "<the choice or next step you offer the client>",
      "signoff": "<short closing line>"
    }
  },
  "pointers": ["<biggest win tip, max 10 words>", "<tip, max 10 words>"]
}`;

// ---- POST /api/score — proxy to Gemini, key never leaves the server ----
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(userContent) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000); // don't hang forever

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: {
          maxOutputTokens: 2048,
          responseMimeType: 'application/json'
        }
      })
    });
  } catch (fetchErr) {
    const err = new Error(
      fetchErr.name === 'AbortError'
        ? 'The request took too long and timed out.'
        : 'Could not reach Gemini: ' + fetchErr.message
    );
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error('Gemini API error: ' + errText);
    err.status = response.status;
    err.raw = errText;
    if (response.status === 404) {
      err.friendly = `The model "${MODEL}" was not found or is no longer available. ` +
        `Check the GEMINI_MODEL setting in your environment variables — Google occasionally ` +
        `retires model names, and the error from Gemini usually names the replacement to use.`;
    }
    throw err;
  }

  const data = await response.json();

  // Content can be withheld by Gemini's safety filters — this is not transient,
  // so don't waste retries on it; tell the agent plainly instead.
  const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
  if (blockReason) {
    const err = new Error(
      `This message was withheld by Gemini's safety filters (${blockReason}). ` +
      `Try rephrasing the customer message or draft reply.`
    );
    err.friendly = err.message;
    throw err;
  }

  const candidate = data.candidates && data.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts &&
    candidate.content.parts[0] && candidate.content.parts[0].text;

  if (!text) {
    const err = new Error('No text response from model.');
    err.retryable = true;
    throw err;
  }

  const finishReason = candidate.finishReason;
  const clean = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');

  try {
    return JSON.parse(clean);
  } catch (parseErr) {
    const err = new Error(
      finishReason === 'MAX_TOKENS'
        ? 'The response was cut off before finishing.'
        : 'The response could not be read as valid JSON.'
    );
    err.retryable = true;
    throw err;
  }
}

function isRetryable(err) {
  if (err.friendly) return false; // explicit, non-transient — don't retry
  if (err.retryable) return true;
  if (err.status === 503 || err.status === 429) return true; // busy / rate-limited
  if (err.raw && /UNAVAILABLE|overloaded/i.test(err.raw)) return true;
  return false;
}

app.post('/api/score', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'Server is not configured with a GEMINI_API_KEY. See README.md.' });
  }
  const { customerMessage, draftReply } = req.body || {};
  if (!customerMessage || !draftReply) {
    return res.status(400).json({ error: 'customerMessage and draftReply are required.' });
  }

  const userContent = `CUSTOMER MESSAGE:\n${customerMessage}\n\nAGENT DRAFT REPLY:\n${draftReply}`;
  const MAX_ATTEMPTS = 3;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const parsed = await callGemini(userContent);
      return res.json(parsed);
    } catch (err) {
      lastErr = err;
      console.error(`[score attempt ${attempt}/${MAX_ATTEMPTS}] ` + err.message);
      if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
        await sleep(attempt * 1000); // 1s, then 2s
        continue;
      }
      break;
    }
  }

  const friendly = lastErr.friendly
    || (isRetryable(lastErr)
      ? 'Gemini is busy right now. Please try Submit again in a moment.'
      : 'Could not score this reply: ' + lastErr.message);
  res.status(503).json({ error: friendly });
});

// ---- Runs (the shared log) ----
app.post('/api/runs', (req, res) => {
  const runs = readJSON(RUNS_FILE);
  const id = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const row = { id, ...req.body, timestamp: new Date().toISOString() };
  runs.push(row);
  writeJSON(RUNS_FILE, runs);
  res.json(row);
});

app.get('/api/runs', (req, res) => {
  res.json(readJSON(RUNS_FILE));
});

app.patch('/api/runs/:id', (req, res) => {
  const runs = readJSON(RUNS_FILE);
  const idx = runs.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Run not found.' });
  runs[idx] = { ...runs[idx], ...req.body };
  writeJSON(RUNS_FILE, runs);
  res.json(runs[idx]);
});

// ---- Tool-level feedback (admin-review list) ----
app.post('/api/tool-feedback', (req, res) => {
  const items = readJSON(TOOL_FEEDBACK_FILE);
  const id = 'tf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const row = { id, ...req.body, timestamp: new Date().toISOString() };
  items.push(row);
  writeJSON(TOOL_FEEDBACK_FILE, items);
  res.json(row);
});

app.get('/api/tool-feedback', (req, res) => {
  res.json(readJSON(TOOL_FEEDBACK_FILE));
});

// ---- Safety nets: keep serving everyone else even if one request misbehaves ----
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (server stays up):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stays up):', err);
});

app.listen(PORT, () => {
  console.log(`Response Lens server running at http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY is not set. Scoring requests will fail until you add it to .env.');
  }
});
