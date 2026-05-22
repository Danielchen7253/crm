"""Render live entrypoint.

The Render service currently starts with `gunicorn app_live:app`.
Keep this tiny wrapper so the live service uses the full CRM application
implemented in app.py.
"""

from app import app
