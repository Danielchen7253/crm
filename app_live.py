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
  let audioContext = null;
  const title = document.title || 'CRM 客户工作台';

  function getAudioContext() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    if (!audioContext) audioContext = new AudioCtor();
    return audioContext;
  }

  function soundEnabled() {
    return window.localStorage && localStorage.getItem('crmSoundEnabled') === '1';
  }

  async function enableSound() {
    const ctx = getAudioContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') await ctx.resume();
    localStorage.setItem('crmSoundEnabled', '1');
    playAlertSound();
    return true;
  }

  function playAlertSound() {
    if (!soundEnabled()) return;
    const ctx = getAudioContext();
    if (!ctx || ctx.state === 'suspended') return;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);
    oscillator.frequency.setValueAtTime(660, ctx.currentTime + 0.11);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.11, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.24);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.26);
  }

  function vibrate() {
    if (navigator.vibrate) navigator.vibrate([90, 45, 90]);
  }

  function installSoundButton() {
    if (soundEnabled() || document.getElementById('crm-sound-toggle')) return;
    const button = document.createElement('button');
    button.id = 'crm-sound-toggle';
    button.type = 'button';
    button.textContent = '开启提醒音';
    button.setAttribute('aria-label', '开启新消息提醒音');
    button.style.position = 'fixed';
    button.style.right = '18px';
    button.style.bottom = '18px';
    button.style.zIndex = '9999';
    button.style.border = '1px solid rgba(37, 99, 235, 0.22)';
    button.style.background = '#2563eb';
    button.style.color = '#ffffff';
    button.style.borderRadius = '8px';
    button.style.padding = '10px 14px';
    button.style.fontSize = '13px';
    button.style.fontWeight = '700';
    button.style.boxShadow = '0 12px 26px rgba(37, 99, 235, 0.24)';
    button.style.cursor = 'pointer';
    button.addEventListener('click', async function () {
      const ok = await enableSound();
      if (!ok) return;
      button.textContent = '提醒音已开';
      setTimeout(function () { button.remove(); }, 900);
    });
    document.body.appendChild(button);
  }

  function refresh() {
    if (reloading) return;
    reloading = true;
    document.title = '有新消息 - ' + title.replace(/^有新消息 - /, '');
    playAlertSound();
    vibrate();
    setTimeout(function () { window.location.reload(); }, soundEnabled() ? 260 : 20);
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installSoundButton, { once: true });
  } else {
    installSoundButton();
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
        {"fields": "participants{id,name,profile_pic},messages.limit(3){id,message,from,to,created_time,attachments}", "limit": "1"},
    )
    imported = 0
    for conversation in conversations.get("data", []):
        people = [p for p in conversation.get("participants", {}).get("data", []) if p.get("id") != META_PAGE_ID]
        if not people:
            continue
        customer_id = crm_module.ensure_customer(people[0]["id"], people[0])
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
