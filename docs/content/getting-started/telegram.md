---
title: "Telegram Setup"
weight: 5
---
Polyclaw and the Cloudflare tunnel run locally on your Mac, but Azure Bot Service still acts as the cloud relay between Telegram and your machine. You don't run Azure infrastructure locally — it's just a free cloud middleman.

Here's what the actual data flow looks like:


Telegram app (local)
    ↓  sends message to Telegram servers
Azure Bot Service  ←── registered with your bot token
    ↓  POST /api/messages  
Cloudflare tunnel (running locally on your Mac)
    ↓  forwards to
Polyclaw at localhost:9090
So "fully local" in practical terms means:

Component	Where it runs
Polyclaw server	Local Mac (localhost:9090)
Telegram client	Local Mac
Cloudflare tunnel (cloudflared)	Local Mac — exposes localhost publicly
Azure Bot Service	Cloud (free tier, no local install)
Telegram servers	Telegram's cloud
What you need to set up once:

An Azure subscription (free tier works)
Azure CLI installed and az login authenticated
A bot token from BotFather
The Cloudflare tunnel — Polyclaw can start this for you via the Setup Wizard

# Setting Up Telegram as a Channel

Polyclaw uses Azure Bot Framework to connect to Telegram. Once configured, you can chat with your agent, send files, and receive HITL (Human-in-the-Loop) approval prompts directly from Telegram.

## Prerequisites

- Polyclaw is running and accessible at `http://localhost:9090`
- A Cloudflare tunnel is available (or will be started during setup)
- Azure CLI is authenticated (`az login`)
- A Telegram account

## Step 1 — Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts:
   - Choose a display name (e.g. `My Polyclaw Agent`)
   - Choose a username — must end in `bot` (e.g. `mypolyclaw_bot`)
3. BotFather replies with your **bot token**:
   ```
   Use this token to access the HTTP API:
   1234567890:ABCDEFGhijklmnopqrstuvwxyz1234567
   ```
   Copy the token — you will need it in the next step.

## Step 2 — Configure the Bot in Polyclaw

1. Open the Setup Wizard at `http://localhost:9090/setup`
2. Under **Bot Configuration**, fill in:
   - **Telegram Token** — paste the token from BotFather
   - **Telegram Whitelist** — comma-separated list of Telegram **user IDs** (not usernames) you want to allow

   > **Find your Telegram user ID:** Send a message to [@userinfobot](https://t.me/userinfobot) — it replies with your numeric ID.

3. Click **Save Configuration**

<div class="callout callout--danger" style="margin-top:12px">
<p class="callout__title">Always set a whitelist</p>
<p>Without a whitelist, <strong>anyone</strong> who finds your bot's Telegram handle can send it messages and the agent will respond using your runtime identity's Azure credentials. Set the whitelist to only your own Telegram user ID(s).</p>
</div>

## Step 3 — Start the Tunnel

Azure Bot Service needs a public HTTPS URL to deliver messages to your agent. If the tunnel is not already running:

1. In the Setup Wizard, click **Start Tunnel**
2. Wait for the tunnel status indicator to turn green
3. The tunnel URL (e.g. `https://xxx.trycloudflare.com`) is now registered as the bot endpoint

The tunnel must remain running for Telegram messages to reach the agent. If Polyclaw is managed via `polyclaw.sh`, the tunnel is started automatically on `start`.

## Step 4 — Deploy Infrastructure

Click **Deploy Infrastructure** in the Setup Wizard. This step:

1. Creates or updates an **Azure Bot Service** resource in your configured resource group
2. Registers the Cloudflare tunnel URL as the messaging endpoint (`/api/messages`)
3. Configures the **Telegram channel** in Azure Bot Service using your bot token
4. Registers the Polyclaw multi-tenant app (`BOT_APP_ID`) with Bot Framework

Wait for the deployment to complete (typically 1–2 minutes). You can monitor progress in the Polyclaw server log.

## Step 5 — Verify the Connection

1. In the Setup Wizard, click **Run Preflight Checks**
2. Confirm that the **Telegram channel** check passes
3. Open Telegram, find your bot by its username, and send `/hello`
4. The agent should respond within a few seconds

> **First-message delay:** After a fresh deployment or restart, the Telegram channel may take a minute or two to become fully operational while the tunnel is registered and Bot Service propagates the configuration. Messages sent during this window may fail silently — just wait and retry.

## Optional — Whitelist via Environment Variable

The whitelist can also be set in the `.env` file instead of (or in addition to) the Setup Wizard:

```env
TELEGRAM_WHITELIST=123456789,987654321
```

Restart Polyclaw after editing `.env` for the change to take effect. The `TELEGRAM_WHITELIST` variable takes comma-separated numeric user IDs. An empty value allows all users.

## Using Telegram

Once connected, the bot responds to any message as a normal conversation turn. Additional capabilities:

| Feature | How to use |
|---|---|
| **Slash commands** | Send `/skills`, `/memory`, `/profile`, etc. |
| **File / image upload** | Attach a file to your message — it is saved to `~/.polyclaw/media/incoming/` and included in the agent's context |
| **HITL approvals** | When Guardrails requires human approval, the bot sends a message asking you to reply **y** to approve or anything else to deny |
| **Proactive messages** | If proactive messaging is enabled, the agent can send unprompted updates |

> **Formatting note:** Telegram messages are delivered as plain text. Markdown formatting (bold, code blocks, etc.) that the agent produces is stripped before delivery.

## HITL Approvals via Telegram

When Guardrails is enabled and a tool requires human approval, the bot sends:

```
The agent wants to use the tool bash.

Arguments: `curl https://example.com`

Reply y to approve or anything else to deny.
```

Reply **y** (or **yes**, case-insensitive) to allow the tool to run. Any other reply denies it. Approvals time out after 5 minutes if no response is received.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot doesn't respond | Tunnel not running | Start tunnel in Setup Wizard |
| `HTTP 530` errors in Bot Service logs | Tunnel URL not yet registered | Wait ~1 min after restart, then retry |
| "Unauthorized" in server log | Message from non-whitelisted user | Add user ID to the whitelist |
| Bot responds to strangers | Whitelist is empty | Set `TELEGRAM_WHITELIST` in Setup Wizard or `.env` |
| HITL approval message never arrives | `bot_reply_fn` not wired | Ensure Guardrails channel is set to `chat` (default) or redeploy |

## Related

- [Messaging & Bot Framework](/features/messaging/) — architecture and message flow details
- [Guardrails](/features/guardrails/) — configuring HITL approval policies
- [Setup Wizard](/getting-started/setup-wizard/) — full setup wizard reference


The token is already stored (InfraConfigStore.channels.telegram.token), the whitelist logic is there, and the agent/HITL pipeline doesn't care how messages arrive. The Bot Framework layer (botbuilder, BotFrameworkAdapter, Azure credentials) is entirely bypassable for Telegram.

Here's what the two native modes look like:

Option A — Native Webhook (still needs Cloudflare tunnel, no Azure)


Telegram servers → Cloudflare tunnel → localhost:9090/api/telegram/webhook
Polyclaw calls api.telegram.org/sendMessage for replies

Option B — Long Polling (100% local, zero public URL)


Polyclaw background task polls api.telegram.org/getUpdates every ~1s
Polyclaw calls api.telegram.org/sendMessage for replies
Nothing listens for inbound connections
Both modes share the same reply path and reuse everything: Agent, HitlInterceptor, session store, whitelist, HITL approval flow.

What would change:

File	Change
New app/runtime/messaging/telegram_native.py	New channel class — polling loop or webhook handler, sends replies via Telegram API
server/app.py	Wire in the new channel on startup
server/wiring.py	Conditionally create native Telegram channel if bot framework not configured
config/settings.py	Expose TELEGRAM_BOT_TOKEN directly (fallback from infra store)
What stays unchanged: bot.py, BotEndpoint, MessageProcessor, BotFrameworkAdapter, all Azure/provisioner code.

The Bot Framework channel for Teams/other channels continues to work. Native Telegram is additive.

Do you want me to implement the polling approach first (simpler, zero dependencies on Cloudflare tunnel, best for local dev on macOS)?

Telegram servers
    ↓
Cloudflare edge
    ↓ (encrypted outbound tunnel)
cloudflared (on macOS)
    ↓
localhost:9090/api/telegram/webhook




2 files changed:

New: telegram_native.py

TelegramPollingChannel — self-contained, ~160 lines
Polls getUpdates with 30s long-poll timeout (40s aiohttp timeout)
Whitelist check via cfg.telegram_whitelist
HITL resolution: incoming text resolves pending y/n approvals
CommandDispatcher for slash commands (/skills, /memory, etc.)
Agent turn with bind_turn/unbind_turn HITL lifecycle
Replies via sendMessage, strips markdown, splits at 4000 chars
Modified: lifecycle.py

Starts native polling on startup when token is saved but bot_configured is False
Cancels the poll task and closes the HTTP session on shutdown
Setup to use it:

Open http://localhost:9090/setup → Bot Configuration
Paste your BotFather token, set your Telegram user ID as whitelist
Click Save Configuration — skip Deploy Infrastructure entirely
Restart Polyclaw: ./scripts/polyclaw.sh restart
Look for: [startup.runtime] Native Telegram polling started (no Azure)
Send any message to your bot in Telegram