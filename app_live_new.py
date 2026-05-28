"""Live Render entrypoint for the CRM workspace."""

import os
import threading
import time

import requests
from flask import jsonify, redirect, render_template_string, request, session

import app as crm_module
from app import app

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
META_PAGE_ID = os.getenv("META_PAGE_ID", "")
AUTO_SYNC_SECONDS = float(os.getenv("CRM_AUTO_SYNC_SECONDS", "2"))
AUTO_SYNC_STATE = {"started": False, "last_ok": None, "last_error": None, "runs": 0, "imported": 0}
CLOSED_TAG = "\u6210\u4ea4\u5ba2\u6237"
CRM_ADMIN_PASSWORD = os.getenv("CRM_ADMIN_PASSWORD", "")
CRM_SESSION_SECRET = os.getenv("CRM_SESSION_SECRET") or os.getenv("META_APP_SECRET") or os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "dev-crm-session-secret"
app.secret_key = CRM_SESSION_SECRET

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
  const title = document.title || 'CRM Customer Workspace';
  function soundEnabled() { return window.localStorage && localStorage.getItem('crmSoundEnabled') === '1'; }
  function getAudioContext() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    if (!audioContext) audioContext = new AudioCtor();
    return audioContext;
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
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.11);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.11, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.24);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.26);
  }
  function installSoundButton() {
    if (soundEnabled() || document.getElementById('crm-sound-toggle')) return;
    const button = document.createElement('button');
    button.id = 'crm-sound-toggle';
    button.type = 'button';
    button.textContent = '\u5f00\u542f\u63d0\u9192\u97f3';
    button.style.position = 'fixed';
    button.style.right = '18px';
    button.style.bottom = '18px';
    button.style.zIndex = '9999';
    button.style.border = '0';
    button.style.background = '#1f8a70';
    button.style.color = '#fff';
    button.style.borderRadius = '8px';
    button.style.padding = '10px 14px';
    button.style.fontWeight = '700';
    button.style.cursor = 'pointer';
    button.addEventListener('click', async function () {
      const ok = await enableSound();
      if (!ok) return;
      button.textContent = '\u63d0\u9192\u97f3\u5df2\u5f00';
      setTimeout(function () { button.remove(); }, 900);
    });
    document.body.appendChild(button);
  }
  function refresh(payload) {
    if (payload && payload.new && payload.new.direction === 'outbound') return;
    if (Date.now() < (window.__crmLocalSendUntil || 0)) return;
    if (reloading) return;
    reloading = true;
    document.title = '\u6709\u65b0\u6d88\u606f - ' + title.replace(/^\u6709\u65b0\u6d88\u606f - /, '');
    playAlertSound();
    if (navigator.vibrate) navigator.vibrate([90, 45, 90]);
    setTimeout(function () { window.location.reload(); }, soundEnabled() ? 260 : 20);
  }
  async function checkLatest() {
    if (checking || reloading) return;
    if (Date.now() < (window.__crmLocalSendUntil || 0)) return;
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
    } catch (e) { window.__crmRealtimeError = String(e && e.message ? e.message : e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installSoundButton, { once: true });
  else installSoundButton();
  startRealtime();
  setInterval(checkLatest, 1000);
  setTimeout(checkLatest, 300);
})();
</script>
"""

ASYNC_SEND_SCRIPT = """
<script>
(function () {
  if (window.__crmAsyncSend) return;
  window.__crmAsyncSend = true;
  function textNode(value) {
    return document.createTextNode(value || '');
  }
  function appendOutboundMessage(text, sentAt, pending) {
    const messages = document.querySelector('.messages');
    if (!messages) return null;
    const node = document.createElement('div');
    node.className = 'message outbound' + (pending ? ' sending' : '');
    const body = document.createElement('div');
    body.className = 'message-text';
    body.appendChild(textNode(text));
    const time = document.createElement('div');
    time.className = 'time';
    time.appendChild(textNode((pending ? '发送中' : '我们回复') + ' · ' + (sentAt || new Date().toISOString())));
    node.appendChild(body);
    node.appendChild(time);
    messages.appendChild(node);
    const chat = document.getElementById('chat-panel');
    if (chat) chat.scrollTop = chat.scrollHeight;
    return node;
  }
  function markMessage(node, label, sentAt) {
    if (!node) return;
    node.classList.remove('sending');
    const time = node.querySelector('.time');
    if (time) time.textContent = label + ' · ' + (sentAt || new Date().toISOString());
  }
  function install() {
    document.querySelectorAll('form.reply').forEach(function (form) {
      if (form.dataset.asyncSend === '1') return;
      form.dataset.asyncSend = '1';
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        const textarea = form.querySelector('textarea[name="text"]');
        const button = form.querySelector('button[type="submit"]');
        const text = (textarea && textarea.value || '').trim();
        if (!text) return;
        const payload = new FormData(form);
        const optimistic = appendOutboundMessage(text, '', true);
        const previousButtonText = button ? button.textContent : '';
        if (button) {
          button.disabled = true;
          button.textContent = '发送中';
        }
        if (textarea) textarea.value = '';
        window.__crmLocalSendUntil = Date.now() + 5000;
        try {
          const response = await fetch(form.action, {
            method: 'POST',
            body: payload,
            headers: {'X-Requested-With': 'fetch', 'Accept': 'application/json'}
          });
          const data = await response.json().catch(function () { return {}; });
          if (!response.ok || !data.ok) throw new Error(data.error || '发送失败');
          markMessage(optimistic, '我们回复', data.message && data.message.sent_at);
          form.querySelectorAll('input[name="ai_draft_id"]').forEach(function (input) { input.remove(); });
        } catch (error) {
          markMessage(optimistic, '发送失败');
          if (textarea) textarea.value = text;
          alert(error.message || '发送失败，请重试');
        } finally {
          if (button) {
            button.disabled = false;
            button.textContent = previousButtonText || '发送';
          }
        }
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
</script>
"""

LOGIN_TEMPLATE = """
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CRM 登录</title>
<style>:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#17202a;background:#f4f6f8}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px}.login{width:min(420px,100%);background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:24px;box-shadow:0 18px 48px rgba(15,23,42,.08)}h1{margin:0 0 8px;font-size:24px}.hint{margin:0 0 18px;color:#6a7682;font-size:14px}label{display:grid;gap:8px;font-size:13px;font-weight:700;color:#3e4b57}input{width:100%;border:1px solid #cfd7e2;border-radius:8px;padding:12px;font:inherit;margin-bottom:14px}button{width:100%;border:0;border-radius:8px;background:#1f8a70;color:#fff;font-weight:800;font-size:15px;min-height:44px;cursor:pointer}.error{background:#fff2f0;border:1px solid #ffccc7;color:#a8071a;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13px}</style>
</head><body><form class="login" method="post"><h1>{{ title }}</h1><p class="hint">{{ subtitle }}</p>{% if error %}<div class="error">{{ error }}</div>{% endif %}<label>密码<input type="password" name="password" autocomplete="current-password" autofocus required></label><button type="submit">进入</button></form></body></html>
"""

SETTINGS_TEMPLATE = """
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>系统设置</title>
<style>:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#17202a;background:#f4f6f8}*{box-sizing:border-box}body{margin:0}.top{height:58px;background:#16202a;color:#fff;display:flex;align-items:center;gap:12px;padding:0 16px}.back{color:#fff;text-decoration:none;font-weight:800}.wrap{max-width:980px;margin:0 auto;padding:20px 16px;display:grid;gap:14px}.card{background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:16px}h1{margin:0;font-size:18px}h2{margin:0 0 8px;font-size:16px}.muted{color:#6a7682;font-size:13px;line-height:1.45}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}@media(max-width:700px){.grid{grid-template-columns:1fr}.wrap{padding:14px}}</style>
</head><body><header class="top"><a class="back" href="/">&lsaquo; CRM</a><h1>系统设置</h1></header><main class="wrap"><div class="card"><h2>系统管理</h2><div class="muted">这里会作为后续配置中心：固定回复、AI训练资料、自动回复开关、Meta / WhatsApp 接口状态、系统权限。</div></div><section class="grid"><div class="card"><h2>固定回复</h2><div class="muted">下一步把发货时间、提货地址、售后话术集中在这里编辑。</div></div><div class="card"><h2>AI 训练资料</h2><div class="muted">后面可以上传你的谈判话术、常见问题、产品资料，让 AI 学你的回复方式。</div></div><div class="card"><h2>渠道配置</h2><div class="muted">管理 Messenger、WhatsApp、Marketplace、Instagram 等接入状态。</div></div><div class="card"><h2>安全</h2><div class="muted">当前 CRM 首页和系统设置均已启用密码锁。</div></div></section></main></body></html>
"""


def wants_json_response():
    return request.headers.get("X-Requested-With") == "fetch" or "application/json" in request.headers.get("Accept", "")


def password_matches(value):
    return bool(value) and value == CRM_ADMIN_PASSWORD


def is_public_path(path):
    return (
        path in {"/login", "/health"}
        or path.startswith("/webhooks/")
        or path.startswith("/data-deletion")
    )


@app.before_request
def require_crm_unlock():
    if is_public_path(request.path):
        return None
    if session.get("crm_unlocked"):
        return None
    if wants_json_response():
        return jsonify({"ok": False, "error": "CRM is locked."}), 401
    return redirect(f"/login?next={request.full_path}", code=303)


@app.route("/login", methods=["GET", "POST"])
def crm_login():
    error = ""
    if request.method == "POST":
        if password_matches(request.form.get("password", "")):
            session["crm_unlocked"] = True
            session.pop("settings_unlocked", None)
            next_url = request.args.get("next") or "/"
            return redirect(next_url if next_url.startswith("/") else "/", code=303)
        error = "密码不正确"
    return render_template_string(LOGIN_TEMPLATE, title="CRM 登录", subtitle="输入密码后才能查看客户和发送消息。", error=error)


@app.get("/logout")
def crm_logout():
    session.clear()
    return redirect("/login", code=303)



def supabase_headers():
    return {"apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}", "Content-Type": "application/json"}


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
        {"fields": "participants{id,name,profile_pic,picture},messages.limit(3){id,message,from,to,created_time,attachments}", "limit": "1"},
    )
    imported = 0
    for conversation in conversations.get("data", []):
        people = [p for p in conversation.get("participants", {}).get("data", []) if p.get("id") != META_PAGE_ID]
        if not people:
            continue
        customer_id, _ = crm_module.ensure_customer(people[0]["id"], people[0])
        for message in conversation.get("messages", {}).get("data", []):
            direction = "outbound" if message.get("from", {}).get("id") == META_PAGE_ID else "inbound"
            saved = crm_module.save_message(customer_id, message.get("id"), direction, message.get("message"), message.get("attachments", {}).get("data", []), message, message.get("created_time"))
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


def customer_tags(customer):
    tags = customer.get("tags") or []
    return tags if isinstance(tags, list) else []


def is_closed_customer(customer):
    return CLOSED_TAG in customer_tags(customer)


def filtered_customers(customers, view):
    if view == "closed":
        return [customer for customer in customers if is_closed_customer(customer)]
    return customers


def load_fixed_reply_rules(active_only=False):
    try:
        params = {"select": "*", "order": "sort_order.asc,created_at.asc"}
        if active_only:
            params["is_active"] = "eq.true"
        rows = crm_module.sb_get_all("ai_fixed_reply_rules", params, page_size=200, max_rows=1000)
        if rows:
            return [{"id": row.get("id"), "category": row.get("category"), "title": row.get("title") or row.get("category"), "keywords": row.get("keywords") or [], "reply_text": row.get("reply_text") or "", "reply": row.get("reply_text") or "", "confidence": 0.98, "is_active": row.get("is_active", True), "sort_order": row.get("sort_order") or 100} for row in rows]
    except requests.RequestException:
        pass
    return crm_module.FIXED_REPLY_RULES if active_only else [{**rule, "title": rule["category"], "reply_text": rule["reply"], "is_active": True} for rule in crm_module.FIXED_REPLY_RULES]


def fixed_reply_for(text):
    normalized = (text or "").lower()
    matches = []
    for rule in load_fixed_reply_rules(active_only=True):
        if any(str(keyword).lower() in normalized for keyword in (rule.get("keywords") or [])):
            matches.append(rule)
    if not matches:
        return None
    return {"source": "rules", "category": "+".join(rule["category"] for rule in matches), "confidence": max(rule["confidence"] for rule in matches), "draft_text": "\n\n".join(rule.get("reply_text") or rule.get("reply") or "" for rule in matches)}


crm_module.fixed_reply_for = fixed_reply_for


def format_last_message_time(value):
    if not value:
        return ""
    return str(value).replace("T", " ")[:16]


def message_preview(message):
    text = (message.get("text") or "").strip()
    if text:
        return " ".join(text.split())
    attachments = message.get("attachments") or []
    if attachments:
        return "附件"
    return message.get("message_type") or "消息"


def attach_last_message_preview(customers):
    if not customers:
        return
    ids = {customer["id"] for customer in customers}
    rows = crm_module.sb_get(
        "messages",
        {
            "select": "customer_id,text,message_type,attachments,sent_at",
            "order": "sent_at.desc",
            "limit": "5000",
        },
    )
    seen = set()
    for row in rows:
        customer_id = row.get("customer_id")
        if customer_id not in ids or customer_id in seen:
            continue
        seen.add(customer_id)
        for customer in customers:
            if customer["id"] == customer_id:
                customer["last_message_preview"] = message_preview(row)
                customer["last_message_time_short"] = format_last_message_time(row.get("sent_at"))
                break
    for customer in customers:
        customer.setdefault("last_message_preview", "")
        customer.setdefault("last_message_time_short", format_last_message_time(customer.get("last_message_at")))


def load_workspace(selected_id):
    view = request.args.get("view", "unclassified")
    customers = crm_module.sb_get_all(
        "customers",
        {"select": "id,display_name,source,first_seen_at,last_seen_at,last_message_at,profile_pic_url,tags,locale,timezone,gender,metadata", "order": "last_message_at.desc.nullslast"},
        page_size=1000,
        max_rows=5000,
    )
    for customer in customers:
        customer["tags"] = customer_tags(customer)
    attach_last_message_preview(customers)
    customer_pool = filtered_customers(customers, view)
    if view == "ai":
        selected_id = None
    elif customer_pool and not selected_id:
        selected_id = customer_pool[0]["id"]
    selected = next((customer for customer in customer_pool if customer["id"] == selected_id), None) if selected_id else None
    messages = []
    if selected:
        newest_messages = crm_module.sb_get("messages", {"customer_id": f"eq.{selected_id}", "select": "id,direction,text,message_type,attachments,sent_at", "order": "sent_at.desc", "limit": "500"})
        messages = [crm_module.decorate_message(message) for message in reversed(newest_messages)]
    return customers, customer_pool, selected, messages, selected_id, view


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


@app.route("/settings", methods=["GET", "POST"])
def system_settings():
    error = ""
    if request.method == "POST":
        if password_matches(request.form.get("password", "")):
            session["settings_unlocked"] = True
            return redirect("/settings", code=303)
        error = "密码不正确"
    if not session.get("settings_unlocked"):
        return render_template_string(LOGIN_TEMPLATE, title="系统设置", subtitle="为了防止误改配置，进入系统设置需要再次输入密码。", error=error)
    return render_template_string(SETTINGS_TEMPLATE)


@app.post("/customers/<customer_id>/tags/closed")
def set_closed_customer(customer_id):
    action = request.form.get("action", "add")
    rows = crm_module.sb_get("customers", {"id": f"eq.{customer_id}", "select": "tags", "limit": "1"})
    tags = rows[0].get("tags") if rows else []
    tags = tags if isinstance(tags, list) else []
    if action == "remove":
        tags = [tag for tag in tags if tag != CLOSED_TAG]
        view = "unclassified"
    else:
        if CLOSED_TAG not in tags:
            tags.append(CLOSED_TAG)
        view = "closed"
    crm_module.sb_patch("customers", {"tags": tags, "updated_at": crm_module.now_iso()}, {"id": f"eq.{customer_id}"})
    return redirect(f"/?view={view}&customer={customer_id}", code=303)


@app.post("/admin/ai/fixed-replies")
def save_fixed_reply_rule():
    rule_id = request.form.get("id", "").strip()
    title = request.form.get("title", "").strip()
    category = request.form.get("category", "").strip() or title.lower().replace(" ", "_")
    keywords = [item.strip() for item in request.form.get("keywords", "").replace("\n", ",").split(",") if item.strip()]
    reply_text = request.form.get("reply_text", "").strip()
    is_active = request.form.get("is_active") == "1"
    if not title or not category or not reply_text:
        return redirect("/?view=ai", code=303)
    payload = {"category": category, "title": title, "keywords": keywords, "reply_text": reply_text, "is_active": is_active, "updated_at": crm_module.now_iso()}
    if rule_id:
        crm_module.sb_patch("ai_fixed_reply_rules", payload, {"id": f"eq.{rule_id}"})
    else:
        payload["sort_order"] = 100
        crm_module.sb_post("ai_fixed_reply_rules", payload)
    return redirect("/?view=ai", code=303)


@app.after_request
def inject_realtime_script(response):
    if request.method != "GET" or request.path != "/" or "text/html" not in response.headers.get("Content-Type", "").lower():
        return response
    body = response.get_data(as_text=True)
    if "__crmRealtimeRefresh" in body:
        return response
    scripts = ASYNC_SEND_SCRIPT + REALTIME_SCRIPT
    body = body.replace("</body>", scripts + "</body>") if "</body>" in body else body + scripts
    response.set_data(body)
    response.headers["Content-Length"] = str(len(response.get_data()))
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


TEMPLATE = """
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CRM 客户工作台</title>
<style>
:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#17202a;background:#f4f6f8}*{box-sizing:border-box}body{margin:0}.app{display:grid;grid-template-columns:104px 256px minmax(0,1fr);height:100vh;min-height:640px}.nav{background:#16202a;color:#dbe3ec;display:flex;flex-direction:column;padding:14px 10px;gap:10px}.nav-title{color:#fff;font-weight:800;font-size:15px;padding:6px 4px 12px}.nav-link{display:grid;gap:4px;color:inherit;text-decoration:none;border-radius:8px;padding:10px 8px;font-size:12px;line-height:1.25}.nav-link:hover,.nav-link.active{background:#233241;color:#fff}.nav-count{color:#9fb0bf;font-size:11px}.middle{background:#fff;border-right:1px solid #d8dee8;overflow:auto}.middle-head{position:sticky;top:0;z-index:2;background:#fff;min-height:56px;display:grid;align-content:center;padding:10px 16px;border-bottom:1px solid #edf0f4}.middle-title{font-weight:800;font-size:15px}.middle-sub{color:#6a7682;font-size:12px;margin-top:2px}.customer,.rule-row{display:grid;grid-template-columns:42px minmax(0,1fr);gap:10px;align-items:center;min-height:64px;padding:10px 14px;border-bottom:1px solid #edf0f4;text-decoration:none;color:inherit}.rule-row{grid-template-columns:minmax(0,1fr)}.customer:hover,.rule-row:hover{background:#f8fafb}.customer.active{background:#eef7f4;border-left:4px solid #1f8a70;padding-left:10px}.avatar{width:42px;height:42px;border-radius:50%;background:#1f8a70;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;overflow:hidden;flex:none}.avatar.large{width:72px;height:72px;font-size:24px}.avatar img{width:100%;height:100%;object-fit:cover}.customer-name,.rule-title{font-size:14px;font-weight:700;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rule-meta{color:#6a7682;font-size:12px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.work{display:flex;flex-direction:column;min-width:0;height:100vh;overflow:hidden}.mobile-back,.mobile-menu{display:none}.profile,.settings-head{background:#fff;border-bottom:1px solid #d8dee8;padding:18px 24px 16px}.profile-main{display:flex;align-items:center;gap:16px}.profile h1,.settings-head h1{margin:0 0 8px;font-size:24px;line-height:1.2}.profile-actions{margin-left:auto}.pill-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.pill{border:1px solid #d8dee8;background:#f8fafb;border-radius:999px;padding:5px 10px;font-size:12px;color:#3e4b57}.tag{background:#eef7f4;border-color:#c7d7d2;color:#17634f;font-weight:700}.chat{flex:1;overflow:auto;padding:18px 24px}.messages{display:flex;flex-direction:column;gap:10px;max-width:860px}.message{max-width:78%;padding:11px 13px;border:1px solid #d8dee8;border-radius:8px;background:#fff;line-height:1.45;font-size:14px;overflow-wrap:anywhere}.message.outbound{align-self:flex-end;background:#eaf2ff;border-color:#c9dcff}.message.sending{opacity:.72}.message.inbound{align-self:flex-start}.message-text{white-space:pre-wrap}.attachment-list{display:grid;gap:8px;margin-top:8px}.attachment-image{display:block;max-width:min(360px,100%);max-height:420px;border-radius:8px;border:1px solid #d8dee8;object-fit:contain;background:#f8fafb}.attachment-audio{width:min(360px,100%);height:42px;display:block}.attachment-file{display:inline-flex;min-height:34px;border:1px solid #c7d7d2;border-radius:8px;color:#17634f;background:#f7fbfa;padding:7px 10px;font-size:13px;text-decoration:none;word-break:break-all}.time{color:#6a7682;font-size:11px;margin-top:6px}.reply{display:grid;grid-template-columns:minmax(0,1fr) 108px;gap:12px;align-items:stretch;background:#fff;border-top:1px solid #d8dee8;padding:16px 24px}.reply-body{min-width:0;display:grid;gap:8px}.ai-draft{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:#3e4b57;font-size:12px}.ai-badge{border:1px solid #c7d7d2;background:#eef7f4;color:#17634f;border-radius:999px;padding:4px 9px;font-weight:700}.ai-note{color:#6a7682}textarea,input{width:100%;border:1px solid #cfd7e2;border-radius:8px;padding:10px 12px;font:inherit;line-height:1.4;background:#fff}textarea{min-height:104px;max-height:220px;resize:vertical}label{display:grid;gap:6px;color:#3e4b57;font-size:12px;font-weight:700}button{border:0;border-radius:8px;background:#1f8a70;color:#fff;font-weight:700;cursor:pointer;font-size:14px;padding:0 14px;min-height:40px}.secondary-button{background:#e8edf3;color:#17202a}.settings{flex:1;overflow:auto;padding:18px 24px;display:grid;gap:18px;align-content:start;max-width:980px}.settings-form{display:grid;gap:12px;border-bottom:1px solid #d8dee8;padding-bottom:18px}.settings-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.checkline{display:flex;align-items:center;gap:8px;font-size:13px;color:#3e4b57}.checkline input{width:auto}.empty{margin:24px;background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:22px}@media(max-width:920px){.app{grid-template-columns:82px 138px minmax(0,1fr)}.nav{padding:10px 6px}.nav-link{font-size:11px;padding:8px 6px}.customer{grid-template-columns:42px;justify-items:center;padding:10px}.customer-name{font-size:11px;text-align:center;white-space:normal;max-height:2.5em}.profile,.settings-head{padding:14px}.chat,.settings{padding:14px}.reply{grid-template-columns:1fr;padding:12px 14px}.settings-grid{grid-template-columns:1fr}}@media(max-width:700px){html,body{height:100%;overflow:hidden;background:#fff}.app{display:block;height:100dvh;min-height:0;overflow:hidden}.nav{display:none}.mobile-menu{display:block;position:fixed;right:10px;top:10px;z-index:80}.mobile-menu summary{list-style:none;width:42px;height:42px;margin-left:auto;border-radius:12px;background:#16202a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;box-shadow:0 8px 24px rgba(15,23,42,.18);cursor:pointer}.mobile-menu summary::-webkit-details-marker{display:none}.mobile-menu-panel{margin-top:8px;min-width:184px;background:#16202a;color:#dbe3ec;border-radius:12px;padding:8px;box-shadow:0 14px 34px rgba(15,23,42,.28);display:grid;gap:6px}.mobile-menu-panel .nav-link{display:grid}.mobile-menu-panel .nav-link:hover,.mobile-menu-panel .nav-link.active{background:#233241;color:#fff}.nav-title{display:none}.nav-link{min-width:0;align-content:center;border-radius:10px;padding:9px 10px;font-size:12px}.nav-count{font-size:10px}.middle{height:100dvh;border-right:0;overflow:auto;background:#fff}.middle-head{min-height:62px;padding:12px 64px 12px 16px}.middle-title{font-size:18px}.middle-sub{font-size:12px}.customer,.rule-row{grid-template-columns:48px minmax(0,1fr);justify-items:start;min-height:70px;padding:11px 16px;gap:12px}.customer.active{background:#fff;border-left:0;padding-left:16px}.avatar{width:48px;height:48px}.customer-name,.rule-title{font-size:15px;text-align:left;white-space:nowrap;max-height:none}.customer-info{min-width:0}.source-line{justify-content:flex-start}.app:not(.mobile-chat-open) .work{display:none}.app.mobile-chat-open .middle{display:none}.app.mobile-chat-open{position:fixed;inset:0;width:100%;height:var(--crm-vvh,100dvh);overflow:hidden}.app.mobile-chat-open .work{display:flex;position:fixed;left:0;right:0;top:var(--crm-vvtop,0px);height:var(--crm-vvh,100dvh);max-height:var(--crm-vvh,100dvh);overflow:hidden;background:#f4f6f8}.profile,.settings-head{position:sticky;top:0;z-index:10;padding:10px 12px;border-bottom:1px solid #d8dee8}.app.mobile-chat-open .profile{position:fixed;left:0;right:0;top:var(--crm-vvtop,0px);z-index:30;flex:0 0 auto}.mobile-back{display:inline-flex;align-items:center;justify-content:center;width:34px;height:44px;color:#17634f;text-decoration:none;font-weight:800;font-size:18px;flex:none}.profile-main{align-items:center;gap:8px}.avatar.large{width:44px;height:44px;font-size:16px}.profile h1,.settings-head h1{font-size:17px;margin:0 0 6px}.pill-row{flex-wrap:nowrap;overflow:auto;gap:6px;margin-top:6px;padding-bottom:2px}.pill{white-space:nowrap;font-size:11px;padding:4px 8px}.profile-actions{margin-left:0;align-self:flex-start}.profile-actions button{min-height:34px;padding:0 10px;font-size:12px}.app.mobile-chat-open .chat{position:fixed;left:0;right:0;top:calc(var(--crm-vvtop,0px) + var(--crm-profile-h,74px));bottom:calc(var(--crm-keyboard-inset,0px) + var(--crm-reply-h,168px));min-height:0;padding:12px;overflow:auto;-webkit-overflow-scrolling:touch}.chat{flex:1 1 auto;min-height:0;padding:12px;overflow:auto;-webkit-overflow-scrolling:touch}.messages{max-width:none;gap:8px}.message{max-width:86%;font-size:14px;padding:10px 12px}.attachment-image{max-width:100%;max-height:320px}.attachment-audio{width:100%}.reply{grid-template-columns:1fr;gap:8px;flex:0 0 auto;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:#fff}.app.mobile-chat-open .reply{position:fixed;left:0;right:0;bottom:var(--crm-keyboard-inset,0px);z-index:30}.reply textarea{min-height:86px;max-height:150px}.reply button{min-height:42px}.settings{height:auto;max-width:none;padding:12px;overflow:auto}.settings-form{background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:12px}.empty{margin:16px;padding:18px}}
</style></head><body><details class="mobile-menu"><summary aria-label="Menu">&#9776;</summary><div class="mobile-menu-panel"><a class="nav-link {% if view == 'unclassified' %}active{% endif %}" href="/?view=unclassified"><span>&#25152;&#26377;&#23458;&#25143;</span><span class="nav-count">{{ customers|length }}</span></a><a class="nav-link {% if view == 'closed' %}active{% endif %}" href="/?view=closed"><span>&#25104;&#20132;&#23458;&#25143;</span><span class="nav-count">{{ closed_count }}</span></a><a class="nav-link {% if view == 'ai' %}active{% endif %}" href="/?view=ai"><span>AI&#22238;&#22797;&#35774;&#32622;</span><span class="nav-count">{{ fixed_reply_rules|length }}</span></a><a class="nav-link" href="/settings"><span>&#31995;&#32479;&#35774;&#32622;</span><span class="nav-count">lock</span></a></div></details><main class="app {% if mobile_chat_open %}mobile-chat-open{% endif %}"><aside class="nav"><div class="nav-title">CRM</div><a class="nav-link {% if view == 'unclassified' %}active{% endif %}" href="/?view=unclassified"><span>未分类客户</span><span class="nav-count">{{ unclassified_count }}</span></a><a class="nav-link {% if view == 'closed' %}active{% endif %}" href="/?view=closed"><span>成交客户</span><span class="nav-count">{{ closed_count }}</span></a><a class="nav-link {% if view == 'ai' %}active{% endif %}" href="/?view=ai"><span>AI回复设置</span><span class="nav-count">{{ fixed_reply_rules|length }}</span></a><a class="nav-link" href="/settings"><span>&#31995;&#32479;&#35774;&#32622;</span><span class="nav-count">lock</span></a></aside><aside class="middle">{% if view == 'ai' %}<div class="middle-head"><div class="middle-title">固定回复</div><div class="middle-sub">匹配后自动进输入框</div></div>{% for rule in fixed_reply_rules %}<a class="rule-row" href="#rule-{{ rule.id or loop.index }}"><div><div class="rule-title">{{ rule.title }}</div><div class="rule-meta">{{ '启用' if rule.is_active else '停用' }} · {{ rule.keywords|join(', ') }}</div></div></a>{% else %}<div class="empty">还没有固定回复</div>{% endfor %}{% else %}<div class="middle-head"><div class="middle-title">{% if view == 'closed' %}&#25104;&#20132;&#23458;&#25143;{% else %}&#25152;&#26377;&#23458;&#25143;{% endif %}</div><div class="middle-sub">{{ customer_pool|length }} / {{ customers|length }}</div></div>{% for customer in customer_pool %}<a class="customer {% if customer.id == selected_customer_id %}active{% endif %}" href="/?view={{ view }}&customer={{ customer.id }}" title="{{ customer.display_name or '未命名客户' }}"><div class="avatar">{% if customer.profile_pic_url %}<img src="{{ customer.profile_pic_url }}" alt="">{% else %}{{ (customer.display_name or 'C')[:1] }}{% endif %}</div><div class="customer-name">{{ customer.display_name or '未命名客户' }}</div></a>{% else %}<div class="empty">这个客户池还是空的</div>{% endfor %}{% endif %}</aside><section class="work">{% if view == 'ai' %}<header class="settings-head"><h1>AI回复设置</h1><div class="middle-sub">固定问题先用这里的话术，其他问题再交给 AI 生成草稿。</div></header><section class="settings">{% for rule in fixed_reply_rules %}<form class="settings-form" id="rule-{{ rule.id or loop.index }}" method="post" action="/admin/ai/fixed-replies"><input type="hidden" name="id" value="{{ rule.id or '' }}"><div class="settings-grid"><label>名称<input name="title" value="{{ rule.title }}" required></label><label>分类代码<input name="category" value="{{ rule.category }}" required></label></div><label>匹配关键词<textarea name="keywords">{{ rule.keywords|join(', ') }}</textarea></label><label>回复内容<textarea name="reply_text" required>{{ rule.reply_text }}</textarea></label><label class="checkline"><input type="checkbox" name="is_active" value="1" {% if rule.is_active %}checked{% endif %}> 启用这条固定回复</label><div><button type="submit">保存</button></div></form>{% endfor %}<form class="settings-form" method="post" action="/admin/ai/fixed-replies"><div class="settings-grid"><label>新增名称<input name="title" placeholder="例：库存问题"></label><label>分类代码<input name="category" placeholder="inventory"></label></div><label>匹配关键词<textarea name="keywords" placeholder="stock, inventory, 有货"></textarea></label><label>回复内容<textarea name="reply_text"></textarea></label><label class="checkline"><input type="checkbox" name="is_active" value="1" checked> 启用</label><div><button type="submit">新增固定回复</button></div></form></section>{% elif selected_customer %}<header class="profile"><div class="profile-main"><a class="mobile-back" href="/?view={{ view }}" aria-label="Back">&lsaquo;</a><div class="avatar large">{% if selected_customer.profile_pic_url %}<img src="{{ selected_customer.profile_pic_url }}" alt="">{% else %}{{ (selected_customer.display_name or 'C')[:1] }}{% endif %}</div><div><h1>{{ selected_customer.display_name or '未命名客户' }}</h1><div class="pill-row"><span class="pill tag">{{ selected_customer.source }}</span><span class="pill">第一次联系 {{ selected_customer.first_seen_at or '-' }}</span><span class="pill">最近互动 {{ selected_customer.last_seen_at or '-' }}</span><span class="pill">最后消息 {{ selected_customer.last_message_at or '-' }}</span><span class="pill">语言 {{ selected_customer.locale or '-' }}</span>{% for tag in selected_customer.tags %}<span class="pill tag">{{ tag }}</span>{% endfor %}</div></div><div class="profile-actions"><form method="post" action="/customers/{{ selected_customer.id }}/tags/closed">{% if '成交客户' in selected_customer.tags %}<input type="hidden" name="action" value="remove"><button class="secondary-button" type="submit">移出成交</button>{% else %}<input type="hidden" name="action" value="add"><button type="submit">标记成交</button>{% endif %}</form></div></div></header><section class="chat" id="chat-panel"><div class="messages">{% for message in selected_messages %}<div class="message {{ message.direction }}">{% if message.text %}<div class="message-text">{{ message.text }}</div>{% endif %}{% if message.image_attachments or message.audio_attachments or message.file_attachments %}<div class="attachment-list">{% for item in message.image_attachments %}<a href="{{ item.url }}" target="_blank" rel="noopener"><img class="attachment-image" src="{{ item.url }}" alt="客户发送的图片" loading="lazy"></a>{% endfor %}{% for item in message.audio_attachments %}<audio class="attachment-audio" controls preload="metadata" src="{{ item.url }}"></audio>{% endfor %}{% for item in message.file_attachments %}<a class="attachment-file" href="{{ item.url }}" target="_blank" rel="noopener">打开附件</a>{% endfor %}</div>{% endif %}{% if not message.text and not message.has_attachments %}<div>[附件或系统消息]</div>{% endif %}<div class="time">{{ '客户发来' if message.direction == 'inbound' else '我们回复' }} · {{ message.sent_at }}</div></div>{% else %}<div class="empty">这个客户还没有可显示的聊天记录。</div>{% endfor %}</div></section><form class="reply" method="post" action="/customers/{{ selected_customer.id }}/messages"><div class="reply-body">{% if ai_draft %}<div class="ai-draft">{% if ai_draft.status == 'learning_only' %}<span class="ai-badge">AI学习中</span><span>{{ ai_draft.category }}</span><span class="ai-note">这类问题暂时不自动生成回复，发送后只用于学习</span>{% else %}<span class="ai-badge">AI建议</span><span>{{ ai_draft.category }}</span><span class="ai-note">置信度 {{ '%.0f'|format((ai_draft.confidence or 0) * 100) }}%，发送前可修改</span>{% endif %}</div><input type="hidden" name="ai_draft_id" value="{{ ai_draft.id }}">{% else %}<div class="ai-draft"><span class="ai-badge">AI&#25552;&#31034;</span><span class="ai-note">&#25910;&#21040;&#23458;&#25143;&#28040;&#24687;&#21518;&#65292;&#36825;&#37324;&#20250;&#26174;&#31034; AI &#22238;&#22797;&#24314;&#35758;</span></div>{% endif %}<textarea name="text" placeholder="输入要发给客户的消息" required>{{ ai_draft.draft_text if ai_draft else '' }}</textarea></div><button type="submit">发送</button></form>{% else %}<div class="empty">请选择客户</div>{% endif %}</section></main><script>(function(){const chat=document.getElementById('chat-panel');function syncMobileChatFrame(){const app=document.querySelector('.app.mobile-chat-open');if(!app)return;const root=document.documentElement;const profile=document.querySelector('.profile');const reply=document.querySelector('.reply');const vv=window.visualViewport;const layoutH=Math.max(document.documentElement.clientHeight||0,window.innerHeight||0);const vvTop=vv?Math.max(0,vv.offsetTop||0):0;const vvH=vv?Math.max(260,vv.height||layoutH):layoutH;const keyboard=Math.max(0,layoutH-vvH-vvTop);root.style.setProperty('--crm-vvtop',vvTop+'px');root.style.setProperty('--crm-vvh',vvH+'px');root.style.setProperty('--crm-keyboard-inset',keyboard+'px');if(profile)root.style.setProperty('--crm-profile-h',profile.offsetHeight+'px');if(reply)root.style.setProperty('--crm-reply-h',reply.offsetHeight+'px');window.scrollTo(0,0);document.body.scrollTop=0;document.documentElement.scrollTop=0;}function s(){if(chat)chat.scrollTop=chat.scrollHeight;syncMobileChatFrame();}function install(){s();window.addEventListener('resize',syncMobileChatFrame,{passive:true});window.addEventListener('orientationchange',function(){setTimeout(syncMobileChatFrame,250);},{passive:true});if(window.visualViewport){visualViewport.addEventListener('resize',syncMobileChatFrame,{passive:true});visualViewport.addEventListener('scroll',syncMobileChatFrame,{passive:true});}document.addEventListener('focusin',function(event){if(event.target&&event.target.closest&&event.target.closest('.reply')){syncMobileChatFrame();setTimeout(syncMobileChatFrame,80);setTimeout(syncMobileChatFrame,260);}},true);}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();window.addEventListener('load',s,{once:true});})();</script></body></html>
"""


def live_dashboard():
    if not crm_module.database_ready():
        return "CRM is online, but database is not configured yet."
    customers, customer_pool, selected, messages, selected_id, view = load_workspace(request.args.get("customer"))
    fixed_reply_rules = load_fixed_reply_rules(active_only=False)
    return render_template_string(
        TEMPLATE,
        customers=customers,
        customer_pool=customer_pool,
        selected_customer=selected,
        selected_messages=messages,
        selected_customer_id=selected_id,
        mobile_chat_open=bool(request.args.get("customer")) or view == "ai",
        ai_draft=crm_module.load_ai_draft(selected, messages),
        view=view,
        fixed_reply_rules=fixed_reply_rules,
        unclassified_count=len(filtered_customers(customers, "unclassified")),
        closed_count=len(filtered_customers(customers, "closed")),
    )


app.view_functions["dashboard"] = live_dashboard
start_auto_sync()
