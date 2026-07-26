"""
Production entrypoint.

    gunicorn wsgi:app

Kept separate from the app package so the factory stays importable in tests
without a server object being built as a side effect of the import.
"""

from app import create_app

app = create_app()
