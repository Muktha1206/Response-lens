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
const API_KEY = process.env.GEMINI_API_KEY;

// If GEMINI_MODEL is set, try it first. Either way, fall back through this list
// automatically if a model name turns out to be wrong/retired (404) — this is
// how Response Lens survives Google renaming/retiring models without needing
// a manual fix each time.
//
// Note: Google has been retiring specific model IDs for *new accounts* even
// while those same IDs still show up in the "list models" API — so a model
// can look available and still 404 on an actual generation call. "-latest"
// style aliases are the most resilient since Google keeps them pointed at
// whatever's current, rather than a fixed version number that can expire.
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-2.5-flash'
].filter(Boolean);

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

// ---- Storage layer ----
// If SUPABASE_URL and SUPABASE_KEY are set, use Supabase (survives restarts —
// use this for anything beyond a same-day test). Otherwise fall back to local
// JSON files, which are wiped whenever Render's free tier restarts the server.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);

async function supabaseRequest(pathAndQuery, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error (${res.status}): ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function newId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function storageSaveRun(row) {
  const fullRow = { id: newId('run'), ...row, timestamp: new Date().toISOString() };
  if (USE_SUPABASE) {
    const inserted = await supabaseRequest('runs', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(fullRow)
    });
    return inserted[0];
  }
  const runs = readJSON(RUNS_FILE);
  runs.push(fullRow);
  writeJSON(RUNS_FILE, runs);
  return fullRow;
}

async function storageGetRuns() {
  if (USE_SUPABASE) {
    return supabaseRequest('runs?select=*&order=timestamp.asc');
  }
  return readJSON(RUNS_FILE);
}

async function storageUpdateRun(id, patch) {
  if (USE_SUPABASE) {
    const updated = await supabaseRequest(`runs?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(patch)
    });
    return (updated && updated[0]) || null;
  }
  const runs = readJSON(RUNS_FILE);
  const idx = runs.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  runs[idx] = { ...runs[idx], ...patch };
  writeJSON(RUNS_FILE, runs);
  return runs[idx];
}

async function storageSaveToolFeedback(row) {
  const fullRow = { id: newId('tf'), ...row, timestamp: new Date().toISOString() };
  if (USE_SUPABASE) {
    const inserted = await supabaseRequest('tool_feedback', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(fullRow)
    });
    return inserted[0];
  }
  const items = readJSON(TOOL_FEEDBACK_FILE);
  items.push(fullRow);
  writeJSON(TOOL_FEEDBACK_FILE, items);
  return fullRow;
}

async function storageGetToolFeedback() {
  if (USE_SUPABASE) {
    return supabaseRequest('tool_feedback?select=*&order=timestamp.asc');
  }
  return readJSON(TOOL_FEEDBACK_FILE);
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

async function callGemini(userContent, modelName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000); // don't hang forever

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_KEY
      },
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
    err.modelNotFound = response.status === 404;
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

let workingModel = null; // once we find a model that works, stick with it for future requests

app.post('/api/score', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'Server is not configured with a GEMINI_API_KEY. See README.md.' });
  }
  const { customerMessage, draftReply } = req.body || {};
  if (!customerMessage || !draftReply) {
    return res.status(400).json({ error: 'customerMessage and draftReply are required.' });
  }

  const userContent = `CUSTOMER MESSAGE:\n${customerMessage}\n\nAGENT DRAFT REPLY:\n${draftReply}`;
  const MAX_ATTEMPTS_PER_MODEL = 2; // fewer retries per model now that we cascade across several
  const modelsToTry = workingModel ? [workingModel, ...MODEL_CANDIDATES] : MODEL_CANDIDATES;
  let lastErr;

  for (const modelName of modelsToTry) {
    let moveToNextModel = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const parsed = await callGemini(userContent, modelName);
        workingModel = modelName; // remember what worked
        return res.json(parsed);
      } catch (err) {
        lastErr = err;
        console.error(`[score] model=${modelName} attempt=${attempt}/${MAX_ATTEMPTS_PER_MODEL}: ${err.message}`);

        if (err.friendly) {
          // Explicit, non-transient, not model-specific (e.g. safety block) — no
          // point trying other models, stop immediately.
          moveToNextModel = false;
          break;
        }
        if (attempt < MAX_ATTEMPTS_PER_MODEL && isRetryable(err) && !err.modelNotFound) {
          await sleep(attempt * 800); // brief pause before retrying the same model
          continue;
        }
        // Either "model not found" or we've used up retries on a busy/transient
        // error — either way, try the next model in the list instead of giving up.
        moveToNextModel = true;
        break;
      }
    }

    if (!moveToNextModel) break;
  }

  const friendly = lastErr.friendly
    || (lastErr.modelNotFound
      ? 'None of the configured Gemini models are available right now. Check GEMINI_MODEL and your API key.'
      : isRetryable(lastErr)
        ? 'All available Gemini models are busy right now. Please try Submit again in a moment.'
        : 'Could not score this reply: ' + lastErr.message);
  res.status(503).json({ error: friendly });
});

// ---- Runs (the shared log) ----
app.post('/api/runs', async (req, res) => {
  try {
    const row = await storageSaveRun(req.body);
    res.json(row);
  } catch (err) {
    console.error('Error saving run:', err.message);
    res.status(500).json({ error: 'Could not save this run: ' + err.message });
  }
});

app.get('/api/runs', async (req, res) => {
  try {
    const rows = await storageGetRuns();
    res.json(rows);
  } catch (err) {
    console.error('Error fetching runs:', err.message);
    res.status(500).json({ error: 'Could not load the shared log: ' + err.message });
  }
});

app.patch('/api/runs/:id', async (req, res) => {
  try {
    const updated = await storageUpdateRun(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Run not found.' });
    res.json(updated);
  } catch (err) {
    console.error('Error updating run:', err.message);
    res.status(500).json({ error: 'Could not save feedback: ' + err.message });
  }
});

// ---- Tool-level feedback (admin-review list) ----
app.post('/api/tool-feedback', async (req, res) => {
  try {
    const row = await storageSaveToolFeedback(req.body);
    res.json(row);
  } catch (err) {
    console.error('Error saving tool feedback:', err.message);
    res.status(500).json({ error: 'Could not save tool feedback: ' + err.message });
  }
});

app.get('/api/tool-feedback', async (req, res) => {
  try {
    const rows = await storageGetToolFeedback();
    res.json(rows);
  } catch (err) {
    console.error('Error fetching tool feedback:', err.message);
    res.status(500).json({ error: 'Could not load tool feedback: ' + err.message });
  }
});

// ---- Diagnostic: check what Gemini says about the real key on this server ----
// Visit /api/debug-gemini in a browser to see this. It never reveals the key
// itself — only whether Google accepts it and whether an actual scoring-style
// call succeeds.
app.get('/api/debug-gemini', async (req, res) => {
  if (!API_KEY) {
    return res.json({ ok: false, reason: 'No GEMINI_API_KEY is set on this server at all.' });
  }

  const result = {
    keyLooksLike: API_KEY.slice(0, 6) + '...' + API_KEY.slice(-4)
  };

  // Step 1: list models (cheap, low-stakes check)
  try {
    const listResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': API_KEY }
    });
    const listText = await listResponse.text();
    let listParsed;
    try { listParsed = JSON.parse(listText); } catch (e) { listParsed = listText; }

    if (!listResponse.ok) {
      result.listModelsCheck = { ok: false, httpStatus: listResponse.status, googleSaid: listParsed };
    } else {
      const modelNames = (listParsed.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace('models/', ''));
      result.listModelsCheck = { ok: true, modelsYourKeyCanUse: modelNames };
    }
  } catch (err) {
    result.listModelsCheck = { ok: false, reason: 'Could not reach Google: ' + err.message };
  }

  // Step 2: the REAL test — an actual generateContent call for every candidate
  // model, same as scoring uses. This is what actually matters, since listing
  // models can succeed even when generation itself fails for a given key.
  result.actualGenerateContentTests = [];
  for (const modelName of MODEL_CANDIDATES) {
    try {
      const genResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say the word OK.' }] }] })
        }
      );
      const genText = await genResponse.text();
      let genParsed;
      try { genParsed = JSON.parse(genText); } catch (e) { genParsed = genText; }

      result.actualGenerateContentTests.push({
        modelTried: modelName,
        httpStatus: genResponse.status,
        ok: genResponse.ok,
        googleSaid: genParsed
      });
    } catch (err) {
      result.actualGenerateContentTests.push({ modelTried: modelName, ok: false, reason: 'Network error: ' + err.message });
    }
  }

  res.json(result);
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
  console.log(USE_SUPABASE
    ? 'Storage: Supabase (persistent — survives restarts)'
    : 'Storage: local JSON files (WARNING: wiped on every restart/redeploy on Render free tier)');
  if (!API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY is not set. Scoring requests will fail until you add it to .env.');
  }
});
