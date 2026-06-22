from functools import lru_cache
from pydantic import BaseModel
import os


class Settings(BaseModel):
    database_url: str = os.getenv("DATABASE_URL", "postgresql://reelwalk:reelwalk@localhost:5432/reelwalk")
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    s3_endpoint_url: str | None = os.getenv("S3_ENDPOINT_URL", "http://localhost:9000") or None
    s3_public_endpoint_url: str = os.getenv("S3_PUBLIC_ENDPOINT_URL", "http://localhost:9000")
    s3_region: str = os.getenv("S3_REGION") or os.getenv("AWS_REGION", "us-east-1")
    s3_access_key_id: str | None = os.getenv("S3_ACCESS_KEY_ID") or None
    s3_secret_access_key: str | None = os.getenv("S3_SECRET_ACCESS_KEY") or None
    s3_bucket: str = os.getenv("S3_BUCKET", "reelwalk-dev")
    s3_force_path_style: bool = os.getenv("S3_FORCE_PATH_STYLE", "true").lower() == "true"
    cloudfront_base_url: str = os.getenv("CLOUDFRONT_BASE_URL", "http://localhost:9000/reelwalk-dev")
    dev_user_id: str = os.getenv("DEV_USER_ID", "dev-photographer")


@lru_cache
def get_settings() -> Settings:
    return Settings()
