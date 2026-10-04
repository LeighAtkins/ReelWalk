from __future__ import annotations

import logging
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import create_pool, init_schema, row_to_dict
from .queue import create_redis, enqueue_render
from .storage import ensure_bucket, public_url, s3_client
from .editor_routes import router as editor_router

settings = get_settings()
app = FastAPI(title="ReelWalk API")
app.include_router(editor_router)
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


# Content types the stub render pipeline can consume, mapped to the object key
# extension. The worker and the Remotion composition rely on this extension to
# tell still images from video, so it must be preserved end to end.
SUPPORTED_UPLOAD_TYPES: dict[str, str] = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/x-m4v": "m4v",
    "video/webm": "webm",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}
_EXTENSION_TO_TYPE = {ext: ctype for ctype, ext in SUPPORTED_UPLOAD_TYPES.items()}
_EXTENSION_TO_TYPE["jpeg"] = "image/jpeg"


def resolve_upload_type(content_type: str | None, filename: str | None) -> tuple[str, str] | None:
    """Return (content_type, extension) for an upload, or None if unsupported.

    Browsers sometimes send application/octet-stream, so fall back to the
    filename extension in that case.
    """
    normalized = (content_type or "").split(";")[0].strip().lower()
    if normalized in SUPPORTED_UPLOAD_TYPES:
        return normalized, SUPPORTED_UPLOAD_TYPES[normalized]
    if normalized in {"", "application/octet-stream"} and filename and "." in filename:
        ext = filename.rsplit(".", 1)[1].lower()
        if ext in _EXTENSION_TO_TYPE:
            return _EXTENSION_TO_TYPE[ext], ext
    return None


@app.post("/listings/{listing_id}/upload")
async def upload_video(listing_id: str, file: UploadFile = File(...)) -> dict:
    resolved = resolve_upload_type(file.content_type, file.filename)
    if resolved is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported upload type. Accepted: {', '.join(sorted(SUPPORTED_UPLOAD_TYPES))}",
        )
    content_type, extension = resolved

    async with app.state.pool.acquire() as conn:
        listing = await conn.fetchrow("select id from listings where id = $1", listing_id)
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")

    object_key = f"uploads/{listing_id}/{uuid4()}.{extension}"
    async with s3_client(settings) as client:
        await client.upload_fileobj(
            file.file,
            settings.s3_bucket,
            object_key,
            ExtraArgs={"ContentType": content_type},
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
