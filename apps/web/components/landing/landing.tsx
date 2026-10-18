import Link from "next/link";
import { startGuestTrial } from "@/app/guest-actions";
import { SubmitButton } from "@/components/submit-button";
import { PLANS } from "@reelwalk/core";
import { BrandMark, InstagramIcon } from "@/components/icons";
import type { SampleReel } from "@/lib/sample-reels";
import { EditorMock, ExportMock, MediaSheetMock, ReelStill } from "./mocks";
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
          <h1 id="hero-title" data-testid="hero-title">
            Your phone. A professional listing reel.
          </h1>
          <div className={styles.heroRow}>
            <div className={styles.heroText}>
              <p className={styles.lede}>
                Shoot each room, add exterior photos and paste the listing. Claude Opus directs the edit: room order, natural movement, music and readable text. Watch your reel, then ask for any changes.
              </p>
              <div className={styles.ctas}>
                <form action={startGuestTrial}><SubmitButton className="btn" pendingLabel="Opening your studio...">Try free - AI credits included</SubmitButton></form>
                <a href="#sample" className="btn btn-quiet" data-testid="see-sample">
                  See a finished reel
                </a>
              </div>
              <p className={styles.fine}>
                No account or card to preview. Save at export for seven days of full access, including Instagram scheduling. Works on iPhone and Android.
              </p>
            </div>
            <SampleReels samples={samples} />
          </div>
        </section>

        <section className={styles.how} aria-labelledby="how-title" id="how">
          <div className={styles.sectionHead}>
            <h2 id="how-title">How it works</h2>
            <p className={styles.lede}>
              Three steps, all on your phone. Shoot the rooms, add the listing, approve your reel.
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
                  A 5-10 second video of each room, a few exterior photos and your listing text. Upload straight from your camera roll; Opus helps label and arrange the rooms.
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
                  Opus directs your first cut
                </h3>
                <p>
                  Opus labels the rooms, chooses the order and music, and adds your listing details. Exterior photos can become moving shots: each suggestion shows its Veo credit cost and asks for your approval.
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
                  Approve, export and schedule
                </h3>
                <p>
                  Preview the reel, then save your account at export for a seven-day full trial. Connect Instagram, add the caption and schedule. Tell Opus what to adjust whenever you need a change.
                </p>
              </div>
              <div className={styles.stepMock}>
                <ExportMock />
              </div>
            </li>

          </ol>
          <p className={styles.timeNote}>
            How long it takes: a few minutes of taps on your phone, then a few minutes of cloud render that happen without you.
          </p>
        </section>

        <section className={styles.ask} aria-labelledby="ask-title">
          <div className={styles.sectionHead}>
            <h2 id="ask-title">Or just say what you want changed</h2>
            <p className={styles.lede}>
              Watch the finished reel, type the change, and ReelWalk makes it and renders again. No timeline, no scrubbing, and undo takes
              it back.
            </p>
          </div>
          <ul className={styles.askList}>
            <li>Make the kitchen shot longer and lose the hallway.</li>
            <li>Calmer music, and start on the pool.</li>
            <li>Put the price at the end, in the thin serif.</li>
          </ul>
          <p className={styles.fine}>
            Refine your first draft during the trial. The {paid.name} plan includes {paid.aiEditsPerMonth} requests a month.
            Rendering a revised reel counts as another export.
          </p>
        </section>

        <section className={styles.facts} aria-labelledby="facts-title">
          <div className={styles.sectionHead}>
            <h2 id="facts-title">What you are signing up for</h2>
          </div>
          <ul className={styles.factList}>
            <li>Works in the browser on iPhone and Android. Nothing to install, and the same edit opens on a laptop.</li>
            <li>
              Preview without an account. Save at export for seven days of full-size, watermark-free exports, with no card. Choose a paid plan after the trial.
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
          <Link href="/try" className="btn">
            Try free - AI credits included
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
          <Link href="/try" className="btn" data-testid="top-cta">
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
