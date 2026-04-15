import os
import sys
import tempfile

import pytest
from fastapi.testclient import TestClient


# Ensure backend/ is importable as top-level (services/, routers/, etc.)
backend_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if backend_root not in sys.path:
    sys.path.insert(0, backend_root)


@pytest.fixture()
def client(monkeypatch):
    """
    Provides a TestClient with an isolated temporary SQLite database.

    We monkeypatch DB_PATH in modules that use it directly.
    """
    from database import init_db

    # Create temp DB file
    fd, path = tempfile.mkstemp(prefix="messenger_test_", suffix=".db")
    os.close(fd)

    # Patch DB_PATH everywhere it's imported as a module global
    import database as db_mod
    import dependencies as deps_mod
    import routers.groups as groups_mod
    import routers.users as users_mod
    import routers.messages as messages_mod

    monkeypatch.setattr(db_mod, "DB_PATH", path, raising=True)
    monkeypatch.setattr(deps_mod, "DB_PATH", path, raising=True)
    monkeypatch.setattr(groups_mod, "DB_PATH", path, raising=True)
    monkeypatch.setattr(users_mod, "DB_PATH", path, raising=True)
    monkeypatch.setattr(messages_mod, "DB_PATH", path, raising=True)

    from main import app

    # Init schema
    import asyncio

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(init_db())
    finally:
        loop.close()

    with TestClient(app) as c:
        yield c

    try:
        os.remove(path)
    except OSError:
        pass

