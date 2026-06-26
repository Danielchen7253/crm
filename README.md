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
