import os
from flask import Flask, jsonify, render_template_string, request, Response, abort

app = Flask(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
META_VERIFY_TOKEN = os.getenv("META_VERIFY_TOKEN", "")


def database_ready():
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


@app.get("/")
def home():
    return render_template_string(SETUP_TEMPLATE, database_ready=database_ready())


@app.get("/health")
def health():
    return jsonify({"ok": True, "database_configured": database_ready()})


@app.get("/webhooks/meta")
def meta_webhook_verify():
    if request.args.get("hub.mode") == "subscribe" and request.args.get("hub.verify_token") == META_VERIFY_TOKEN:
        return Response(request.args.get("hub.challenge") or "", status=200, mimetype="text/plain")
    abort(403)


@app.post("/webhooks/meta")
def meta_webhook_receive():
    return jsonify({"ok": True, "received": True})


SETUP_TEMPLATE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CRM Setup</title><style>:root{font-family:Arial,sans-serif;background:#f6f7f9;color:#17202a}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{max-width:760px;width:100%;background:white;border:1px solid #d8dee8;border-radius:8px;padding:28px}h1{margin-top:0;font-size:24px}p{line-height:1.55}code{background:#eef2f7;padding:2px 5px;border-radius:4px}li{margin:8px 0}.ok{color:#1f8a70;font-weight:700}.warn{color:#a15c00;font-weight:700}</style></head><body><main><h1>CRM is online</h1>{% if database_ready %}<p class="ok">Database variables are configured.</p>{% else %}<p class="warn">Database variables are not configured yet, so the customer inbox is not active.</p>{% endif %}<p>The Render service is deployed. To start syncing Messenger customers, finish the database and Meta configuration.</p><ol><li>Run <code>schema.sql</code> in the CRM Supabase project.</li><li>Add <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> in Render.</li><li>Add <code>META_VERIFY_TOKEN</code>, <code>META_APP_SECRET</code>, <code>META_PAGE_ACCESS_TOKEN</code>, <code>META_PAGE_ID</code>.</li><li>Use <code>/webhooks/meta</code> as the Meta callback path.</li></ol><p>Health check: <code>/health</code></p></main></body></html>"""

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
