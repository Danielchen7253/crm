"""Render live entrypoint."""

import os

import requests
from flask import jsonify, request

from app import app

GRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v21.0")
META_PAGE_ID = os.getenv("META_PAGE_ID", "")
META_PAGE_ACCESS_TOKEN = os.getenv("META_PAGE_ACCESS_TOKEN", "")
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
MESSENGER_FIELDS = "messages,message_echoes,messaging_postbacks,message_deliveries,message_reads"

AUTO_REFRESH_SCRIPT = """
<script>
(function () {
  if (window.__crmAutoRefreshInstalled) return;
  window.__crmAutoRefreshInstalled = true;
  let currentSignature = null;
  let checking = false;

  async function checkForUpdates() {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const response = await fetch('/api/updates', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const nextSignature = data.latest_message_signature || 'empty';
      if (currentSignature === null) {
        currentSignature = nextSignature;
        return;
      }
      if (nextSignature !== currentSignature) {
        window.location.reload();
      }
    } catch (error) {
      // Keep the page quiet if the network has a short hiccup.
    } finally {
      checking = false;
    }
  }

  setInterval(checkForUpdates, 1200);
  setTimeout(checkForUpdates, 500);
})();
</script>
"""


def graph_url(path):
    return f"https://graph.facebook.com/{GRAPH_API_VERSION}/{path.lstrip('/')}"


def supabase_headers():
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
    }


def latest_message_signature():
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return "not_configured"
    response = requests.get(
        f"{SUPABASE_URL}/rest/v1/messages",
        headers=supabase_headers(),
        params={
            "select": "id,provider_message_id,sent_at,created_at",
            "order": "created_at.desc",
            "limit": "1",
        },
        timeout=10,
    )
    response.raise_for_status()
    rows = response.json()
    if not rows:
        return "empty"
    row = rows[0]
    return "|".join(str(row.get(key) or "") for key in ["id", "provider_message_id", "sent_at", "created_at"])


@app.get("/api/updates")
def crm_updates():
    try:
        signature = latest_message_signature()
        payload = {"ok": True, "latest_message_signature": signature}
        status = 200
    except Exception as error:
        payload = {"ok": False, "error": str(error)}
        status = 500
    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response, status


@app.after_request
def inject_auto_refresh(response):
    if request.method != "GET" or request.path != "/":
        return response
    content_type = response.headers.get("Content-Type", "")
    if "text/html" not in content_type.lower():
        return response
    body = response.get_data(as_text=True)
    if "__crmAutoRefreshInstalled" in body:
        return response
    if "</body>" in body:
        body = body.replace("</body>", AUTO_REFRESH_SCRIPT + "</body>")
    else:
        body += AUTO_REFRESH_SCRIPT
    response.set_data(body)
    response.headers["Content-Length"] = str(len(response.get_data()))
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


@app.post("/admin/meta/subscribe-page")
def subscribe_meta_page():
    if not META_PAGE_ID or not META_PAGE_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "META_PAGE_ID or META_PAGE_ACCESS_TOKEN is missing"}), 400

    subscribe_response = requests.post(
        graph_url(f"{META_PAGE_ID}/subscribed_apps"),
        params={
            "access_token": META_PAGE_ACCESS_TOKEN,
            "subscribed_fields": MESSENGER_FIELDS,
        },
        timeout=30,
    )
    subscribe_body = subscribe_response.json() if subscribe_response.content else {}

    check_response = requests.get(
        graph_url(f"{META_PAGE_ID}/subscribed_apps"),
        params={"access_token": META_PAGE_ACCESS_TOKEN},
        timeout=30,
    )
    check_body = check_response.json() if check_response.content else {}

    return jsonify(
        {
            "ok": subscribe_response.ok and check_response.ok,
            "subscribe_status": subscribe_response.status_code,
            "subscribe_response": subscribe_body,
            "check_status": check_response.status_code,
            "check_response": check_body,
            "requested_fields": MESSENGER_FIELDS.split(","),
        }
    ), 200 if subscribe_response.ok and check_response.ok else 400


@app.get("/admin/meta/subscriptions")
def get_meta_subscriptions():
    if not META_PAGE_ID or not META_PAGE_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "META_PAGE_ID or META_PAGE_ACCESS_TOKEN is missing"}), 400

    response = requests.get(
        graph_url(f"{META_PAGE_ID}/subscribed_apps"),
        params={"access_token": META_PAGE_ACCESS_TOKEN},
        timeout=30,
    )
    body = response.json() if response.content else {}
    return jsonify({"ok": response.ok, "status": response.status_code, "response": body}), 200 if response.ok else 400
