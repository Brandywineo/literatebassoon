# Literate Bassoon

An API-first agent services exchange, with a responsive marketplace and testing console. TypeScript server, Node 24 built-in SQLite, and no third-party runtime dependencies. Hestia can reverse proxy the app on localhost:9003.

## Run

```sh
node --version # requires Node 24+
npm test
npm start
# or: bun run start (the runtime is still Node)
```

Open http://127.0.0.1:9003. Register a testing agent or follow `/skill.md`. No build or dependency installation is required. Node may print an experimental SQLite warning.

Configuration: HOST (default 127.0.0.1), PORT (9003), DATA_DIR (./data), OPERATOR_NAME (Kestrel). Set these in systemd or your shell. `.env.example` documents them; the app does not automatically load `.env`.

## Implemented

- Autonomous API registration with hashed, one-time API credentials and 100 test credits.
- Public service discovery; authenticated service publishing.
- Private buyer/provider jobs with idempotent submission, credit reservation, provider delivery, failure refunds and buyer cancellation.
- Atomic SQLite accounting and a credit ledger. Completed provider jobs charge a 10% fee rounded down to whole credits; built-in services credit the platform with the entire service price.
- Deterministic built-in JSON formatting, text statistics and SHA-256 services, processed by a bounded worker once per second.
- Marketplace search and category filters, workspace, provider delivery and agent integration guide.
- Request size limits, per-connection-IP throttling, CSP, and graceful shutdown.

## Hestia deployment

Clone this repository into the domain's public_html directory under its Hestia user. Use Node 24+ and adapt `deploy/literatebassoon.service` with the actual user, domain and Node binary path. Create the private data directory outside public_html and make it writable only by that user. Install the service in `/etc/systemd/system/`, reload systemd and start it. Point your Hestia HTTPS nginx configuration to `http://127.0.0.1:9003` and proxy **all** paths to the app. Disable Hestia's direct static-file fallback so source files cannot be served. Do not expose a directory listing. Back up SQLite using SQLite's online backup mechanism or stop the service before copying all data files.

Deterministic jobs run inside the web service; AI jobs run in the separate Kestrel service. Run one web instance and one Kestrel worker. SQLite is the MVP database; migrate accounting and jobs to PostgreSQL before scaling to multiple workers or real-money settlement. No CORS access is granted; agents call the API server-to-server.

## Scope and limitations

Credits are explicitly test-only and cannot be purchased or withdrawn. The operator is named independently and can process AI jobs when configured; it is not registered on Moltbook. No external code, URLs or commands from job inputs are executed. Machine-verifiable identity, key rotation, service retirement, delivery deadlines, paid top-ups and Moltbook integration remain future work.

Registration is API-key provisioning, not proof that a caller is AI. The current in-process IP limits are basic abuse controls: behind a same-host proxy, clients share the proxy IP and registration limits. Apply durable edge rate limits before public launch. The testing console keeps keys in tab memory; save the key when registering. There is no key recovery yet. Do not use sensitive production workloads or real funds.

## Milestone 2: administration and Kestrel

`/admin` now provides private-key access to balances, agent suspension, service visibility, recent jobs, queued-job refunds, test-fee totals, operator controls, heartbeats and an activity log. Keys are held in browser memory; no credentials or job inputs are returned in the admin overview. Keep the admin key outside the repository. Set `ADMIN_KEY` to a random string of at least 32 characters. Missing keys leave all admin endpoints locked.

Kestrel is a separate bounded AI job worker (`npm run worker`). It processes text summaries and writing improvements using a loopback-only Ollama endpoint or the OpenAI Responses API. The default is paused, with AI listings hidden. In `/admin`, enter the exact installed/model API name, choose the provider and enable processing. A model must be installed in Ollama separately; this repo does not download one. OpenAI requires `OPENAI_API_KEY` in the server environment and incurs provider charges. The AI adapters are tested with mocked responses; quality, speed and provider credentials need a real-model check on your server.

Jobs accept up to 12000 characters, use bounded output, time out after 240 seconds for Ollama or 120 seconds for OpenAI, run one at a time and cap requests per UTC day (default 50). Model failures refund test credits. Worker leases last 300 seconds and prevent concurrent claims. Cancellation or admin refunds prevent late delivery from charging credits again. A worker crash can cause a provider request to be repeated after lease expiry: the daily request count includes every attempt, but provider billing cannot be made exactly-once. Pausing leaves existing queued jobs available for cancellation/refund. All services remain test-credit only. Local models consume server resources; benchmark before increasing limits. This worker has no shell, wallet, browsing or Moltbook tools.

### Update the existing arbit deployment

As root:

```sh
sudo -u arbit -H git -C /home/arbit/web/clicknlist.uk.to/public_html pull --ff-only origin main
bash /home/arbit/web/clicknlist.uk.to/public_html/deploy/update-hestia.sh
```

The update script validates tests, creates a private environment file only if missing, wires it into the existing web service, installs Kestrel's service, backs up and changes the HTTP server to redirect to HTTPS, validates nginx and reloads. It leaves the working HTTPS configuration unchanged. Hestia's nginx.conf_* certificate snippets remain included. Direct Hestia-generated configuration edits can be overwritten by a domain rebuild; move both proxy/redirect settings to a custom Hestia template before rebuilding.

Read the admin key locally from `/home/arbit/web/clicknlist.uk.to/private/exchange.env` and paste it into your own `/admin` page. Never post that file or key in chat or commit it. Edit optional model credentials there and restart both services after changes. Verify `/api/health`, `/admin`, a homepage HEAD request, and an HTTP-to-HTTPS redirect. Enabling OpenAI sends AI job inputs to that provider; local Ollama keeps them on the server. There is no live model integration or Moltbook outreach enabled automatically.

CPU Ollama requests use four threads and temperature zero. Summaries target at most 150 words with a 240-token output cap; rewrites allow 800 tokens. Incomplete/truncated responses fail and refund credits. Rewrites mask numeric facts, full dates, greetings/signatures and selected conditions with immutable markers. Missing, duplicated, reordered or invented markers/numbers and dropped uncertainty reject the result with `factual_preservation_failed`. This conservative check can reject valid paraphrases and does not prove general semantic accuracy or recognize every proper name; users must still review outputs.

### Kestrel operations and outreach drafts

The existing worker checks operations on startup and every 60 seconds, even while a model request runs. The admin dashboard shows AI queue age, request durations, last-day attempt outcomes, repeated failure codes, and expired leases. Findings are aggregate-only: they do not contain private job inputs, API keys or generated results. Activity records change when the monitored state changes, with a retained maximum of 200 entries. Historical requests without timing columns show no duration; timing starts after this update.

Admin can create outreach drafts from currently available service listings, mark them approved, or archive them. These templates disclose Kestrel’s role and test-credit status without spending model requests. The integration link is relative and should be expanded to your exchange URL before using a draft elsewhere. Approval records review status only. There is no sending, posting, Moltbook integration or automatic outreach in this milestone. Monitoring identifies problems; it does not automatically pause services, refund jobs, restart infrastructure or change pricing.

### Moltbook identity

Register once from the deployment server with `node src/moltbook.ts KestrelField` and the same `DATA_DIR` as the worker. Credentials are stored at `../moltbook.json` relative to `DATA_DIR` (override with `MOLTBOOK_CREDENTIALS_FILE`), with mode 0600. Run as the app user; never commit this file or paste its API key. The command prints the owner claim link and verification code, not the API key. Existing credentials are reused; registration is not automatically retried or renamed. If a connection fails during registration, check whether the identity was created before retrying.

Moltbook requires its human owner to complete email and X verification. The worker checks claim status every 30 minutes and displays it privately in admin. API credentials go only to `https://www.moltbook.com/api/v1/agents/status`; redirects are rejected. This milestone registers/checks identity only. No feed browsing, posting, comments, votes, messages, or challenge solving are automated.
