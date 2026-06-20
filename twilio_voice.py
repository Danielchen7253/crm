"""Twilio Voice AI intake for CRM calls and lead creation."""

import html
import json
import os
from datetime import datetime, timezone

import requests
from flask import Response, jsonify, request

from app_live_new import app, crm_module
from twilio_sms import normalize_phone, verify_twilio_signature


TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER") or os.getenv("TWILIO_PHONE_NUMBER", "+18587570488")
OWNER_PHONE = normalize_phone(os.getenv("OWNER_PHONE") or "+16263930488")
VOICE_PROVIDER = "twilio_voice"
VOICE_SOURCE = "phone"
VOICE_BASE_URL = os.getenv("CRM_PUBLIC_BASE_URL", "https://crm-8t7y.onrender.com").rstrip("/")
TRANSFER_KEYWORDS = (
    "human",
    "agent",
    "owner",
    "real person",
    "representative",
    "transfer",
    "order now",
    "buy now",
    "quote",
    "repair estimate",
    "真人",
    "人工",
    "老板",
    "转接",
    "报价",
    "下单",
    "维修报价",
    "persona",
    "representante",
    "transferir",
    "cotizacion",
)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def xml_response(body):
    return Response(body, status=200, mimetype="text/xml")


def twiml_say(text, language="en"):
    attrs = {
        "en": 'language="en-US" voice="alice"',
        "es": 'language="es-MX" voice="alice"',
        "zh": 'language="zh-CN" voice="alice"',
    }.get(language, 'language="en-US" voice="alice"')
    return f"<Say {attrs}>{html.escape(text)}</Say>"


def twiml_gather(prompt, language="en"):
    speech_language = {"en": "en-US", "es": "es-MX", "zh": "zh-CN"}.get(language, "en-US")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  {twiml_say(prompt, language)}
  <Gather input="speech dtmf" action="{VOICE_BASE_URL}/voice/respond" method="POST" speechTimeout="auto" timeout="5" language="{speech_language}">
    {twiml_say("Please tell me what you need after the beep.", language)}
  </Gather>
  <Redirect method="POST">{VOICE_BASE_URL}/voice/respond?no_input=1</Redirect>
</Response>"""


def twiml_handoff(reason):
    if not OWNER_PHONE:
        return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>{twiml_say("I could not reach the owner phone. I saved your request and we will follow up soon.", "en")}</Response>"""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  {twiml_say("I will connect you with the owner now. If we miss the call, your request has already been saved.", "en")}
  <Dial callerId="{html.escape(TWILIO_FROM_NUMBER)}" action="{VOICE_BASE_URL}/voice/status" method="POST">{html.escape(OWNER_PHONE)}</Dial>
</Response>"""


def safe_post(table, payload):
    try:
        return crm_module.sb_post(table, payload)
    except requests.RequestException:
        return []


def safe_patch(table, payload, params):
    try:
        return crm_module.sb_patch(table, payload, params)
    except requests.RequestException:
        return []


def find_voice_identity(phone):
    try:
        rows = crm_module.sb_get(
            "customer_identities",
            {
                "provider": f"eq.{VOICE_PROVIDER}",
                "provider_user_id": f"eq.{phone}",
                "select": "customer_id",
                "limit": "1",
            },
        )
    except requests.RequestException:
        rows = []
    return rows[0] if rows else None


def ensure_voice_customer(phone, raw_profile=None):
    phone = normalize_phone(phone)
    now = now_iso()
    identity = find_voice_identity(phone)
    if identity:
        safe_patch("customers", {"last_seen_at": now, "updated_at": now}, {"id": f"eq.{identity['customer_id']}"})
        return identity["customer_id"], False

    display_name = f"Phone {phone}" if phone else "Phone caller"
    metadata = {"phone": phone, "voice_phone": phone, "twilio_voice": raw_profile or {}}
    rows = safe_post(
        "customers",
        {
            "display_name": display_name,
            "source": VOICE_SOURCE,
            "first_seen_at": now,
            "last_seen_at": now,
            "last_message_at": now,
            "metadata": metadata,
        },
    )
    if not rows:
        raise RuntimeError("Could not create voice customer.")
    customer = rows[0]
    safe_post(
        "customer_identities",
        {
            "customer_id": customer["id"],
            "provider": VOICE_PROVIDER,
            "provider_user_id": phone,
            "display_name": display_name,
            "raw_profile": metadata,
        },
    )
    return customer["id"], True


def load_customer(customer_id):
    try:
        rows = crm_module.sb_get(
            "customers",
            {"id": f"eq.{customer_id}", "select": "id,display_name,metadata,locale", "limit": "1"},
        )
    except requests.RequestException:
        rows = []
    return rows[0] if rows else {}


def detect_language(text):
    lowered = (text or "").lower()
    if any("\u4e00" <= char <= "\u9fff" for char in text or ""):
        return "zh"
    if any(word in lowered for word in ("hola", "gracias", "precio", "reparacion", "necesito", "espanol", "español")):
        return "es"
    return "en"


def should_transfer(text):
    lowered = (text or "").lower()
    return any(keyword in lowered for keyword in TRANSFER_KEYWORDS)


def save_voice_message(customer_id, call_sid, direction, text, raw=None):
    if not text:
        return
    message_id = f"{call_sid}:{direction}:{int(datetime.now(timezone.utc).timestamp() * 1000)}"
    safe_post(
        "messages",
        {
            "customer_id": customer_id,
            "provider": VOICE_PROVIDER,
            "provider_message_id": message_id,
            "direction": direction,
            "message_type": "text",
            "text": text,
            "attachments": [],
            "raw_event": raw or {},
            "sent_at": now_iso(),
        },
    )
    safe_patch(
        "customers",
        {"last_seen_at": now_iso(), "last_message_at": now_iso(), "updated_at": now_iso()},
        {"id": f"eq.{customer_id}"},
    )


def upsert_call_record(customer_id, call_sid, payload):
    if not call_sid:
        return []
    row = {
        "customer_id": customer_id,
        "provider": VOICE_PROVIDER,
        "provider_call_id": call_sid,
        **payload,
        "updated_at": now_iso(),
    }
    rows = safe_patch("calls", row, {"provider": f"eq.{VOICE_PROVIDER}", "provider_call_id": f"eq.{call_sid}"})
    if rows:
        return rows
    row.setdefault("created_at", now_iso())
    return safe_post("calls", row)


def create_lead(customer_id, need, status="new", raw=None):
    if not need:
        return []
    return safe_post(
        "leads",
        {
            "customer_id": customer_id,
            "need": need[:1000],
            "status": status,
            "raw_context": raw or {},
            "created_at": now_iso(),
            "updated_at": now_iso(),
        },
    )


def parse_openai_json(text):
    try:
        start = text.index("{")
        end = text.rindex("}") + 1
        return json.loads(text[start:end])
    except Exception:
        return {}


def ai_voice_reply(customer, speech, language):
    fallback = {
        "en": "I can help with parts, prices, pickup, shipping, and repair service. What product or problem are you calling about?",
        "es": "Puedo ayudar con piezas, precios, recogida, envio y servicio de reparacion. Que producto o problema tiene?",
        "zh": "我可以帮你确认配件、价格、提货、发货和维修服务。请告诉我你需要什么产品或遇到什么问题。",
    }[language]
    if not crm_module.OPENAI_API_KEY:
        return {"reply": fallback, "need": speech, "summary": speech, "transfer": should_transfer(speech)}

    system = (
        "You are CoolFix Pro Supply's phone assistant. Reply in the caller's language. "
        "Keep replies short for a phone call. Collect name, need, address/problem, and whether they need parts or repair. "
        "Known facts: pickup address 755 International Blvd, Houston, TX 77024. "
        "Orders paid before 3 PM ship same day; after 3 PM ship next business day; holidays may delay. "
        "If caller asks for human, is ready to order, needs a repair quote, or you are unsure, set transfer=true. "
        "Return only JSON with keys reply, need, summary, transfer."
    )
    try:
        response = requests.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {crm_module.OPENAI_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": crm_module.OPENAI_MODEL,
                "input": [
                    {"role": "system", "content": system},
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "customer": customer,
                                "language": language,
                                "caller_said": speech,
                            },
                            ensure_ascii=False,
                        ),
                    },
                ],
            },
            timeout=20,
        )
        response.raise_for_status()
        data = parse_openai_json(crm_module.parse_openai_text(response.json()))
        return {
            "reply": (data.get("reply") or fallback).strip()[:900],
            "need": (data.get("need") or speech or "").strip(),
            "summary": (data.get("summary") or speech or "").strip(),
            "transfer": bool(data.get("transfer")) or should_transfer(speech),
        }
    except Exception:
        return {"reply": fallback, "need": speech, "summary": speech, "transfer": should_transfer(speech)}


@app.route("/voice/incoming", methods=["GET", "POST"])
@app.route("/webhooks/twilio/voice/incoming", methods=["GET", "POST"])
def voice_incoming():
    if request.method == "POST" and not verify_twilio_signature():
        return Response("Forbidden", status=403, mimetype="text/plain")
    from_phone = normalize_phone(request.values.get("From"))
    customer_id, _ = ensure_voice_customer(from_phone, dict(request.values))
    call_sid = request.values.get("CallSid") or ""
    upsert_call_record(
        customer_id,
        call_sid,
        {
            "from_phone": from_phone,
            "to_phone": normalize_phone(request.values.get("To")),
            "status": "in_progress",
            "language": "",
            "transcript": "",
            "summary": "",
            "raw_event": {"incoming": dict(request.values)},
        },
    )
    prompt = (
        "Hi, this is CoolFix Pro Supply. I am the AI assistant. "
        "You can speak English, Spanish, or Chinese. Are you calling for parts, price, pickup, shipping, or repair service?"
    )
    return xml_response(twiml_gather(prompt, "en"))


@app.route("/voice/respond", methods=["GET", "POST"])
@app.route("/webhooks/twilio/voice/respond", methods=["GET", "POST"])
def voice_respond():
    if request.method == "POST" and not verify_twilio_signature():
        return Response("Forbidden", status=403, mimetype="text/plain")
    from_phone = normalize_phone(request.values.get("From"))
    customer_id, _ = ensure_voice_customer(from_phone, dict(request.values))
    call_sid = request.values.get("CallSid") or ""
    speech = (request.values.get("SpeechResult") or request.values.get("Digits") or "").strip()
    if request.args.get("no_input") and not speech:
        return xml_response(
            f"""<?xml version="1.0" encoding="UTF-8"?><Response>{twiml_say("I did not hear anything. Please call again or send us a text message.", "en")}</Response>"""
        )
    language = detect_language(speech)
    customer = load_customer(customer_id)
    save_voice_message(customer_id, call_sid, "inbound", speech, dict(request.values))
    ai_result = ai_voice_reply(customer, speech, language)
    save_voice_message(customer_id, call_sid, "outbound", ai_result["reply"], {"source": "voice_ai", **ai_result})
    transcript = f"Caller: {speech}\nAI: {ai_result['reply']}"
    upsert_call_record(
        customer_id,
        call_sid,
        {
            "from_phone": from_phone,
            "to_phone": normalize_phone(request.values.get("To")),
            "status": "transferring" if ai_result["transfer"] else "in_progress",
            "language": language,
            "transcript": transcript,
            "summary": ai_result["summary"],
            "raw_event": {"latest": dict(request.values), "ai": ai_result},
        },
    )
    if ai_result["need"]:
        create_lead(customer_id, ai_result["need"], "needs_human" if ai_result["transfer"] else "new", {"call_sid": call_sid, "language": language})
    if ai_result["transfer"]:
        return xml_response(twiml_handoff(ai_result["summary"]))
    return xml_response(twiml_gather(ai_result["reply"], language))


@app.route("/voice/status", methods=["GET", "POST"])
@app.route("/webhooks/twilio/voice/status", methods=["GET", "POST"])
def voice_status():
    call_sid = request.values.get("CallSid") or request.values.get("ParentCallSid") or ""
    status = request.values.get("CallStatus") or request.values.get("DialCallStatus") or ""
    if call_sid:
        safe_patch(
            "calls",
            {"status": status or "updated", "raw_event": {"status_callback": dict(request.values)}, "updated_at": now_iso()},
            {"provider": f"eq.{VOICE_PROVIDER}", "provider_call_id": f"eq.{call_sid}"},
        )
    return xml_response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>")


@app.post("/ai/summary")
def ai_summary():
    payload = request.get_json(silent=True) or {}
    call_id = request.form.get("call_id") or payload.get("call_id")
    if not call_id:
        return jsonify({"ok": False, "error": "call_id is required"}), 400
    try:
        rows = crm_module.sb_get("calls", {"id": f"eq.{call_id}", "select": "*", "limit": "1"})
    except requests.RequestException as error:
        return jsonify({"ok": False, "error": str(error)}), 400
    if not rows:
        return jsonify({"ok": False, "error": "Call not found"}), 404
    transcript = rows[0].get("transcript") or ""
    summary = ai_voice_reply({}, transcript, detect_language(transcript)).get("summary") or transcript[:500]
    safe_patch("calls", {"summary": summary, "updated_at": now_iso()}, {"id": f"eq.{call_id}"})
    return jsonify({"ok": True, "summary": summary})


@app.get("/admin/voice/diagnostics")
def voice_diagnostics():
    try:
        calls = crm_module.sb_get("calls", {"select": "id", "limit": "1000"})
    except requests.RequestException:
        calls = []
    try:
        leads = crm_module.sb_get("leads", {"select": "id", "limit": "1000"})
    except requests.RequestException:
        leads = []
    return jsonify(
        {
            "ok": True,
            "voice_url": f"{VOICE_BASE_URL}/voice/incoming",
            "status_url": f"{VOICE_BASE_URL}/voice/status",
            "owner_phone_present": bool(OWNER_PHONE),
            "openai_present": bool(crm_module.OPENAI_API_KEY),
            "calls_table_available": isinstance(calls, list),
            "leads_table_available": isinstance(leads, list),
            "calls": len(calls),
            "leads": len(leads),
        }
    )
