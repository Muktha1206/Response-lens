# Response Lens — Standalone

A QA coaching tool for Kapture CX support replies. This version runs as an
ordinary website — no Claude.ai account needed for anyone using it. It uses
Google's Gemini API (free tier, no credit card) and a place to run Node.js.

## What this is

- `server.js` — a small Node/Express server. It serves the frontend, calls
  the Gemini API on the agent's behalf (so the API key never reaches the
  browser), and stores every run + feedback comment in local JSON files.
- `public/index.html` — the frontend. Single file, no build step.
- `data/` — created automatically on first run. Holds `runs.json` (the
  shared log) and `tool_feedback.json` (admin-flagged tool feedback).

## Setup

1. Install [Node.js](https://nodejs.org) 18 or newer on the machine/server
   that will host this.
2. Get a free Gemini API key (no credit card needed) at
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — sign
   in with any Google account and click "Create API key."
3. In this folder, run:
   ```
   npm install
   ```
4. Copy `.env.example` to `.env` and fill in your real Gemini API key:
   ```
   cp .env.example .env
   ```
   Then edit `.env` and set `GEMINI_API_KEY=...` with the key from step 2.
5. Start the server:
   ```
   npm start
   ```
6. Open `http://localhost:3000` in a browser. For other people to use it,
   host this on a server reachable on your network (or the internet) and
   share that address instead of `localhost`.

## How data is stored

Everything lives in flat JSON files under `data/`:

- `runs.json` — every ticket scored, by every agent: the full scorecard,
  verdict, risk level, fatal flag, probing note, resolution reply, coaching
  tips, and any feedback comment.
- `tool_feedback.json` — comments specifically flagged as being about the
  tool itself (scoring, parameters, prompt) rather than one ticket.

This is intentionally simple for a small pilot (a handful of agents, two
weeks). It is **not** meant to be the final architecture for a large-scale
rollout — see "Before a wider rollout" below.

## Identity / roles

The "sign in" screen just asks for an email and Agent/Manager, and remembers
it in the browser's local storage. It is **not real authentication** — there
is no password, and anyone can select "Manager" to see the Analytics view.
Treat it as a convenience toggle, not access control.

## Downloading the shared log

As a Manager, the Analytics panel has a "Download CSV — full shared log"
button. This exports every row in `runs.json` as one spreadsheet, with one
row per ticket.

## Before a wider rollout

This setup is fine for a small, trusted pilot. Before opening it up more
broadly, consider:

- **Real authentication** — the current email/role selector doesn't verify
  anything. Anyone with the link can act as a Manager.
- **A real database** instead of JSON files — flat files work for low
  volume but will get slow and are at risk of write conflicts if many
  agents submit at the exact same moment.
- **HTTPS** — if this is reachable outside your internal network, put it
  behind HTTPS (e.g. via a reverse proxy like nginx, or a hosting platform
  that provides TLS automatically).
- **Backups** — the `data/` folder is the only copy of your QA history.
  Back it up like you would any other database.
- **Rate limiting / usage awareness** — Gemini's free tier has daily/per-minute
  limits. Fine for a small pilot; if you outgrow it, Google's paid tier is
  pay-per-token, not a flat fee.

## Customizing the scoring prompt

The QA scoring prompt lives in `server.js` as the `SYSTEM_PROMPT` constant.
Edit it there if your QA parameters change — no frontend changes needed.
