# Sample media library

The editor is more useful with something to edit. One command fills the media
library with 360 photos of real rooms and short home videos, and creates three
sample reels from them:

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

The exact files are listed in `apps/worker/src/library/manifest.ts`. Each
imported asset stores its source page, licence and attribution in the
database (`MediaAsset.sourceUrl`, `license`, `attribution`), and the library
shows the credit when you hover an item.

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

**Licence: local testing only.** Zillow licenses ZInD data for academic,
non-commercial use ([terms](https://bridgedataoutput.com/zillowterms)). The
data is therefore not in the ReelWalk repository, each imported asset is labelled
with that licence, and reels made from it should not be posted. Zillow's public
zind repository includes one sample tour; the full dataset needs an access request
to Zillow.

## Why not Zillow listing videos

Listing photos and videos on zillow.com belong to the agents and
photographers who made them, and Zillow's terms of use forbid downloading
them with automated tools. Reels made from them could not be shown publicly.

## Your own 360 photos

Any 2:1 image at least 2000 px wide is treated as a 360 photo: Ricoh Theta,
Insta360 and similar cameras save this format. The clip opens with a quarter
turn; the **360 view** tool sets where the camera starts, how far it turns,
tilt and zoom, or shows the image flat.
