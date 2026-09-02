# Why Is This Pumping?

Paste a Solana contract address, get an evidence-labelled research report on why it's moving.

A small personal project: one page, one input, one report. Next.js 16 + TypeScript, no database.

---

## Quick start

```bash
npm install
cp .env.example .env.local     # every value is optional to start
npm run dev
```

Open http://localhost:3000. With no Base44 credentials set it runs on realistic
sample data, so the whole app works immediately.

## Environment

Five variables, all optional:

| Variable | Default | What it does |
| --- | --- | --- |
| `ACCESS_CODE` | *(blank)* | Blank means the app is open. Set it to require a passphrase. |
| `SESSION_SECRET` | *(blank)* | Signs the access cookie. Required only when `ACCESS_CODE` is set. |
| `BASE44_SUPERAGENT_BASE_URL` | *(blank)* | Your Superagent endpoint. |
| `BASE44_SUPERAGENT_API_KEY` | *(blank)* | Your API key. Server-side only. |
| `ANALYSIS_ENABLED` | `true` | Set `false` to stop all analyses instantly. |

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Tuning

| Variable | Default | |
| --- | --- | --- |
| `COOLDOWN_SECONDS` | `20` | Minimum gap between analyses. |
| `MAX_ANALYSES_PER_DAY` | `50` | Hard daily ceiling on upstream calls. |
| `CACHE_TTL_SECONDS` | `300` | Reuse a report for the same address for this long. |
| `PARTIAL_AFTER_SECONDS` | `0` | Optional deadline. `0` means none: wait for the real report. |
| `BASE44_TIMEOUT_MS` | `0` | Wait budget in ms. `0` means no limit: wait until the agent answers. |
| `BASE44_MAX_RETRIES` | `2` | Retries for transient failures only. |
| `BASE44_FORCE_MOCK` | `false` | Force sample data even with credentials set. |
| `MOCK_DELAY_MS` | `2600` | Simulated research time in mock mode. |

## Connecting Base44

Set `BASE44_SUPERAGENT_BASE_URL` and `BASE44_SUPERAGENT_API_KEY`, restart, and the
"Sample data" badge disappears.

Superagents are **conversational**, not request/response. The adapter in
[`src/lib/base44/live.ts`](src/lib/base44/live.ts) implements the verified flow:

```
POST {BASE_URL}/conversations                 -> { "id": "..." }
POST {BASE_URL}/conversations/{id}/messages   -> { "role": "user", "content": "..." }
GET  {BASE_URL}/conversations/{id}            -> { "messages": [...] }   (polled)
```

- `BASE_URL` is the "Base URL" from your Superagent's **Developer** panel, e.g.
  `https://<your-app>.base44.com/api/agents/<agentId>`. Use it exactly as shown —
  do not append a path.
- Auth is a plain `api_key: <key>` header. `Authorization: Bearer` returns 401.
- `role` must be the literal string `"user"`.

### What gets sent

**Only the contract address.** Nothing else — no schema, no research rules, no
formatting instructions. The Superagent already holds its own configuration, and
restating it per request is pure added latency for work the agent was going to do
anyway.

This was a real bug. The adapter used to send 19 lines of JSON-schema
instructions with every request, which is why the website felt slower than typing
a CA into the Base44 chat: the chat sends one line, the website was sending a
blueprint.

### What comes back

The agent narrates as it works, then delivers the report:

```
assistant  Validating the exact mint, selecting the primary pool...
assistant  Pulling the point-in-time market snapshot...
   ... several more research steps ...
assistant  ```json { "answer": ... }        <- the report
```

Those narration lines are streamed to the browser and shown live, so you watch
the agent think instead of staring at a spinner. The run ends when a message
parses into a report; unparseable messages mean it is still working.

**A full run takes about 4-5 minutes.** There is no deadline: the app waits for
the real report. Setting `PARTIAL_AFTER_SECONDS` adds one, after which whatever
the agent established is rendered and labelled partial. Partial reports are
never cached.

### Latency instrumentation

Every run logs a structured breakdown, so a slow analysis can be attributed to
Base44 or to the website without guessing:

```json
{"event":"analysis_completed","ca_received_at":"...","base44_request_sent_at":"...",
 "base44_message_id":"...","base44_completed_at":"...",
 "queueMs":12,"base44Ms":257000,"totalMs":257012}
```

`queueMs` is time spent inside the website before the request went out;
`base44Ms` is time spent waiting on the agent. A `website_rendered` line adds
`website_rendered_at` and the handoff delay.

### Webhook (optional)

Polling every 4s already finishes every run. Setting `BASE44_WEBHOOK_SECRET` and
pointing the Superagent Developer panel at `/api/webhooks/base44` only removes
the few seconds between the agent finishing and the next poll noticing. The
endpoint verifies the HMAC, rejects replayed event ids, and is strictly advisory:
it nudges the poller, never supplies a result.

Two escape hatches if your deployment differs:

```bash
BASE44_MESSAGE_PATH=/messages          # segment after /conversations/{id}
BASE44_AUTH_HEADER=authorization       # with BASE44_AUTH_SCHEME=Bearer
```

## How it works

```
browser  ->  /api/analyze  ->  spend guard  ->  Base44 adapter  ->  Superagent
                  |
             in-memory job  <-  /api/analyze/:id  (polled)
```

- **The browser never touches Base44.** The key is read only in `live.ts`, on the server.
- Jobs live in a `Map`. They're short-lived; a restart losing them costs nothing.
- Reports for the same address are cached for 15 minutes, so a repeat costs nothing.
- Report content is untrusted: it's schema-validated, stripped of markup and control
  characters, and rendered as React elements — never as an HTML string. Only `http(s)`
  links survive.

## Commands

```bash
npm run dev        # development
npm run build      # production build
npm start          # serve the build
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run verify     # typecheck + test + build
```

## Deploying

Works on Vercel with no configuration. Push, import the repo, add whichever
environment variables you want, deploy.

Two notes for a serverless deployment:

- Jobs are per-instance. With multiple instances a poll can land on an instance that
  doesn't know the job. For a handful of users on a Vercel Hobby project this is fine;
  if it becomes a problem, the fix is a shared store (Redis/KV) behind
  `src/lib/jobs/store.ts`.
- `MAX_ANALYSES_PER_DAY` is also per-instance, so treat it as a soft ceiling.
- The analyze endpoint returns as soon as it creates the in-memory job and uses
  Vercel Hobby's supported `maxDuration = 300`. The Base44 conversation then
  continues in that instance while the browser polls the job. For dependable
  multi-minute work on serverless, move the job behind a durable queue/worker;
  `npm start`, a VPS, or a container can keep the current in-process model alive.

## Operations

**Stop all analyses:** set `ANALYSIS_ENABLED=false` and redeploy. Refused before any
upstream call.

**Rotate the API key:** replace `BASE44_SUPERAGENT_API_KEY` and redeploy. No code change.

**Diagnose a failure:** the UI shows a safe failure code (`auth_failed`, `timeout`,
`malformed_response`, …). The real reason, with secrets redacted, is one line in the
server log:

```json
{"level":"warn","event":"analysis_failed","code":"auth_failed","detail":"…"}
```

## Security notes

Kept deliberately, because they're cheap and the alternative is worse:

- The Base44 key is server-side only. There is no `NEXT_PUBLIC_` variable carrying it,
  and secrets are redacted from every log line and error path.
- Addresses are validated as real Base58/32-byte Solana keys before anything runs.
  URLs, prompt text and other chains are rejected.
- Report output is treated as hostile input. Scripts, event handlers, `javascript:`
  and `data:` URLs cannot render.
- The access cookie stores an HMAC, not your passphrase. Rotating `ACCESS_CODE`
  invalidates every existing cookie.

If you deploy publicly, use a long `ACCESS_CODE`. It is the only thing between the
open internet and your paid API key.
