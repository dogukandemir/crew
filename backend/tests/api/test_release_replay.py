import asyncio

import pytest
from sqlalchemy import func, select
from starlette.testclient import TestClient

from crew.api.main import create_app
from crew.core.db import session_scope
from crew.core.models import Event


@pytest.mark.asyncio
async def test_websocket_replays_history_beyond_old_2000_row_limit(project):
    async with session_scope() as s:
        start = int(await s.scalar(select(func.max(Event.seq)).where(Event.project_id == project["id"])) or 0)
        s.add_all(Event(project_id=project["id"], seq=start + i, type="test.replay", title=f"event {i}")
                  for i in range(1, 2206))

    def receive():
        with TestClient(create_app(), base_url="http://localhost") as client:
            with client.websocket_connect(f"ws://localhost/ws/projects/{project['id']}?since_seq={start}") as ws:
                assert ws.receive_json()["seq_head"] == start + 2205
                sequences = []
                while True:
                    frame = ws.receive_json()
                    if frame["type"] == "replay.complete":
                        assert frame["up_to"] == start + 2205
                        break
                    assert frame["type"] == "event"
                    sequences.append(frame["seq"])
                assert sequences == list(range(start + 1, start + 2206))
    await asyncio.wait_for(asyncio.to_thread(receive), timeout=30)
