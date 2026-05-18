# Minimal CRM

This CRM starts with one goal: automatically save Messenger customers and their messages into a unified customer database.

## First target

- Receive Messenger webhook events from Meta.
- Create or update a customer profile automatically.
- Save every inbound message.
- Show customers and recent messages in a simple web dashboard.
- Optionally import recent Messenger conversations from the Page API when a Page access token is available.

## Required environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `META_VERIFY_TOKEN`
- `META_APP_SECRET`
- `META_PAGE_ACCESS_TOKEN`
- `META_PAGE_ID`

## Render start command

```bash
gunicorn app:app
```

## Meta webhook callback

```text
https://YOUR-CRM-RENDER-URL.onrender.com/webhooks/meta
```

Subscribe to Messenger `messages` events for the Facebook Page.

## Database

Run `schema.sql` in the Supabase SQL editor before connecting the webhook.
