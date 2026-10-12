import Link from "next/link";
import { PLANS } from "@reelwalk/core";
import { BrandMark, InstagramIcon } from "@/components/icons";
import type { SampleReel } from "@/lib/sample-reels";
import { EditorMock, ExportMock, MediaSheetMock, ReelStill, ShareMock } from "./mocks";
import { PricingSection } from "./pricing";
import styles from "./landing.module.css";

export const CONTACT_EMAIL = "hello@reelwalking.com";
export const INSTAGRAM_URL = "https://www.instagram.com/reelwalking";

/**
 * What a signed-out visitor sees at /: a marketing page for real-estate
 * photographers who shoot several listings a day and edit none of them.
 * Server-rendered, no script beyond the image fallback: the pricing switch
 * is CSS, the only motion is the first sample reel playing. The page is the
 * app's own visual system (globals.css): the same navy, type and controls,
 * so the drawn screens (mocks.tsx) sit in it rather than on it.
 */
export function Landing({ samples }: { samples: SampleReel[] }) {
  const paid = PLANS.AGENT;
  return (
    <div className={styles.page}>
      <SiteHeader />

      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroText}>
            <h1 id="hero-title" data-testid="hero-title">
              Listing reels, made between shoots.
            </h1>
            <p className={styles.lede}>
              You shoot three or four houses a day and spend the rest of it driving. ReelWalk turns the photos and clips already on your
              phone into a vertical reel for the listing: a few minutes of taps, a cloud render while you are on the road, and it is
              ready to post before the next door.
            </p>
            <div className={styles.ctas}>
              <Link href="/signup" className="btn btn-signal" data-testid="hero-cta">
                Start free, no card
              </Link>
              <a href="#sample" className="btn btn-quiet" data-testid="see-sample">
                See a finished reel
              </a>
            </div>
            <p className={styles.fine}>
              {PLANS.FREE.exportsPerMonth} reels a month free. Works in the browser on iPhone and Android, nothing to install.
            </p>
          </div>
          <SampleReels samples={samples} />
        </section>

        <section className={styles.how} aria-labelledby="how-title" id="how">
          <div className={styles.sectionHead}>
            <h2 id="how-title">How it works</h2>
            <p className={styles.lede}>
              Four screens, all on your phone. These are the app&rsquo;s own screens, drawn with real rooms from the starter library, so
              you can see what you would be tapping.
            </p>
          </div>
          <ol className={styles.steps}>
            <li className={styles.step}>
              <div className={styles.stepText}>
                <h3>
                  <span className={styles.stepNo}>1</span>
                  Pick the listing&rsquo;s photos and clips
                </h3>
                <p>
                  Straight from the camera roll, or from what you have already uploaded. Tap them in the order you want them to play.
                  360 photos are welcome, and so is the clip of the street you shot on the way in.
                </p>
              </div>
              <div className={styles.stepMock}>
                <MediaSheetMock />
              </div>
            </li>
            <li className={styles.step}>
              <div className={styles.stepText}>
                <h3>
                  <span className={styles.stepNo}>2</span>
                  The editor lays them out and cuts on the beat
                </h3>
                <p>
                  They land on a timeline in your order. Pick a song from the library and the cuts move to its beat. Type the address,
                  price and beds once and it sits over the picture. A 360 photo becomes a slow camera sweep through the room.
                </p>
              </div>
              <div className={styles.stepMock}>
                <EditorMock />
              </div>
            </li>
            <li className={styles.step}>
              <div className={styles.stepText}>
                <h3>
                  <span className={styles.stepNo}>3</span>
                  It renders in the cloud while you drive
                </h3>
                <p>
                  Tap Export and put the phone down. The full-size render runs on our servers, not your phone, and keeps going if you
                  close the tab. It shows up under Exports a few minutes later.
                </p>
              </div>
              <div className={styles.stepMock}>
                <ExportMock />
              </div>
            </li>
            <li className={styles.step}>
              <div className={styles.stepText}>
                <h3>
                  <span className={styles.stepNo}>4</span>
                  Post it in one tap, or send the agent a link
                </h3>
                <p>
                  On a paid plan it posts to the Instagram account you connected, caption included. Or download the MP4, or copy a link
                  the agent can open on their own phone. The reel is yours either way.
                </p>
              </div>
              <div className={styles.stepMock}>
                <ShareMock />
              </div>
            </li>
          </ol>
          <p className={styles.timeNote}>
            How long it takes: a few minutes of taps on your phone, then a few minutes of cloud render that happen without you.
          </p>
        </section>

        <section className={styles.facts} aria-labelledby="facts-title">
          <div className={styles.sectionHead}>
            <h2 id="facts-title">What you are signing up for</h2>
          </div>
          <ul className={styles.factList}>
            <li>Works in the browser on iPhone and Android. Nothing to install, and the same edit opens on a laptop.</li>
            <li>
              A free plan with {PLANS.FREE.exportsPerMonth} reels a month and no card. It renders at {PLANS.FREE.outputWidth}×
              {(PLANS.FREE.outputWidth * 16) / 9} with a small ReelWalk mark.
            </li>
            <li>
              Paid plans render at {paid.outputWidth}×{(paid.outputWidth * 16) / 9}, Instagram&rsquo;s full size, with no mark, and post
              to Instagram in one tap.
            </li>
            <li>You keep all rights to your photos, your clips and the reels made from them.</li>
            <li>Cancel any time from your account. Your reels stay yours.</li>
            <li>The music and 360 rooms in the library are openly licensed, and the credit is added for you where one is needed.</li>
            <li>
              A real address for questions: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>, or{" "}
              <a href={INSTAGRAM_URL} rel="noopener" target="_blank">
                @reelwalking
              </a>{" "}
              on Instagram.
            </li>
          </ul>
        </section>

        <PricingSection viewer={{ signedIn: false }} />

        <section className={styles.faq} aria-labelledby="faq-title">
          <h2 id="faq-title">Questions</h2>
          <details>
            <summary>How long does one reel take?</summary>
            <p>
              A few minutes of taps on your phone to pick the shots, choose a song and type the details, then a few minutes of cloud
              render that you do not have to wait for. Start one at the curb and it is usually finished before you are at the next house.
            </p>
          </details>
          <details>
            <summary>Where does the video get made?</summary>
            <p>
              In the cloud. Your phone only shows the preview; the full render runs on our servers and lands in your exports a few minutes
              later, even if you close the tab.
            </p>
          </details>
          <details>
            <summary>Does it work on my phone?</summary>
            <p>Yes, in the browser on iPhone (Safari) and Android (Chrome). Nothing to install, and the same edit opens on a laptop.</p>
          </details>
          <details>
            <summary>Who owns the reels?</summary>
            <p>
              You do. You keep all rights to your photos, clips and the videos made from them. Included library music and 360 rooms are
              openly licensed, and the credit is added for you where one is needed.
            </p>
          </details>
          <details>
            <summary>Can I cancel?</summary>
            <p>
              Any time, from your account. A monthly plan runs to the end of the month you paid for; a yearly one to the end of the year.
              Your reels stay yours either way.
            </p>
          </details>
        </section>

        <section className={styles.closing} aria-labelledby="closing-title">
          <h2 id="closing-title">Try it on the next listing</h2>
          <p className={styles.lede}>
            Make a reel from a shoot you have already done. If it earns its keep, the Agent plan is ${paid.priceUsd} a month.
          </p>
          <Link href="/signup" className="btn btn-signal">
            Start free, no card
          </Link>
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
      <div className={styles.topInner}>
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
      </div>
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
 * Finished reels in phone frames: the proof that the output is real. The
 * first plays on its own, muted; the others wait with their poster and
 * controls. With no SAMPLE_REEL_URL set, one frame shows a still from a
 * reel instead, so the hero is finished either way.
 */
function SampleReels({ samples }: { samples: SampleReel[] }) {
  const count = samples.length;
  return (
    <figure className={styles.samples} id="sample" data-testid="sample" data-count={count}>
      <div className={styles.phones} data-count={count}>
        {count === 0 ? (
          <div className={styles.phone} data-placeholder="true">
            <ReelStill />
          </div>
        ) : (
          samples.map((sample, index) => (
            <div key={sample.src} className={styles.phone}>
              <video
                src={sample.src}
                poster={sample.poster ?? undefined}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                aria-label={`Sample reel ${index + 1}`}
              />
            </div>
          ))
        )}
      </div>
      <figcaption className={styles.samplesCaption}>
        <strong>Made with ReelWalk.</strong>{" "}
        {count > 0 ? "Finished reels, as they came out of the export. Sound is off." : "A frame from a finished listing reel."}
      </figcaption>
    </figure>
  );
}
