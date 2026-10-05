# Sample media library

The editor is more useful with something to edit. One command fills the media
library with 360 photos of real rooms, short home videos and music, and
creates three sample reels from them:

```bash
docker compose up -d            # the stack must be running
docker compose run --rm import-library
```

It needs an internet connection the first time (about 220 MB). It is safe to
run again: files already imported are skipped, and sample reels you have
edited are left alone. Nothing is downloaded into the Git repository; the
files go to the local object store (MinIO).

## What it loads

| Kind | Count | Source | Licence |
| --- | --- | --- | --- |
| 360 photos of rooms (lounges, bedrooms, kitchens, bathrooms, veranda, deck) | 22 | [Poly Haven](https://polyhaven.com/hdris/indoor) | CC0 1.0: public domain, any use, no credit required |
| Home videos (kitchen, bedroom, living room, suite pans, aerial of a house) | 8 | [Mixkit](https://mixkit.co/free-stock-video/) | [Mixkit Stock Video Free License](https://mixkit.co/license/#videoFree): free in commercial and non-commercial projects, including social posts; not for redistribution as stock footage |
| Music (Carefree, Wallpaper, Life of Riley, Bossa Antigua, Inspired, Easy Lemon, Fretless, Funkorama) | 8 | [Kevin MacLeod, incompetech.com](https://incompetech.com/music/royalty-free/music.html) | [CC BY 4.0](https://incompetech.com/music/royalty-free/licenses/): any use, including commercial and social posts, with credit to the composer |

The exact files are listed in `apps/worker/src/library/manifest.ts`. Each
imported asset stores its source page, licence and attribution in the
database (`MediaAsset.sourceUrl`, `license`, `attribution`), and the library
shows the credit when you hover an item.

The music licence asks for a credit wherever the reel is posted. Each song
stores its credit line, and the sample reels end their caption with it
("Music: "Carefree" Kevin MacLeod (incompetech.com), licensed under CC BY
4.0"). Keep that line when you post a reel that uses one of these songs.
Chart music cannot be bundled: add it in Instagram itself when you post.

Each song's tempo and first beat are detected on import (and in the browser
for songs you upload), which is what **Snap cuts to the beat** uses.

360 photos are stored at 4096×2048. That is what the renderer uses, and what
phones load comfortably; the originals are 8K.

## Sample reels

| Reel | What it shows |
| --- | --- |
| Country house tour | A video opener, three 360 rooms with camera sweeps, labels, a warm look, fades |
| City apartment | Video and 360 clips mixed, outline and label text styles |
| Sea-view retreat (360) | Four 360 rooms only |

## Home tours with a floor plan (Zillow Indoor Dataset)

ReelWalk can show a floor plan on the reel with a marker that moves to where
each shot was taken. That needs media that knows its position on a plan. The
[Zillow Indoor Dataset (ZInD)](https://github.com/zillow/zind) has exactly
that: 360 photos of every room of a home, the floor plan, and each photo's
position and direction on it.

```bash
# once: put a ZInD tour folder where the importer looks (this folder is git-ignored)
git clone https://github.com/zillow/zind
mkdir -p data/zind && cp -r zind/sample_tour data/zind/

docker compose run --rm import-zind
```

For each tour this creates a **Tour** (the floor plan), one located 360 photo
per room in the library, and a sample reel, "Floor plan walkthrough", that
walks the rooms in viewing order with the plan marker and room names.

The importer also creates the sample tour in each of the five vibes:

| Reel | Speaks to | Song | Look and pace |
| --- | --- | --- | --- |
| First keys | First-time buyers | Carefree | Warm, every room, friendly labels |
| The numbers | Investors | Funkorama | Neutral, fast, facts up front, floor plan on |
| Work from home | Remote workers | Fretless | Cool, unhurried, the bonus room as an office |
| Made for hosting | People who entertain | Bossa Antigua | Vivid, living, dining and kitchen only |
| Blank canvas | Renovators and design lovers | Inspired | Black and white, slow, no labels |

The same choice is offered on the home screen: pick a vibe, then
**Auto-build a tour**.

**Licence: local testing only.** Zillow licenses ZInD data for academic,
non-commercial use ([terms](https://bridgedataoutput.com/zillowterms)). The
data is therefore not in the ReelWalk repository, each imported asset is labelled
with that licence, and reels made from it should not be posted. Zillow's public
zind repository includes one sample tour; the full dataset needs an access request
to Zillow.

## 3D flythroughs (Gaussian splatting)

A camera move through a room, rendered from a 3D reconstruction of it. This
needs an NVIDIA GPU and Docker with GPU support, and runs outside the app:

```bash
# once: the sample scenes (680 MB), unpacked on the host
curl -L -o data/splat/tandt_db.zip https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/datasets/input/tandt_db.zip
mkdir -p data/splat/tandt_db && tar -xf data/splat/tandt_db.zip -C data/splat/tandt_db db/playroom

# train (about 6 minutes on an RTX 4070) and render a 14 s vertical flythrough
docker run --rm --gpus all --shm-size 8g   -v "$PWD/data/splat:/data" -v "$PWD/infra/splat:/scripts:ro"   ghcr.io/nerfstudio-project/nerfstudio:latest bash /scripts/reconstruct.sh playroom

# add it to the library, with a sample reel
docker compose run --rm import-flythrough
```

The flythrough is then an ordinary video clip in the library. How it works,
what it costs and its limits are in
[ADR 0007](adr/0007-splat-flythroughs-as-offline-video.md).

### A whole home from its 360 photos

The same idea for a tour, which has only one or two 360 photos per room. A
depth model, fitted to the room shapes in the tour, stands in for the
overlap a splat normally needs, and the splat is filmed along the route of a
tour reel:

```bash
docker build -t reelwalk-splat infra/splat
docker compose run --rm import-zind node_modules/.bin/tsx src/export-camera-path.ts sample-zind-000 > data/splat/house-poses.json
docker run --rm --gpus all --shm-size 8g   -v "$PWD/data/zind:/zind:ro" -v "$PWD/data/splat:/data"   -v reelwalk-hf:/root/.cache/huggingface -v "$PWD/infra/splat:/scripts:ro"   --entrypoint bash reelwalk-splat /scripts/house.sh
docker compose run --rm import-flythrough
```

About 25 minutes on an RTX 4070. What it is good and bad at is in
[ADR 0009](adr/0009-house-splat-from-360-photos.md).

**Licence: local testing only.** The sample scenes are research data (Deep
Blending, distributed with the 3D Gaussian Splatting paper). They are not in
the repository, and reels made from them should not be posted. A flythrough
of your own capture is yours to post.

## Why not Zillow listing videos

Listing photos and videos on zillow.com belong to the agents and
photographers who made them, and Zillow's terms of use forbid downloading
them with automated tools. Reels made from them could not be shown publicly.

## Your own 360 photos

Any 2:1 image at least 2000 px wide is treated as a 360 photo: Ricoh Theta,
Insta360 and similar cameras save this format. The clip opens with a quarter
turn; the **360 view** tool sets where the camera starts, how far it turns,
tilt and zoom, or shows the image flat.
