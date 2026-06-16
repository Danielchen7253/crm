"""Broader Messenger conversation import for Page inbox folders."""

import requests
from flask import jsonify, request

from app_live_new import app, crm_module

MESSENGER_CONVERSATION_FOLDERS = ["", "inbox", "page_done", "other", "spam"]


def redact_error_text(error):
    text = str(error)
    token = crm_module.current_meta_page_access_token()
    if token:
        text = text.replace(token, "[redacted]")
    return text


def import_messenger_folder(folder, fields, max_pages, page_limit, seen_conversations):
    page_id = crm_module.current_meta_page_id()
    path = f"{page_id}/conversations/{folder}" if folder else f"{page_id}/conversations"
    page = crm_module.graph_get(path, {"fields": fields, "limit": str(page_limit)})
    pages = 0
    conversations_seen = 0
    conversations_imported = 0
    customers_created = 0
    messages_imported = 0

    while page and pages < max_pages:
        pages += 1
        conversations = page.get("data", [])
        conversations_seen += len(conversations)
        for conversation in conversations:
            conversation_id = conversation.get("id")
            if conversation_id and conversation_id in seen_conversations:
                continue
            if conversation_id:
                seen_conversations.add(conversation_id)
            result = crm_module.import_conversation(conversation)
            conversations_imported += 1
            customers_created += result["customer_created"]
            messages_imported += result["messages_imported"]
        next_url = page.get("paging", {}).get("next")
        page = crm_module.graph_get_url(next_url) if next_url else None

    return {
        "folder": folder or "default",
        "pages": pages,
        "conversations_seen": conversations_seen,
        "conversations_imported": conversations_imported,
        "customers_created": customers_created,
        "messages_imported": messages_imported,
        "stopped_by_max_pages": bool(page),
    }


def sync_messenger_conversations_all_folders(max_pages=200, page_limit=100, messages_limit=25):
    if not crm_module.current_meta_page_id() or not crm_module.current_meta_page_access_token():
        raise RuntimeError("META_PAGE_ID and META_PAGE_ACCESS_TOKEN are required.")

    fields = (
        f"participants{{id,name,profile_pic,picture}},"
        f"messages.limit({messages_limit}){{id,message,from,to,created_time,attachments}}"
    )
    seen_conversations = set()
    folder_results = []
    folder_errors = []
    totals = {
        "pages": 0,
        "conversations_seen": 0,
        "conversations_imported": 0,
        "customers_created": 0,
        "messages_imported": 0,
    }

    for folder in MESSENGER_CONVERSATION_FOLDERS:
        try:
            result = import_messenger_folder(folder, fields, max_pages, page_limit, seen_conversations)
        except requests.RequestException as error:
            response = getattr(error, "response", None)
            detail = None
            if response is not None:
                try:
                    detail = response.json()
                except ValueError:
                    detail = response.text[:500]
            folder_errors.append({"folder": folder or "default", "error": redact_error_text(error), "detail": detail})
            continue

        folder_results.append(result)
        for key in totals:
            totals[key] += result[key]

    return {
        **totals,
        "folders": folder_results,
        "folder_errors": folder_errors,
        "stopped_by_max_pages": any(item["stopped_by_max_pages"] for item in folder_results),
    }


def import_messenger_conversations_fixed():
    try:
        max_pages = max(1, min(int(request.args.get("max_pages", "200")), 500))
        page_limit = max(1, min(int(request.args.get("limit", "100")), 100))
        messages_limit = max(1, min(int(request.args.get("messages_limit", "25")), 100))
        result = sync_messenger_conversations_all_folders(max_pages, page_limit, messages_limit)
    except RuntimeError as error:
        return jsonify({"ok": False, "error": str(error)}), 400
    except requests.RequestException as error:
        return jsonify({"ok": False, "error": redact_error_text(error)}), 502
    return jsonify({"ok": True, **result})


@app.post("/admin/import/messenger-conversations/all")
def import_messenger_conversations_all():
    return import_messenger_conversations_fixed()


crm_module.sync_messenger_conversations_paginated = sync_messenger_conversations_all_folders
app.view_functions["import_messenger_conversations"] = import_messenger_conversations_fixed
