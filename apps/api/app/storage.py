from __future__ import annotations

from contextlib import asynccontextmanager
import aioboto3
import json
from botocore.config import Config

from .config import Settings


def _client_config(settings: Settings) -> Config:
    return Config(
        signature_version="s3v4",
        s3={"addressing_style": "path" if settings.s3_force_path_style else "virtual"},
    )


@asynccontextmanager
async def s3_client(settings: Settings):
    session = aioboto3.Session()
    explicit_credentials = {}
    if settings.s3_access_key_id and settings.s3_secret_access_key:
        explicit_credentials = {
            "aws_access_key_id": settings.s3_access_key_id,
            "aws_secret_access_key": settings.s3_secret_access_key,
        }
    async with session.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        region_name=settings.s3_region,
        config=_client_config(settings),
        **explicit_credentials,
    ) as client:
        yield client


async def ensure_bucket(settings: Settings) -> None:
    async with s3_client(settings) as client:
        buckets = await client.list_buckets()
        names = {bucket["Name"] for bucket in buckets.get("Buckets", [])}
        if settings.s3_bucket not in names:
            await client.create_bucket(Bucket=settings.s3_bucket)
        if settings.cloudfront_base_url.startswith("https://"):
            return
        await client.put_bucket_policy(
            Bucket=settings.s3_bucket,
            Policy=json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Effect": "Allow",
                            "Principal": "*",
                            "Action": ["s3:GetObject"],
                            "Resource": [f"arn:aws:s3:::{settings.s3_bucket}/*"],
                        }
                    ],
                }
            ),
        )


def public_url(settings: Settings, key: str | None) -> str | None:
    if not key:
        return None
    return f"{settings.cloudfront_base_url.rstrip('/')}/{key}"
