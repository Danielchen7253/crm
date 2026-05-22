"""Render live entrypoint."""

import os
import queue
import threading
import time

import requests
from flask import Response, jsonify, request, stream_with_context

import app as crm_module
from app import app

GRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v21.0")
META_PAGE_ID = os.getenv("META_PAGE_ID", "")
META_PAGE_ACCESS_TOKEN = os.getenv("META_PAGE_ACCESS_TOKEN", "")
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
MESSENGER_FIELDS = "messages,message_echoes,messaging_postbacks,message_deliveries,message_reads"

CLIENTS = set()
CLIENTS_LOCK = threading.Lock()
EVENT_STATE = {"version": 0, "last_event": None}
ORIGINAL_SAVE_MESSAGE = crm_module.save_message

EVENT_REFRESH_SCRIPT = """
<script>
(function () {
  if (window.__crmEventRefreshInstalled) return;
  window.__crmEventRefreshInstalled = true;
  const originalTitle = document.title || 'CRM 客户工作台';

  function markNewMessage() {
    document.title = '有新消息 - ' + originalTitle.replace(/^有新消息 - /, '');
    window.location.reload();
  }

  function connect() {
    const events = new EventSource('/events');
    events.addEventListener('new_message', markNewMessage);
    events.onerror = function () {
      events.close();
      setTimeout(connect, 2000);
    };
  }

  if (window.EventSource) connect();
})();
</script>
"""


def graph_url(path):
    return f"https://graph.facebook.com/{GRAPH_API_VERSION}/{path.lstrip('/')}"


def broadcast_new_message():
    EVENT_STATE["version"] += 1
    EVENT_STATE["last_event"] = time.time()
    payload = str(EVENT_STATE["version"])
    with CLIENTS_LOCK:
        clients = list(CLIENTS)
    for client in clients:
        try:
            client.put_nowait(payload)
        except Exception:
            pass


def save_message_and_notify(*args, **kwargs):
    saved = ORIGINAL_SAVE_MESSAGE(*args, **kwargs)
    if saved:
        broadcast_new_message()
    return saved


crm_module.save_message = save_message_and_notify


@app.get("/events")
def crm_events():
    client = queue.Queue(maxsize=10)
    with CLIENTS_LOCK:
        CLIENTS.add(client)

    def stream():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    version = client.get(timeout=20)
                    yield f"event: new_message\ndata: {version}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            with CLIENTS_LOCK:
                CLIENTS.discard(client)

    response = Response(stream_with_context(stream()), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    return response


@app.get("/api/events/status")
def event_status():
    with CLIENTS_LOCK:
        client_count = len(CLIENTS)
    return jsonify({"ok": True, "event_state": EVENT_STATE, "connected_clients": client_count})


@app.after_request
def inject_event_refresh(response):
    if request.method != "GET" or request.path != "/":
        return response
    content_type = response.headers.get("Content-Type", "")
    if "text/html" not in content_type.lower():
        return response
    body = response.get_data(as_text=True)
    if "__crmEventRefreshInstalled" in body:
        return response
    if "__crmAutoRefreshInstalled" in body:
        start = body.find("<script>\n(function () {\n  if (window.__crmAutoRefreshInstalled)")
        end = body.find("</script>", start)
        if start != -1 and end != -1:
            body = body[:start] + body[end + len("</script>"):]
    if "</body>" in body:
        body = body.replace("</body>", EVENT_REFRESH_SCRIPT + "</body>")
    else:
        body += EVENT_REFRESH_SCRIPT
    response.set_data(body)
    response.headers["Content-Length"] = str(len(response.get_data()))
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


@app.post("/admin/test/new-message-event")
def test_new_message_event():
    broadcast_new_message()
    return jsonify({"ok": True, "event_state": EVENT_STATE})


@app.post("/admin/meta/subscribe-page")
def subscribe_meta_page():
    if not META_PAGE_ID or not META_PAGE_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "META_PAGE_ID or META_PAGE_ACCESS_TOKEN is missing"}), 400

    subscribe_response = requests.post(
        graph_url(f"{META_PAGE_ID}/subscribed_apps"),
        params={"access_token": META_PAGE_ACCESS_TOKEN, "subscribed_fields": MESSENGER_FIELDS},
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

    response = requests.get(graph_url(f"{META_PAGE_ID}/subscribed_apps"), params={"access_token": META_PAGE_ACCESS_TOKEN}, timeout=30)
    body = response.json() if response.content else {}
    return jsonify({"ok": response.ok, "status": response.status_code, "response": body}), 200 if response.ok else 400
