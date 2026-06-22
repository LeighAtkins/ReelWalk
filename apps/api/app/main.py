from __future__ import annotations

import logging
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import create_pool, init_schema, row_to_dict
from .queue import create_redis, enqueue_render
from .storage import ensure_bucket, public_url, s3_client

settings = get_settings()
app = FastAPI(title="ReelWalk API")
logger = logging.getLogger(__name__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup() -> None:
    app.state.pool = await create_pool(settings.database_url)
    app.state.redis = await create_redis(settings.redis_url)
    await init_schema(app.state.pool)
    try:
        await ensure_bucket(settings)
    except Exception:
        logger.exception("S3 bucket setup failed; upload/render endpoints may fail until storage credentials are fixed")


@app.on_event("shutdown")
async def shutdown() -> None:
    await app.state.redis.aclose()
    await app.state.pool.close()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"ok": "true"}


@app.post("/listings")
async def create_listing(payload: dict | None = None) -> dict:
    listing_id = uuid4()
    title = (payload or {}).get("title") or "Untitled listing"
    async with app.state.pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            insert into listings (id, user_id, title)
            values ($1, $2, $3)
            returning *
            """,
            listing_id,
            settings.dev_user_id,
            title,
        )
    listing = row_to_dict(row)
    listing["media_url"] = None
    return listing


@app.get("/listings/{listing_id}")
async def get_listing(listing_id: str) -> dict:
    async with app.state.pool.acquire() as conn:
        row = await conn.fetchrow("select * from listings where id = $1", listing_id)
    listing = row_to_dict(row)
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    listing["media_url"] = public_url(settings, listing.get("video_key"))
    return listing


@app.post("/listings/{listing_id}/upload")
async def upload_video(listing_id: str, file: UploadFile = File(...)) -> dict:
    if file.content_type not in {"video/mp4", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Only MP4 uploads are supported in Task 01")

    async with app.state.pool.acquire() as conn:
        listing = await conn.fetchrow("select id from listings where id = $1", listing_id)
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")

    object_key = f"uploads/{listing_id}/{uuid4()}.mp4"
    async with s3_client(settings) as client:
        await client.upload_fileobj(
            file.file,
            settings.s3_bucket,
            object_key,
            ExtraArgs={"ContentType": "video/mp4"},
        )

    job_id = uuid4()
    async with app.state.pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "update listings set video_key = $1, updated_at = now() where id = $2",
                object_key,
                listing_id,
            )
            await conn.execute(
                """
                insert into render_jobs (id, listing_id, status, input_key)
                values ($1, $2, 'queued', $3)
                """,
                job_id,
                listing_id,
                object_key,
            )

    await enqueue_render(
        app.state.redis,
        {"jobId": str(job_id), "listingId": listing_id, "inputKey": object_key},
    )
    return {"listing_id": listing_id, "video_key": object_key, "job_id": str(job_id), "status": "queued"}


@app.get("/listings/{listing_id}/jobs/last")
async def get_last_job(listing_id: str) -> dict:
    async with app.state.pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            select * from render_jobs
            where listing_id = $1
            order by created_at desc
            limit 1
            """,
            listing_id,
        )
    job = row_to_dict(row)
    if not job:
        raise HTTPException(status_code=404, detail="No render job found")
    job["output_url"] = public_url(settings, job.get("output_key"))
    return job
