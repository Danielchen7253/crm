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
- `META_APP_ID` optional, defaults to the current CRM Meta app id

## Render start command

```bash
gunicorn app:app
```

## Meta webhook callback

```text
https://YOUR-CRM-RENDER-URL.onrender.com/webhooks/meta
```

Subscribe to Messenger `messages` events for the Facebook Page.

## Meta permissions

Core permissions/features for the CRM:

- `pages_messaging`: receive and send Page Messenger conversations.
- `pages_manage_metadata`: subscribe Page webhooks and manage Page webhook settings.
- `pages_show_list`: let the app list and connect managed Facebook Pages.
- `pages_read_engagement`: read Page metadata and engagement for diagnostics and customer context.
- `Business Asset User Profile Access`: read profile fields for users interacting with business assets, such as name and picture.

Useful later:

- `pages_read_user_content`: read visitor posts, comments, ratings, and other Page user-generated content.
- `pages_manage_engagement`: manage Page comments and engagement from CRM.
- `read_insights`: read Page/app performance metrics.
- `business_management`: manage business assets such as WABA, system users, and business settings.

Not needed now:

- `Live Video API`
- `email`
- `facebook_branded_content_ads_brand`
- `facebook_creator_marketplace_discovery`
- `pages_manage_posts`
- `public_profile`

Permission diagnostic endpoint:

```text
https://crm-8t7y.onrender.com/admin/meta/permissions
```

## Database

Run `schema.sql` in the Supabase SQL editor before connecting the webhook.
