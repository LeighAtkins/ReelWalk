"""
Editor render endpoint — accepts a project JSON from the timeline editor,
queues a render job, and returns the job ID for polling.
"""
from __future__ import annotations

import json
import logging
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/editor", tags=["editor"])


class EditorProject(BaseModel):
    id: str
    name: str = "Untitled"
    width: int = 1080
    height: int = 1920
    fps: int = 30
    tracks: list = []


class RenderResponse(BaseModel):
    job_id: str
    status: str


class RenderStatus(BaseModel):
    job_id: str
    status: str
    output_url: str | None = None
    error: str | None = None


@router.post("/render", response_model=RenderResponse)
async def create_editor_render(project: EditorProject, request: Request) -> RenderResponse:
    """Queue an editor project for rendering."""
    pool = request.app.state.pool
    redis = request.app.state.redis
    settings = request.app.state.settings if hasattr(request.app.state, "settings") else None

    job_id = uuid4()
    project_json = project.model_dump_json()

    async with pool.acquire() as conn:
        # Create a synthetic listing for the editor project
        listing_id = uuid4()
        await conn.execute(
            """
            insert into listings (id, user_id, title)
            values ($1, $2, $3)
            """,
            listing_id,
            "editor",
            f"Editor: {project.name}",
        )

        await conn.execute(
            """
            insert into render_jobs (id, listing_id, status, input_key, error)
            values ($1, $2, 'queued', $3, $4)
            """,
            job_id,
            listing_id,
            project_json,
            None,
        )

    # Enqueue with a special marker so the worker knows it's an editor render
    from .queue import enqueue_render
    await enqueue_render(
        redis,
        {
            "jobId": str(job_id),
            "listingId": str(listing_id),
            "inputKey": project_json,
            "type": "editor",
        },
    )

    logger.info(f"Queued editor render job {job_id}")
    return RenderResponse(job_id=str(job_id), status="queued")


@router.get("/render/{job_id}", response_model=RenderStatus)
async def get_editor_render(job_id: str, request: Request) -> RenderStatus:
    """Poll render job status."""
    pool = request.app.state.pool
    settings = request.app.state.settings if hasattr(request.app.state, "settings") else None

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select * from render_jobs where id = $1", job_id
        )

    if not row:
        raise HTTPException(status_code=404, detail="Render job not found")

    result = RenderStatus(
        job_id=str(row["id"]),
        status=row["status"],
        error=row.get("error"),
    )

    if row["status"] == "done" and row.get("output_key"):
        # Build public URL from storage settings
        from .storage import public_url
        from .config import get_settings
        s = get_settings()
        result.output_url = public_url(s, row["output_key"])

    return result
