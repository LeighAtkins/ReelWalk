# ReelWalk 面接ノート

A phone-first study site for explaining ReelWalk in Japanese. Static Next.js
export, published to https://leighatkins.github.io/ReelWalk/ by
`.github/workflows/learn-pages.yml` on every push that touches `apps/learn`.

```sh
pnpm --filter @reelwalk/learn dev     # http://localhost:3200
pnpm --filter @reelwalk/learn build   # static site in apps/learn/out
```

## Content

Everything the site says lives in `content/`. Japanese uses a small ruby
markup, documented at the top of `lib/types.ts`: `冪等性{べきとうせい}` for
furigana, `[Kubernetes]{クバネティス}` for how a Latin name is said.

## Audio

Every Japanese line has a recorded MP3 in `public/audio/<voice>/`, named by
`lib/audio-key.ts` from the exact text. A line without a file falls back to
the device's speech engine, which many phones lack for Japanese, so
**re-render after editing or adding lines**:

```sh
docker run -d --rm --name voicevox --gpus all -p 127.0.0.1:50021:50021 voicevox/voicevox_engine:nvidia-latest
node scripts/generate-audio.mts --voice ryusei
node scripts/generate-audio.mts --voice no7
bash scripts/encode-audio.sh          # WAV -> MP3, needs the reelwalk-worker image for ffmpeg
docker stop voicevox
```

Only lines without a file are rendered. Kanji are sent to the engine as
kanji (better pitch accent); a word is swapped for its furigana only when the
engine would read it differently. `--fixes` lists those swaps, `--list` shows
counts and Latin words left for the engine to spell out.

Voices: VOICEVOX:青山龍星 and VOICEVOX:No.7. Their terms require the credit,
which the app shows on the home page and in the voice settings.
