"""Render live entrypoint."""

import os

import requests
from flask import jsonify

from app import app

GRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v21.0")
META_PAGE_ID = os.getenv("META_PAGE_ID", "")
META_PAGE_ACCESS_TOKEN = os.getenv("META_PAGE_ACCESS_TOKEN", "")
MESSENGER_FIELDS = "messages,message_echoes,messaging_postbacks,message_deliveries,message_reads"


def graph_url(path):
    return f"https://graph.facebook.com/{GRAPH_API_VERSION}/{path.lstrip('/')}"


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
