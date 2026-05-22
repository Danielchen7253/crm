"""Render live entrypoint."""

import os
import threading
import time

import requests
from flask import jsonify, request

import app as crm_module
from app import app

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_tEfal3LHiG1MxRVn1uDutA_Mcub7Bg4")
META_PAGE_ID = os.getenv("META_PAGE_ID", "")
AUTO_SYNC_SECONDS = float(os.getenv("CRM_AUTO_SYNC_SECONDS", "2"))
AUTO_SYNC_STATE = {"started": False, "last_ok": None, "last_error": None, "runs": 0, "imported": 0}

REALTIME_SCRIPT = """
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script>
(function () {
  if (window.__crmRealtimeRefresh) return;
  window.__crmRealtimeRefresh = true;
  let lastSignature = null;
  let reloading = false;
  let checking = false;
  const title = document.title || 'CRM 客户工作台';

  function refresh() {
    if (reloading) return;
    reloading = true;
    document.title = '有新消息 - ' + title.replace(/^有新消息 - /, '');
    window.location.reload();
  }

  async function checkLatest() {
    if (checking || reloading) return;
    checking = true;
    try {
      const res = await fetch('/api/latest-message-signature', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const sig = data.signature || 'empty';
      if (lastSignature === null) lastSignature = sig;
      else if (sig !== lastSignature) refresh();
    } catch (e) {
    } finally {
      checking = false;
    }
  }

  async function startRealtime() {
    try {
      const cfgRes = await fetch('/api/realtime-config', { cache: 'no-store' });
      if (!cfgRes.ok) return;
      const cfg = await cfgRes.json();
      if (!window.supabase || !cfg.url || !cfg.key) return;
      const client = window.supabase.createClient(cfg.url, cfg.key);
      client.channel('crm-messages')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, refresh)
        .subscribe(function (status) { window.__crmRealtimeStatus = status; });
    } catch (e) {
      window.__crmRealtimeError = String(e && e.message ? e.message : e);
    }
  }

  startRealtime();
  setInterval(checkLatest, 1000);
  setTimeout(checkLatest, 300);
})();
</script>
"""


def supabase_headers():
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }


def latest_signature():
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return "not_configured"
    response = requests.get(
        f"{SUPABASE_URL}/rest/v1/messages",
        headers=supabase_headers(),
        params={"select": "id,provider_message_id,sent_at,created_at", "order": "created_at.desc", "limit": "1"},
        timeout=10,
    )
    response.raise_for_status()
    rows = response.json()
    if not rows:
        return "empty"
    row = rows[0]
    return "|".join(str(row.get(key) or "") for key in ["id", "provider_message_id", "sent_at", "created_at"])


def sync_latest_messenger():
    if not META_PAGE_ID:
        return 0
    conversations = crm_module.graph_get(
        f"{META_PAGE_ID}/conversations",
        {"fields": "participants{id,name},messages.limit(3){id,message,from,to,created_time,attachments}", "limit": "1"},
    )
    imported = 0
    for conversation in conversations.get("data", []):
        people = [p for p in conversation.get("participants", {}).get("data", []) if p.get("id") != META_PAGE_ID]
        if not people:
            continue
        customer_id = crm_module.ensure_customer(people[0]["id"], {"name": people[0].get("name")})
        for message in conversation.get("messages", {}).get("data", []):
            direction = "outbound" if message.get("from", {}).get("id") == META_PAGE_ID else "inbound"
            saved = crm_module.save_message(
                customer_id,
                message.get("id"),
                direction,
                message.get("message"),
                message.get("attachments", {}).get("data", []),
                message,
                message.get("created_time"),
            )
            if saved:
                imported += 1
    return imported


def auto_sync_loop():
    while True:
        try:
            imported = sync_latest_messenger()
            AUTO_SYNC_STATE["last_ok"] = crm_module.now_iso()
            AUTO_SYNC_STATE["last_error"] = None
            AUTO_SYNC_STATE["runs"] += 1
            AUTO_SYNC_STATE["imported"] += imported
        except Exception as error:
            AUTO_SYNC_STATE["last_error"] = str(error)
        time.sleep(max(AUTO_SYNC_SECONDS, 1))


def start_auto_sync():
    if AUTO_SYNC_STATE["started"]:
        return
    AUTO_SYNC_STATE["started"] = True
    threading.Thread(target=auto_sync_loop, name="crm-latest-messenger-sync", daemon=True).start()


@app.get("/api/realtime-config")
def realtime_config():
    response = jsonify({"ok": True, "url": SUPABASE_URL, "key": SUPABASE_PUBLISHABLE_KEY})
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


@app.get("/api/latest-message-signature")
def latest_message_signature():
    try:
        payload = {"ok": True, "signature": latest_signature(), "auto_sync": AUTO_SYNC_STATE}
        status = 200
    except Exception as error:
        payload = {"ok": False, "error": str(error), "auto_sync": AUTO_SYNC_STATE}
        status = 500
    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response, status


@app.get("/api/auto-sync-status")
def auto_sync_status():
    return jsonify({"ok": True, "auto_sync": AUTO_SYNC_STATE})


@app.after_request
def inject_realtime_script(response):
    if request.method != "GET" or request.path != "/":
        return response
    if "text/html" not in response.headers.get("Content-Type", "").lower():
        return response
    body = response.get_data(as_text=True)
    if "__crmRealtimeRefresh" in body:
        return response
    body = body.replace("</body>", REALTIME_SCRIPT + "</body>") if "</body>" in body else body + REALTIME_SCRIPT
    response.set_data(body)
    response.headers["Content-Length"] = str(len(response.get_data()))
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


start_auto_sync()
