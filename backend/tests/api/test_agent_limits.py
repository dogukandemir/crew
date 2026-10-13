import httpx
import pytest

from crew.api.main import create_app
from crew.core.db import session_scope
from crew.core.models import Agent


@pytest.mark.asyncio
async def test_agent_limits_and_autonomy_are_validated_before_mutation(project):
    async with session_scope() as s:
        agent = Agent(project_id=project["id"], name="Limits", role="worker")
        s.add(agent)
        await s.flush()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://localhost") as client:
        for body in [{"spend_cap_per_day_usd": -1}, {"spend_cap_per_run_usd": 1e100}, {"autonomy": "anything"}]:
            response = await client.patch(f"/api/agents/{agent.id}", json=body)
            assert response.status_code == 422
        response = await client.patch(f"/api/agents/{agent.id}", content='{"spend_cap_per_day_usd": NaN}',
                                      headers={"Content-Type": "application/json"})
        assert response.status_code == 422
        response = await client.patch(f"/api/agents/{agent.id}", json={"spend_cap_per_day_usd": 5})
        assert response.status_code == 200 and response.json()["spend_cap_per_day_usd"] == 5
        for body in [{"budget_usd": -1}, {"budget_usd": 1e100}, {"unknown": "value"}]:
            response = await client.patch("/api/departments/does-not-exist", json=body)
            assert response.status_code == 422
