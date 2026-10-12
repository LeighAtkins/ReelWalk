import Link from "next/link";
import { PLANS } from "@reelwalk/core";
import { BrandMark, InstagramIcon } from "@/components/icons";
import type { SampleReel } from "@/lib/sample-reels";
import { PricingSection } from "./pricing";
import styles from "./landing.module.css";

export const CONTACT_EMAIL = "hello@reelwalking.com";
export const INSTAGRAM_URL = "https://www.instagram.com/reelwalking";

/** The price of the add-on a photographer sells the agent; the upsell maths is built on it. */
const REEL_ADDON_USD = 150;

/**
 * What a signed-out visitor sees at /: a marketing page for real-estate
 * photographers. Server-rendered, no script: the pricing switch is CSS.
 */
export function Landing({ samples }: { samples: SampleReel[] }) {
  const agent = PLANS.AGENT;
  const reelsToPayYear = Math.ceil(agent.priceUsdYearly / REEL_ADDON_USD);
  const monthsFromOne = Math.floor(REEL_ADDON_USD / agent.priceUsd);
  return (
    <div className={styles.page}>
      <SiteHeader />

      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroText}>
            <h1 id="hero-title" data-testid="hero-title">
              Turn every listing into a reel the agent will post
            </h1>
            <p className={styles.lede}>
              Drop in the listing photos, 360 panos and the clips on your phone. Cut it in the browser, with music on the beat and the
              address on screen. ReelWalk renders it in the cloud and posts it to Instagram in one tap.
            </p>
            <div className={styles.ctas}>
              <Link href="/signup" className="btn btn-signal" data-testid="hero-cta">
                Start free, no card
              </Link>
              <a href="#sample" className="btn btn-quiet" data-testid="see-sample">
                See a sample
              </a>
            </div>
            <p className={`${styles.fine} muted`}>
              {PLANS.FREE.exportsPerMonth} reels a month free. Works in the browser on iPhone and Android, nothing to install.
            </p>
          </div>
          <SampleReels samples={samples} />
        </section>

        <section className={styles.how} aria-labelledby="how-title">
          <h2 id="how-title">Three steps, about ten minutes</h2>
          <ol className={styles.steps}>
            <li>
              <span className={styles.stepClip}>
                <span className={`timecode ${styles.stepTime}`}>0:00</span>
              </span>
              <h3>Pick the shots</h3>
              <p>Photos from the shoot, 360 panos, a phone clip of the street. Pick them on your phone the way you would for a post.</p>
            </li>
            <li>
              <span className={styles.stepClip}>
                <span className={`timecode ${styles.stepTime}`}>0:04</span>
              </span>
              <h3>Cut it on the beat</h3>
              <p>
                Choose a song with the beat already found, let the cuts land on it, add the price, the beds and baths, the open-house time.
              </p>
            </li>
            <li>
              <span className={styles.stepClip}>
                <span className={`timecode ${styles.stepTime}`}>0:11</span>
              </span>
              <h3>Render and post</h3>
              <p>The cloud renders the full-size vertical video while you drive to the next shoot. Post it to Instagram in one tap, or hand the agent a link.</p>
            </li>
          </ol>
        </section>

        <section className={styles.forPhotographers} aria-labelledby="photographers-title">
          <div>
            <h2 id="photographers-title">For listing photographers</h2>
            <p className={styles.lede}>
              You already have the best shots of the house. The agent wants a reel for the launch post and has no time to make one. Sell it as
              an add-on to every shoot.
            </p>
            <p>
              No timeline to fight with on a laptop at night: the edit is a few taps on the phone you are already holding, and the render happens
              somewhere else. The address, price and your studio name are typed once and kept for the next listing.
            </p>
          </div>
          <dl className={styles.math} data-testid="upsell-math">
            <div>
              <dt>A social reel add-on</dt>
              <dd className="timecode">${REEL_ADDON_USD}</dd>
            </div>
            <div>
              <dt>{agent.name} plan for a year</dt>
              <dd className="timecode">${agent.priceUsdYearly}</dd>
            </div>
            <div className={styles.mathResult}>
              <dt>Sell it on {reelsToPayYear} listings</dt>
              <dd>and the year is paid for. One pays for {monthsFromOne} months.</dd>
            </div>
          </dl>
        </section>

        <PricingSection viewer={{ signedIn: false }} />

        <section className={styles.faq} aria-labelledby="faq-title">
          <h2 id="faq-title">Questions</h2>
          <details>
            <summary>Where does the video get made?</summary>
            <p>
              In the cloud. Your phone only shows the preview; the full 1080×1920 render runs on our servers and lands in your exports a few
              minutes later, even if you close the tab.
            </p>
          </details>
          <details>
            <summary>Does it work on my phone?</summary>
            <p>Yes, in the browser on iPhone (Safari) and Android (Chrome). Nothing to install, and the same edit opens on a laptop.</p>
          </details>
          <details>
            <summary>Who owns the reels?</summary>
            <p>
              You do. You keep all rights to your photos, clips and the videos made from them. Included library music and 360 rooms are openly
              licensed, and the credit is added for you where one is needed.
            </p>
          </details>
          <details>
            <summary>Can I cancel?</summary>
            <p>
              Any time, from your account. A monthly plan runs to the end of the month you paid for; a yearly one to the end of the year. Your
              reels stay yours either way.
            </p>
          </details>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

/** The marketing pages' top bar: brand, plans, sign in, start. Shared by / and /pricing. */
export function SiteHeader({ plansHref = "#pricing" }: { plansHref?: string }) {
  return (
    <header className={styles.top}>
      <Link href="/" className="brand">
        <BrandMark />
        ReelWalk
      </Link>
      <nav className={styles.topNav} aria-label="Site">
        <a href={plansHref}>Plans</a>
        <Link href="/login">Sign in</Link>
        <Link href="/signup" className="btn btn-signal" data-testid="top-cta">
          Start free
        </Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <span className="brand">
        <BrandMark />
        ReelWalk
      </span>
      <nav aria-label="Footer">
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        <a href={INSTAGRAM_URL} rel="noopener" target="_blank">
          <InstagramIcon size={16} />
          @reelwalking
        </a>
      </nav>
    </footer>
  );
}

/**
 * The sample reels, in phone frames. With no SAMPLE_REEL_URL set, one drawn
 * frame stands in: a floor plan sketch with the caption bar, so the layout
 * reads the same once a real export is dropped in.
 */
function SampleReels({ samples }: { samples: SampleReel[] }) {
  return (
    <div className={styles.samples} id="sample" data-testid="sample" data-count={samples.length}>
      {samples.length === 0 ? (
        <figure className={styles.phone} data-placeholder="true">
          <div className={styles.placeholder} aria-hidden="true">
            <span className={styles.sketch}>
              <span className={styles.room} style={{ gridArea: "a" }} />
              <span className={styles.room} style={{ gridArea: "b" }} />
              <span className={styles.room} style={{ gridArea: "c" }} />
              <span className={styles.room} style={{ gridArea: "d" }} />
              <span className={styles.marker} />
            </span>
            <span className={styles.captionBar}>
              <strong>14 Harbour Lane</strong>
              <span>3 bed, 2 bath, open Saturday 11 to 12</span>
            </span>
            <span className={`chip timecode ${styles.placeholderTime}`}>0:14</span>
          </div>
          <figcaption className="visually-hidden">A sample walkthrough reel will appear here.</figcaption>
        </figure>
      ) : (
        samples.map((sample, index) => (
          <figure key={sample.src} className={styles.phone}>
            <video
              src={sample.src}
              poster={sample.poster ?? undefined}
              autoPlay={index === 0}
              muted
              loop
              playsInline
              preload={index === 0 ? "auto" : "metadata"}
              controls={index > 0}
              aria-label={`Sample reel ${index + 1}`}
            />
          </figure>
        ))
      )}
    </div>
  );
}
