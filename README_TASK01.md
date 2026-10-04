# ReelWalk Task 01 Quickstart

Task 01 wires a local upload-to-render slice:

1. Web uploads an MP4.
2. FastAPI streams it to MinIO using the S3 API.
3. The API writes listing/job rows in Postgres and pushes a Redis queue job.
4. The worker renders a 9:16 `StubReel` with Remotion and FFmpeg.
5. The worker uploads the MP4 to MinIO and marks the job `done`.
6. The web UI polls and displays the result.

## Run

```bash
cp .env.example .env
docker compose up --build
```

Open http://localhost:8080 and upload an MP4 or a JPG/PNG panorama.

MinIO console is available at http://localhost:9001 with `minioadmin` / `minioadmin`.

## Tests

```bash
python3 -m pytest apps/api/tests
pnpm install
pnpm test:render
pnpm test:worker
```
