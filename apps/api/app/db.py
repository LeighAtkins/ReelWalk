from __future__ import annotations

import asyncpg
from typing import Any

SCHEMA_SQL = """
create table if not exists listings (
  id uuid primary key,
  user_id text not null,
  title text not null,
  video_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists render_jobs (
  id uuid primary key,
  listing_id uuid not null references listings(id) on delete cascade,
  status text not null check (status in ('queued', 'running', 'done', 'failed')),
  input_key text not null,
  output_key text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
"""


async def create_pool(database_url: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(database_url, min_size=1, max_size=5)


async def init_schema(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)


def row_to_dict(row: asyncpg.Record | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return dict(row)
