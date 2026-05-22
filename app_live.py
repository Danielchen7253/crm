"""Render live entrypoint."""

import os

import requests
from flask import jsonify, request

from app import app

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_tEfal3LHiG1MxRVn1uDutA_Mcub7Bg4")

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
      if (lastSignature === null) {
        lastSignature = sig;
      } else if (sig !== lastSignature) {
        refresh();
      }
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


@app.get("/api/realtime-config")
def realtime_config():
    response = jsonify({"ok": True, "url": SUPABASE_URL, "key": SUPABASE_PUBLISHABLE_KEY})
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


@app.get("/api/latest-message-signature")
def latest_message_signature():
    try:
        payload = {"ok": True, "signature": latest_signature()}
        status = 200
    except Exception as error:
        payload = {"ok": False, "error": str(error)}
        status = 500
    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response, status


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
