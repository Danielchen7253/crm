# CoolFix Omni CRM - New Thread Handoff

Last updated: 2026-06-25

Use this file as the starting context for a new CRM project thread. It summarizes the important decisions, repositories, services, plugins, current channel status, and next work. Do not store real tokens or private keys in this file.

## Core Goal

Build a practical CRM for CoolFix Pro Supply that centralizes customers from all channels into one customer pool and one inbox.

The system should not be a collection of separate chat tools. The target architecture is:

- One customer master record.
- Many channel identities per customer.
- One shared conversation/message system.
- One CRM inbox for Messenger, WhatsApp, SMS, Instagram, Email, Website Chat, and future channels.
- AI suggests replies, but does not auto-send unless explicitly changed later.
- CRM should support follow-up, tags, marketing segmentation, customer value, reminders, and later Shopify/order lookup.

## Important User Rule

In this CRM topic, wait for the user to say the permission phrase "ke yi dong shou le" before making code changes or operational changes. In Chinese, this phrase means the user is explicitly allowing work to begin.

The user has sometimes granted broad permission for a specific work session, but the standing rule for this topic is: do not start implementation until the permission phrase is said.

## Active Repository

Primary CRM rebuild repository:

- GitHub: `https://github.com/Danielchen7253/crm`
- Local path: `C:\Users\joel7\Documents\Codex\2026-05-17\crm\omni_crm`
- Branch used for current rebuild/deploy: `omni-crm-rebuild`

Old CRM prototype files still exist in:

- Local path: `C:\Users\joel7\Documents\Codex\2026-05-17\crm`
- Examples: `app.py`, `app_live_new.py`, `whatsapp_live.py`, `whatsapp_fix.py`, `messenger_import_fix.py`

These old files are legacy context only. New work should normally be done in `omni_crm`.

Related non-CRM project:

- GitHub: `https://github.com/Danielchen7253/gasket`
- Render website: `https://gasket.onrender.com`
- Purpose: refrigerator gasket/nameplate site and crawler jobs.
- Do not mix CRM runtime into the gasket Render service.

## Deployed CRM Services

Current production CRM URLs:

- Web: `https://coolfix-omni-web.onrender.com`
- API: `https://coolfix-omni-api.onrender.com`

Render services:

- API service: `coolfix-omni-api`
- Web service: `coolfix-omni-web`
- Render branch: `omni-crm-rebuild`

Previous/legacy CRM URL:

- `https://crm-8t7y.onrender.com`

Current API health root returns:

```json
{
  "name": "CoolFix Omni CRM API",
  "status": "ok",
  "docs": {
    "health": "/api/auth/me",
    "conversations": "/api/conversations",
    "twilioIncoming": "/api/twilio/incoming"
  }
}
```

## Tech Stack

Current rebuild stack:

- Monorepo with pnpm workspaces.
- Frontend: Next.js App Router, React, TypeScript, Tailwind-like CSS through global CSS.
- Backend: NestJS, TypeScript.
- Database: PostgreSQL.
- ORM: Prisma.
- Realtime: Socket.IO.
- AI: OpenAI API for suggested replies.
- Voice/SMS: Twilio.
- Meta channels: Facebook Messenger, WhatsApp Cloud API, planned Instagram DM.
- Website Chat: custom website widget/webhook.

Build command used locally:

```powershell
$env:PATH='C:\Users\joel7\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
$env:COREPACK_ENABLE_PROJECT_SPEC='0'
node package\bin\pnpm.cjs build
```

Root build script now runs Prisma generate before API/Web build.

## Important Environment Variable Names

Do not write real values into repo docs.

Known environment variable names:

- `DATABASE_URL`
- `WEB_ORIGIN`
- `API_PUBLIC_URL`
- `JWT_SECRET`
- `ENCRYPTION_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `MESSENGER_PAGE_ACCESS_TOKEN`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `META_VERIFY_TOKEN`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_DEFAULT_FROM`
- `OWNER_PHONE`
- `VOICE_WELCOME_MESSAGE`
- `REDIS_URL`

## Plugins / Tools Mentioned Or Used In This Topic

Codex/tooling:

- `computer-use` plugin was referenced by the user.
- Chrome/browser control was discussed/used for Meta, Shopify, Twilio, and plugin workflows.
- GitHub integration is relevant for repo/PR work.
- Gmail/Outlook-style email connectors were discussed conceptually for future Email channel, but Email channel is not fully implemented.
- Supabase was used in earlier prototype discussion, but current rebuild uses PostgreSQL/Prisma on Render.

Browser/extension work:

- Facebook Posting Assistant extension existed in older work.
- Facebook customer capture extension existed in older work.
- These were for Marketplace/private Messenger capture, not the same as official Page Messenger API.

Third-party platforms discussed:

- Render: deployment.
- GitHub: repository source.
- Meta Developers: Messenger, WhatsApp, Instagram permissions/webhooks.
- Facebook Business / Pages / Marketplace.
- WhatsApp Cloud API.
- Twilio: SMS, MMS, Voice, A2P 10DLC.
- Shopify: future inventory/order lookup.
- TikTok API: discussed but not integrated.
- ManyChat / SaleSmartly / Make / MyFBleads / ChatPilot CRM: discussed as examples/alternatives for private/social capture workflows.
- Telnyx: considered for SMS, rejected as too complex at signup.

## Current Channel Status

This is the operational status as of the latest known work. Verify before claiming production readiness.

### Messenger Page

Goal:

- Public Page Messenger customers should enter CRM automatically.
- CRM should receive new Page messages through Meta webhook.
- CRM should send replies through Messenger API.
- Customer name/avatar should sync where Meta permissions allow it.

Known state:

- Messenger Page token exists in Render env.
- Messenger webhook code exists.
- Messenger sync/admin endpoints exist.
- Mobile chat can show Messenger messages already stored.
- Sending has failed before when `MESSENGER_PAGE_ACCESS_TOKEN` was missing; token was later added.

Needs verification:

- Real inbound Page message reaches CRM without manual refresh.
- CRM outbound reply reaches Messenger.
- Webhook subscription is active for Page `messages` and related fields.
- App permissions/app review status allow non-admin customers.
- Historical Page conversations sync scope is limited by Meta API permissions; private Marketplace/personal Messenger is not covered by official Page API.

### WhatsApp Business

Goal:

- Real business phone should receive WhatsApp inbound messages into CRM.
- CRM should send WhatsApp replies using Cloud API.
- Attachments should support image, PDF, audio, video where Cloud API allows.
- 24-hour session window and templates must be respected.

Known state:

- `WHATSAPP_ACCESS_TOKEN` exists in Render env.
- `WHATSAPP_PHONE_NUMBER_ID` exists in Render env.
- WhatsApp webhook endpoint exists.
- WhatsApp test customer/messages existed in CRM.
- The user wanted the real number connected, not test number.

Needs verification:

- Real WhatsApp phone number is correctly bound to the Cloud API phone number ID.
- Inbound webhook fires to CRM for real customer messages.
- Outbound text replies work.
- Media download/send flows need testing.
- Template sending after 24-hour window likely still needs a proper UI/workflow.

### Twilio SMS

Goal:

- CRM receives SMS.
- CRM sends SMS from Twilio number.
- Failed status and reasons should be visible.
- STOP/unsubscribe should be handled.

Known state:

- Twilio number selected: `+1 858 757 0488`.
- User paid/upgraded Twilio.
- A2P 10DLC campaign was rejected once because opt-in/message-flow disclosure was insufficient.
- CRM could receive SMS from phone.
- CRM outbound SMS to phone had an issue reported by user.
- Backend has Twilio incoming/status routes.

Needs verification:

- A2P 10DLC campaign approval/current status.
- Outbound SMS deliverability after A2P fix.
- Twilio Messaging Service/status callback binding.
- STOP/unsubscribe enforcement.

### Website Chat

Goal:

- Website bottom-right chat widget for Shopify and gasket/nameplate site.
- Anonymous users can ask general questions.
- Personal/order info requires identity verification.
- Supports image upload.
- Messages enter CRM.
- AI suggests replies.

Known state:

- Website Chat webhook exists in API.
- Widget concept and integration were discussed.
- User asked to place widget on Shopify and gasket site.

Needs verification:

- Widget is actually installed on Shopify theme.
- Widget is actually installed on gasket site.
- Inbound website chat creates customer/conversation/message.
- Outbound CRM reply returns to website visitor in real time.

### Instagram DM

Goal:

- Instagram DMs enter same inbox.
- CRM can reply.

Known state:

- Instagram webhook route exists.
- API structure supports `instagram`.

Needs verification / likely incomplete:

- Meta app permissions for Instagram DM.
- Instagram account/Page connection.
- Inbound/outbound real tests.

### Email

Goal:

- Email enters same inbox by email address.
- CRM can reply and preserve thread.

Known state:

- Email channel is in schema and webhook route placeholders exist.

Likely incomplete:

- Gmail API/IMAP/SMTP integration.
- OAuth/account setup.
- Real inbound/outbound tests.

### Phone / AI Voice

Goal:

- Twilio Voice -> AI answers -> CRM record -> transfer to owner when needed.

Known state:

- PRD exists in thread.
- Backend has call session related tables/modules/routes.
- OpenAI Realtime + Twilio Media Streams were specified.

Needs verification / likely incomplete:

- Actual AI realtime voice bridge.
- Real inbound call test.
- Recording/transcript/summary end-to-end.
- Human handoff.

## CRM UX Decisions

Desktop CRM:

- Leftmost: function navigation.
- Second column: customer/conversation list.
- Right work area: customer details + action/chat area.
- Settings should contain interface management, AI quick replies, tags, etc.

Mobile Web:

- Not native app.
- Responsive Web/PWA.
- Default entry should be message page.
- Main mobile pages:
  - `/mobile/inbox`
  - `/mobile/conversations/:id`
  - `/mobile/customers/:id`
  - `/mobile/tasks`
  - `/mobile/me`

Mobile chat page requirements:

- Use `100dvh`, not fixed `100vh`.
- Top customer bar fixed.
- Bottom input fixed.
- Only middle chat list scrolls.
- Customer messages align left.
- Owner/staff messages align right.
- Message order: oldest at top, newest at bottom.
- Keyboard should not push header away.
- Input grows with text up to 5 lines.
- Attachment and AI buttons only; do not clutter the toolbar.
- AI score is small text near AI button.
- AI suggestion should go into input box, not auto-send.
- User's manual replies should be logged for AI learning.

## AI Rules

Current policy:

- AI suggests replies only.
- AI must not automatically send by default.
- AI must reply in the customer's language.
- Fixed answers should be maintained as quick replies/settings, not hard-coded forever.
- Low confidence, refund, complaint, unclear inventory, technical uncertainty: ask human.

Important AI output format from earlier PRD:

```json
{
  "detected_language": "en|es|zh",
  "intent": "price|stock|pickup|shipping|complaint|refund|order|other",
  "suggested_reply": "string",
  "confidence": 0.0,
  "action": "suggest_reply|ask_human|no_reply"
}
```

Fixed reply examples:

- Pickup Address
- Business Hours
- Shipping Available
- Wholesale Price
- Warranty Policy
- Ask Model Number
- Ask Quantity
- Spanish Greeting
- Capacitor Price
- Zelle Payment

Known business facts used in replies:

- Pickup address used in CRM replies: `755 International Blvd, Houston, TX 77024`.
- Earlier pickup/warehouse address also appeared for product posts: `5855 Cunningham Rd, Houston, TX 77041`.
- Shipping rule: paid before 3 PM ships same day; after 3 PM ships next business day; holidays may delay.

Confirm address before treating either as final public business address.

## Customer Tag System

Implemented and deployed:

- Page: `https://coolfix-omni-web.onrender.com/settings/tags`
- API: `/api/tags`
- Default tag seed: `/api/tags/seed-defaults`
- 97 default tags were initialized online.
- Supports unlimited stacked tags per customer.
- Supports create, hide, merge, bulk assign, import/export.
- Supports AND / OR / NOT filtering.
- Campaign recipient preview supports tag filters.
- Automatic tags:
  - Messenger inbound -> `Messenger Lead`
  - WhatsApp inbound -> `WhatsApp Lead`
  - Website Chat inbound -> `Website Lead`
  - Houston text/location -> `Houston`, `Texas`, `USA`
  - capacitor/compressor keywords -> product interest tags; bought/order language can add Bought tags.

Important implementation compromise:

- `CustomerTag` currently keeps composite key `[customerId, tagId]`.
- A new required `id` field was not forced because Render start command runs `prisma db push` and adding that field caused deploy failure.
- Functionally this still supports unlimited tags per customer and prevents duplicate same-tag assignment.

## Marketplace / Private Messenger Reality

Important distinction:

- Official Messenger API can manage Facebook Page conversations.
- Personal Messenger / Marketplace buyer conversations are not generally accessible through the same official Page API.
- For Marketplace/private Messenger customer capture, a browser extension/local automation approach was explored.

Existing older extension concepts:

- Facebook customer capture extension.
- Facebook posting assistant extension.

Known issue:

- Extension experiments captured wrong items or stopped early in some attempts.
- The most usable early direction was: user scrolls Marketplace/Messenger list, extension captures visible customers and uploads them to CRM.

Do not confuse:

- Page Messenger official API
- Personal Messenger / Marketplace browser capture

They are different systems with different constraints.

## Marketing / Posting Workbench

User wants a group posting workbench:

- Left side: saved post template with image/video/text.
- Bottom/left: queue of Facebook group links.
- Right side: opened group page or browser area.
- User manually joins/posts where needed.

A sample capacitor post/template was provided in the thread:

- Product: Factory Direct HVAC Capacitors CBB65
- Sizes: 5 uf, 7.5 uf, 10 uf, 15 uf, 20 uf, 35+5 uf, 40+5 uf, 45+5 uf, 50+5 uf, 55+5 uf, 60+5 uf, 70 uf, 70+7.5 uf, 80+7.5 uf
- Price: Starting from $9; bulk discount; technician pricing 20%-30% cheaper than Amazon
- Buy online product URL included in thread.

Facebook group API mass posting is constrained by Meta policies. A local/browser-assisted workflow is safer than pretending the API can blast posts everywhere.

## Shopify / Inventory / Order Direction

User wants AI/customer service to query Shopify for:

- Stock availability.
- Order status.
- Shipping/logistics status.
- Whether missing goods have purchase orders.
- Customer purchase history.

Need future work:

- Shopify Admin API integration.
- CRM settings page for integrations.
- Secure token storage.
- Product/order lookup endpoints.
- AI tool/function for inventory/order questions.

## Security / Access

User requested:

- CRM should be locked so others cannot access and message customers.
- Homepage/login should require password.
- System settings page should also require password.
- Settings will contain integrations, fixed replies, AI training docs, tags, etc.

Current status needs verification:

- Auth exists in backend.
- Full production-grade permission enforcement likely still incomplete.

## API / Data Architecture Requirements From PRDs

Core tables expected in full system:

- `users`
- `roles`
- `permissions`
- `customers`
- `customer_identities`
- `channel_accounts`
- `conversations`
- `messages`
- `message_attachments`
- `tags`
- `customer_tags`
- `internal_notes`
- `quick_replies`
- `ai_reply_logs`
- `campaigns`
- `campaign_recipients`
- `templates`
- `webhook_events`
- `audit_logs`
- `files`
- `settings`
- `sync_logs`

Core webhook flow:

1. Save raw payload to `webhook_events`.
2. Verify source/signature.
3. Parse identity.
4. Find/create customer.
5. Find/create customer identity.
6. Find/create conversation.
7. Deduplicate message.
8. Write message.
9. Save attachments.
10. Update last contact/message time.
11. Push realtime event through Socket.IO.
12. Trigger AI suggestion.

Deduplication:

- Primary: channel + external message id.
- Fallback: channel + sender external id + timestamp + content hash.

## Next Technical Priority

The next practical work should be channel status verification and repair:

For each channel, prove these with real evidence:

1. Inbound receives a real customer message.
2. CRM creates/updates customer.
3. CRM creates conversation/message.
4. Realtime UI updates.
5. Outbound send from CRM reaches the customer.
6. Attachment handling works where expected.
7. Provider status callback updates `sent/delivered/read/failed`.
8. Error reason is visible in CRM when sending fails.

Recommended order:

1. Messenger Page receive/send.
2. Twilio SMS receive/send/status.
3. WhatsApp real number receive/send.
4. Website Chat receive/send.
5. Instagram DM.
6. Email.
7. AI Voice.

## Known Open Question

The user asked, in Chinese:

"Are Messenger receiving and sending working now? Which other channels are working? Which are not working? Please make the broken ones work."

This needs a direct operational audit. Do not answer from memory only. Verify live API, Render env, webhook routes, database messages, and if possible send real test messages.

## Suggested New Thread Prompt

Copy this into the new CRM project thread:

```text
This is the new work thread for the CoolFix Omni CRM project. First read this repository file:

C:\Users\joel7\Documents\Codex\2026-05-17\crm\omni_crm\CRM_HANDOFF_NEW_THREAD.md

Current goal:
1. Audit whether Messenger, WhatsApp, Twilio SMS, Website Chat, Instagram, and Email can really receive and send.
2. Do not answer from memory. Verify with live API, Render config, database/message records, and real test results where possible.
3. Fix and deploy anything that can be fixed.
4. If something cannot be fixed immediately, state exactly what is blocked and which platform config or permission is needed.

CRM topic rule:
Do not change code or live configuration until the user says the permission phrase "ke yi dong shou le".
```
