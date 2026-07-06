# CoolFix Omni CRM

Full-channel message center CRM for CoolFix Pro Supply.

This is the new formal system. The existing Flask CRM stays online while this
system is developed and later receives migrated customers, identities, messages,
website chat records, SMS records, and voice call records.

## New Thread Handoff

For a new Codex CRM project thread, start with:

- [CRM_HANDOFF_NEW_THREAD.md](./CRM_HANDOFF_NEW_THREAD.md)

That file records the current CRM decisions, repository/deploy links, channel
status, plugins/tools discussed, and the next operational audit.

## Stack

- Next.js + TypeScript frontend
- NestJS + TypeScript backend
- PostgreSQL + Prisma
- Socket.io realtime inbox updates
- Redis + BullMQ workers
- S3/R2-compatible file storage
- OpenAI Responses API for suggested replies only
- Docker Compose local runtime

## Core Rule

Every channel enters the same data pipeline:

`raw webhook -> verify -> identity -> customer -> conversation -> dedupe -> message -> realtime -> AI suggestion`

No channel gets a separate chat system.

## Apps

- `apps/api`: NestJS API, webhooks, channel adapters, AI, campaigns
- `apps/web`: Next.js unified Inbox UI
- `packages/database`: Prisma schema and seed
- `packages/shared`: shared enums and DTO types
- `scripts`: migration and operations scripts

## Current Build Status

Implemented in this scaffold:

- Full Prisma schema for users, roles, permissions, customers, identities, channel accounts, conversations, messages, attachments, tags, notes, quick replies, AI logs, campaigns, templates, webhook events, audit logs, files, and settings
- Unified inbound message pipeline with customer matching, phone/email merge rules, conversation lookup, dedupe, message write, realtime emit, and AI suggestion trigger
- Webhook entrypoints for Meta, WhatsApp payloads, Twilio SMS/MMS, email, and website chat
- Core APIs for auth, conversations, messages, customers, quick replies, campaigns, settings, and channel accounts
- First unified Inbox UI layout
- Legacy migration script shell for moving the existing Flask/Supabase CRM data into the new schema

Not production-ready yet:

- Real JWT/password auth and permission guards
- Provider send adapters for Meta, WhatsApp, Twilio, Email, and Instagram
- Webhook signature verification per provider
- Worker queues for campaign sending, retries, and media processing
- Full deploy configuration for Render or a dedicated container host

## Local Start

```bash
cp .env.example .env
pnpm install
pnpm prisma:generate
pnpm prisma:migrate
pnpm seed
docker compose up --build
```

Then open:

- Web: http://localhost:3000
- API: http://localhost:4000

## Migration From Old CRM

The old Flask CRM remains the source until the new system is ready. Migration is
handled by `scripts/migrate-legacy.ts` and maps:

- `customers` -> `customers`
- `customer_identities` -> `customer_identities`
- `messages` -> `conversations`, `messages`, `message_attachments`
- website chat / SMS / phone events -> unified conversations/messages

Required migration env:

```bash
LEGACY_SUPABASE_URL=
LEGACY_SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL=
```

Run:

```bash
pnpm migrate:legacy
```

## Channel readiness audit (recommended before end-to-end tests)

```bash
pnpm check:channels
```

If your deployment uses `META_WEBHOOK_VERIFY_TOKEN` as the webhook verify value, set it identically with `META_VERIFY_TOKEN` (the route accepts both).

This prints a per-channel readiness checklist from `.env`:

- WhatsApp
- Messenger
- Instagram
- SMS
- Website Chat
- Email
- Phone

After the config check passes, run these runtime checks:

1. Open a conversation for each channel in Inbox
2. Send one outbound reply from CRM
3. Confirm status in message list updates (queued/sent/read/failed and provider)
4. For SMS/WhatsApp/Phone, verify callback/webhook endpoints can receive status if configured
5. For Phone, confirm call sessions progress from ringing -> active -> completed/failed/missed

You can also run a quick channel smoke script:

```bash
node scripts/smoke-channel-send.mjs https://coolfix-omni-api.onrender.com
```

Append `--send` to actually send test replies to one conversation per channel:

```bash
node scripts/smoke-channel-send.mjs https://coolfix-omni-api.onrender.com --send
```

Dry-run mode (without `--send`) is recommended before credentials are finalized.

## Production channel recovery runbook (required to make all channels active)

Run these commands in this repo whenever production env changes:

```bash
node scripts/check-channel-config.mjs
node scripts/sync-channel-accounts.mjs
node scripts/verify-live-channels.mjs https://coolfix-omni-api.onrender.com <META_VERIFY_TOKEN>
node scripts/smoke-channel-send.mjs https://coolfix-omni-api.onrender.com
```

Only after all env vars are set, execute a real send smoke test:

```bash
node scripts/smoke-channel-send.mjs https://coolfix-omni-api.onrender.com --send
```

Current expected blocker list until production env is updated:

- `META_VERIFY_TOKEN` / `META_WEBHOOK_VERIFY_TOKEN`
- `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` (avoid `code 190`)
- `MESSENGER_PAGE_ACCESS_TOKEN` + `MESSENGER_PAGE_ID`
- `INSTAGRAM_ACCESS_TOKEN` + `INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_DEFAULT_FROM`
- `WEBSITE_CHAT_WEBHOOK_URL`
- `WEBSITE_CHAT_ALLOWED_ORIGINS` (optional; set to comma-separated website origins that are allowed to call `/api/webhooks/website-chat`, e.g. `https://shop.gasket.example,https://www.gasket.example`)
- `CORS_ALLOW_ALL_ORIGINS=1` (temporary debug switch only; prefer explicit origins above)
- `RESEND_API_KEY` + `RESEND_FROM` (or `EMAIL_WEBHOOK_URL`)
- `API_PUBLIC_URL=https://coolfix-omni-api.onrender.com`

After `sync-channel-accounts`, the target account set should include:

- `whatsapp` / `AUTO_WHATSAPP`
- `messenger` / `AUTO_MESSENGER`
- `instagram` / `AUTO_INSTAGRAM`
- `sms` / `AUTO_TWILIO_SMS`
- `phone` / `AUTO_TWILIO_VOICE`
- `website_chat` / `AUTO_WEBSITE_CHAT`
- `email` / `AUTO_EMAIL_RESEND` (or `AUTO_EMAIL_WEBHOOK`)
