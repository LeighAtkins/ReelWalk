"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptFor, VENUE_VIBES, venueVibeById } from "@reelwalk/core";
import { createVenueReel, importStockVideo, searchStockVideos } from "@/app/venue-actions";
import type { LibraryAsset } from "@/lib/library";
import type { StockVideo } from "@/lib/stock";
import { formatDuration } from "@/lib/format";
import { uploadFile } from "./editor/upload";
import { CheckIcon, PlusIcon } from "./icons";

/**
 * The restaurant and café reel builder: who you are, what you serve, the
 * mood, and the shots. Shots come from your library, your phone, or free
 * stock footage. Tap order is clip order. The result opens in the editor.
 */

type Dish = { name: string; price: string };
type Source = "library" | "upload" | "stock";

const EMPTY_DISHES: Dish[] = [
  { name: "", price: "" },
  { name: "", price: "" },
  { name: "", price: "" },
];

export function VenueBuilder({ library, stockConfigured }: { library: LibraryAsset[]; stockConfigured: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [cuisine, setCuisine] = useState("");
  const [priceFrom, setPriceFrom] = useState("");
  const [address, setAddress] = useState("");
  const [handle, setHandle] = useState("");
  const [dishes, setDishes] = useState<Dish[]>(EMPTY_DISHES);
  const [vibeId, setVibeId] = useState(VENUE_VIBES[0]!.id);
  const [assets, setAssets] = useState<LibraryAsset[]>(library);
  const [picked, setPicked] = useState<string[]>([]);
  const [source, setSource] = useState<Source>("library");
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [stock, setStock] = useState<StockVideo[]>([]);
  const [stockState, setStockState] = useState<"idle" | "busy" | "unconfigured" | "error">(stockConfigured ? "idle" : "unconfigured");
  const [importing, setImporting] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const vibe = venueVibeById(vibeId)!;
  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  async function upload(files: File[]) {
    setError(null);
    for (const file of files) {
      const key = `${file.name}-${file.size}`;
      setUploads((current) => ({ ...current, [key]: 0 }));
      try {
        const asset = await uploadFile(file, (fraction) => setUploads((current) => ({ ...current, [key]: fraction })));
        setAssets((current) => [asset, ...current]);
        setPicked((current) => [...current, asset.id]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `Could not upload ${file.name}.`);
      } finally {
        setUploads((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    }
  }

  async function search() {
    setStockState("busy");
    const result = await searchStockVideos(query);
    if (!result.ok) {
      setStockState(result.unconfigured ? "unconfigured" : "error");
      setError(result.unconfigured ? null : result.error);
      return;
    }
    setStock(result.videos);
    setStockState("idle");
  }

  async function useStock(video: StockVideo) {
    setImporting((current) => [...current, video.id]);
    const result = await importStockVideo({ id: video.id });
    setImporting((current) => current.filter((id) => id !== video.id));
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAssets((current) => (current.some((asset) => asset.id === result.asset.id) ? current : [result.asset, ...current]));
    setPicked((current) => (current.includes(result.asset.id) ? current : [...current, result.asset.id]));
  }

  function build() {
    setError(null);
    start(async () => {
      const result = await createVenueReel({
        vibeId,
        assetIds: picked,
        details: { name, cuisine, priceFrom, address, handle, dishes: dishes.filter((dish) => dish.name.trim() !== "") },
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.push(`/reels/${result.id}`);
    });
  }

  const visual = assets.filter((asset) => asset.kind !== "AUDIO" && !asset.isPano);
  const ready = name.trim() !== "" && picked.length >= 2 && !pending;

  return (
    <div className="steps">
      <section className="card">
        <h2>1 · The place</h2>
        <label className="field">
          Name
          <input className="text-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="Café Lumen" data-testid="venue-name" required />
        </label>
        <div className="field-grid">
          <label className="field">
            What you serve
            <input className="text-input" value={cuisine} onChange={(event) => setCuisine(event.target.value)} maxLength={40} placeholder="Neapolitan pizza" />
          </label>
          <label className="field">
            Prices from
            <input className="text-input" value={priceFrom} onChange={(event) => setPriceFrom(event.target.value)} maxLength={16} placeholder="$12" data-testid="venue-price" />
          </label>
        </div>
        <div className="field-grid">
          <label className="field">
            Address
            <input className="text-input" value={address} onChange={(event) => setAddress(event.target.value)} maxLength={80} placeholder="14 Harbour St" />
          </label>
          <label className="field">
            Instagram
            <input className="text-input" value={handle} onChange={(event) => setHandle(event.target.value)} maxLength={40} placeholder="@cafelumen" />
          </label>
        </div>
      </section>

      <section className="card">
        <h2>2 · The menu</h2>
        <p className="muted small">One dish per clip, in this order. Leave a row empty to skip it.</p>
        {dishes.map((dish, index) => (
          <div className="dish-row" key={index}>
            <input
              className="text-input"
              value={dish.name}
              onChange={(event) => setDishes((current) => current.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))}
              maxLength={40}
              placeholder={["Margherita", "Burrata", "Tiramisu", "House red"][index] ?? "Dish"}
              aria-label={`Dish ${index + 1}`}
              data-testid="dish-name"
            />
            <input
              className="text-input"
              value={dish.price}
              onChange={(event) => setDishes((current) => current.map((item, i) => (i === index ? { ...item, price: event.target.value } : item)))}
              maxLength={12}
              placeholder="$14"
              aria-label={`Price ${index + 1}`}
              data-testid="dish-price"
            />
          </div>
        ))}
        {dishes.length < 10 ? (
          <button type="button" className="btn btn-quiet" onClick={() => setDishes((current) => [...current, { name: "", price: "" }])}>
            <PlusIcon size={18} />
            Another dish
          </button>
        ) : null}
      </section>

      <section className="card">
        <h2>3 · The vibe</h2>
        <div className="vibe-chips" role="radiogroup" aria-label="Vibe">
          {VENUE_VIBES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={option.id === vibeId}
              className="vibe-chip"
              onClick={() => setVibeId(option.id)}
              data-testid="venue-vibe"
            >
              {option.name}
            </button>
          ))}
        </div>
        <p className="muted small">{vibe.mood}</p>
      </section>

      <section className="card">
        <h2>4 · The shots</h2>
        <p className="muted small">Tap in the order you want them. Two to ten clips; dishes are labelled in the same order.</p>
        <div className="segmented" role="tablist" aria-label="Where from">
          {(["library", "upload", "stock"] as Source[]).map((option) => (
            <button key={option} type="button" role="tab" aria-pressed={source === option} aria-selected={source === option} onClick={() => setSource(option)}>
              {option === "library" ? "Library" : option === "upload" ? "Your phone" : "Free stock"}
            </button>
          ))}
        </div>

        {source === "upload" ? (
          <label className="btn btn-signal btn-block picker-btn">
            <PlusIcon size={18} />
            Choose photos and videos
            <input
              type="file"
              multiple
              accept={acceptFor(["IMAGE", "VIDEO"])}
              data-testid="venue-upload"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (files.length > 0) void upload(files);
              }}
            />
          </label>
        ) : null}
        {Object.entries(uploads).map(([key, fraction]) => (
          <p key={key} className="muted small" role="status">
            Uploading {key.split("-").slice(0, -1).join("-")} · {Math.round(fraction * 100)}%
          </p>
        ))}

        {source === "stock" ? (
          <div className="stock">
            {stockState === "unconfigured" ? (
              <p className="muted small">
                Free stock footage comes from Pixabay and needs a free API key. Add <code>PIXABAY_API_KEY</code> to the web app and this
                tab searches thousands of food, kitchen and café clips.
              </p>
            ) : (
              <>
                <form
                  className="field-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void search();
                  }}
                >
                  <input className="text-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="pizza oven, latte art, bartender…" aria-label="Search stock footage" />
                  <button className="btn" type="submit" disabled={stockState === "busy"}>
                    {stockState === "busy" ? "Searching…" : "Search"}
                  </button>
                </form>
                <div className="library-grid">
                  {stock.map((video) => {
                    const busy = importing.includes(video.id);
                    return (
                      <button
                        key={video.id}
                        type="button"
                        className="library-item"
                        title={`Video by ${video.creator} on Pixabay`}
                        aria-label={`Use clip by ${video.creator}`}
                        disabled={busy}
                        onClick={() => void useStock(video)}
                      >
                        <img src={video.image} alt="" />
                        <span className="chip timecode">{busy ? "Adding…" : formatDuration(video.durationMs)}</span>
                      </button>
                    );
                  })}
                </div>
                {stock.length > 0 ? <p className="muted small">Clips are free to use under the Pixabay Content License; the creator is credited in the caption.</p> : null}
              </>
            )}
          </div>
        ) : null}

        <div className="library-grid">
          {visual.map((asset) => {
            const order = picked.indexOf(asset.id);
            return (
              <button
                key={asset.id}
                type="button"
                className="library-item"
                aria-pressed={order >= 0}
                aria-label={asset.fileName}
                title={asset.credit ? `${asset.fileName} (${asset.credit})` : asset.fileName}
                data-testid="venue-clip"
                onClick={() => toggle(asset.id)}
              >
                {asset.thumbUrl ? <img src={asset.thumbUrl} alt="" /> : null}
                <span className="chip timecode">{order >= 0 ? order + 1 : asset.durationMs ? formatDuration(asset.durationMs) : "Photo"}</span>
              </button>
            );
          })}
        </div>
        {visual.length === 0 ? <p className="muted small">No clips yet. Add some from your phone or search free stock.</p> : null}
      </section>

      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="btn btn-signal btn-block" disabled={!ready} onClick={build} data-testid="build-venue">
        {pending ? (
          "Building…"
        ) : (
          <>
            <CheckIcon size={18} />
            {picked.length < 2 ? "Pick at least two shots" : `Build the ${vibe.name.toLowerCase()} reel`}
          </>
        )}
      </button>
    </div>
  );
}
