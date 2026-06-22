from __future__ import annotations

import json
from typing import Any

from redis.asyncio import Redis

QUEUE_NAME = "render_jobs"


async def create_redis(redis_url: str) -> Redis:
    return Redis.from_url(redis_url, decode_responses=True)


async def enqueue_render(redis: Redis, payload: dict[str, Any]) -> None:
    await redis.rpush(QUEUE_NAME, json.dumps(payload))
