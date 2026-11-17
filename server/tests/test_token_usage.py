import pytest
import sqlite3
from fastapi.testclient import TestClient
from main import app
from app.database import (
    record_token_usage,
    get_daily_token_usage,
    get_token_usage_summary,
    get_token_usage_logs,
    clear_token_usage,
    init_db,
)

client = TestClient(app)


def test_token_usage_db_crud():
    init_db()

    # Record token usage for a mock chat turn
    row_id = record_token_usage(
        prompt_tokens=120,
        completion_tokens=45,
        total_tokens=165,
        model="gpt-4o",
        provider="openai",
        thread_id="test_thread_1",
        source="test",
    )
    assert row_id > 0

    # Record another turn with different provider
    row_id2 = record_token_usage(
        prompt_tokens=300,
        completion_tokens=100,
        model="gemini-2.5-flash",
        provider="gemini",
        thread_id="test_thread_2",
        source="test",
    )
    assert row_id2 > 0

    # Verify summary
    summary = get_token_usage_summary(days=30)
    assert summary["all_time"]["total_tokens"] >= 565
    assert summary["today"]["total_tokens"] >= 565
    assert len(summary["daily"]) >= 1

    # Verify daily breakdown
    daily = get_daily_token_usage(days=7)
    assert len(daily) >= 1
    assert any(d["prompt_tokens"] >= 420 for d in daily)

    # Verify logs
    logs = get_token_usage_logs(limit=10)
    assert len(logs) >= 2
    assert logs[0]["model"] in ("gemini-2.5-flash", "gpt-4o")


def test_token_usage_api_endpoints():
    # Record through API
    res = client.post(
        "/token-usage/record",
        json={
            "prompt_tokens": 50,
            "completion_tokens": 25,
            "total_tokens": 75,
            "model": "gpt-6-luna",
            "provider": "azure_foundry",
            "thread_id": "api_test_thread",
            "source": "api_test",
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert data["id"] > 0

    # Summary endpoint
    res = client.get("/token-usage/summary?days=7")
    assert res.status_code == 200
    summary = res.json()
    assert "today" in summary
    assert "daily" in summary
    assert "by_provider" in summary
    assert "by_model" in summary

    # Daily endpoint
    res = client.get("/token-usage/daily?days=7")
    assert res.status_code == 200
    daily = res.json()
    assert isinstance(daily, list)
    assert len(daily) >= 1

    # Logs endpoint
    res = client.get("/token-usage/logs?limit=5")
    assert res.status_code == 200
    logs = res.json()
    assert isinstance(logs, list)
    assert len(logs) >= 1
    assert logs[0]["provider"] == "azure_foundry"
