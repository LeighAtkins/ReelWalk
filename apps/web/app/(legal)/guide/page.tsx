import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "The listing reel guide · ReelWalk",
  description: "Film a listing on your phone and cut a reel people watch to the end: the first second, the five shots, text, captions, and the asks that edit it for you.",
};

/**
 * The free guide sent by keyword comment replies ("Comment GUIDE", ADR 0026).
 * Public; every ask listed under "Let the app cut it" is one tested through
 * the app's own Ask (ADR 0025), so nothing here promises what the app cannot do.
 */
export default function GuidePage() {
  return (
    <article className="prose" data-testid="guide">
      <h1>The listing reel guide</h1>
      <p className="muted small">From ReelWalk · free to share</p>
      <p>
        A listing reel does not need a drone, a gimbal or crazy transitions. It needs the right first second, five steady shots, text people can
        read, and a reason to comment. Here is the whole system, on one page.
      </p>

      <h2>1. Win the first second</h2>
      <ul>
        <li>
          <strong>Open on the money shot</strong>: the single most striking view of the home. The pool at golden hour, the facade from the
          street, the room with the view. Never the front door handle, never the hallway.
        </li>
        <li>
          <strong>Text on screen from the very first frame</strong>, under seven words. People decide in under a second; a line that fades in
          after it is a line nobody reads.
        </li>
        <li>
          <strong>Give them a reason to stay</strong>: a question or a little tension. &quot;Which room would you wake up in? 1, 2 or 3&quot;,
          &quot;Guess the price&quot;, &quot;POV: you just got the keys&quot;. A label like &quot;4 bed, 2 bath&quot; is not a hook.
        </li>
      </ul>

      <h2>2. Film five shots on your phone</h2>
      <ol>
        <li>
          <strong>The money shot</strong>: outside, from the street or the garden, slow push towards the house.
        </li>
        <li>
          <strong>The arrival</strong>: the walk to the door or through it.
        </li>
        <li>
          <strong>The best room</strong>: usually the living space with the light. Walk in slowly at 0.5x (the wide lens).
        </li>
        <li>
          <strong>The view</strong>: from inside, through the glass, then out.
        </li>
        <li>
          <strong>One detail</strong>: the stone wall, the tap, the timber ceiling. Close, slow, still.
        </li>
      </ol>
      <p>
        Hold the phone upright, film in 4K at 30 frames a second, and keep each shot 4 to 6 seconds so there is room to trim. Walk slower than
        feels natural; keep vertical lines straight. Tap and hold to lock exposure on the bright room before you walk in.
      </p>

      <h2>3. Cut it short, on the beat</h2>
      <ul>
        <li>
          <strong>7 to 15 seconds</strong> for a listing. Short reels get watched to the end and watched again, and both count.
        </li>
        <li>
          <strong>Cut on the beat</strong> of the song, about one shot per beat or two. The most striking shots first.
        </li>
        <li>
          <strong>End on a frame that leads back into the start</strong>, so the loop feels like one shot.
        </li>
      </ul>

      <h2>4. Text people can read</h2>
      <ul>
        <li>
          <strong>Keep it in the middle of the screen.</strong> The bottom quarter is covered by the caption and buttons, the top tenth by the
          app, and the right edge by the like and share column.
        </li>
        <li>
          <strong>Big enough</strong>: if you have to squint on your own phone, it is too small.
        </li>
        <li>
          <strong>Over something dark and calm</strong>: sky, water, a wall. White text on a white kitchen disappears.
        </li>
        <li>
          <strong>One idea per screen.</strong> Price, open house time and your number belong on separate moments, or on a card at the end.
        </li>
      </ul>

      <h2>5. A caption that gets comments</h2>
      <ul>
        <li>First line: the same phrase that is on screen. Second line: one question people can answer in a word.</li>
        <li>
          Comments are the strongest signal a reel can get. &quot;Which room, 1, 2 or 3?&quot; gets them; &quot;DM me for details&quot; does
          not.
        </li>
        <li>Five relevant hashtags at the end are plenty.</li>
      </ul>

      <h2>6. Hooks that work for listings</h2>
      <ul>
        <li>
          <strong>Which one would you pick?</strong> Number three rooms or three views.
        </li>
        <li>
          <strong>Guess the price</strong>, then the price in the caption or the last frame.
        </li>
        <li>
          <strong>The plans vs the real thing</strong>: the floor plan or the render, then a hard cut to the finished room.
        </li>
        <li>
          <strong>POV: you just got the keys</strong>: the walk in through the door, first person.
        </li>
        <li>
          <strong>Before and after</strong>, if the vendor renovated.
        </li>
      </ul>

      <h2>7. Let the app cut it</h2>
      <p>
        <Link href="/signup">ReelWalk</Link> makes the first cut from your clips on your phone in about a minute, on the beat, with your
        details on a card at the end. Then you just ask for changes, the way you would ask an editor. These all work today:
      </p>
      <ul>
        <li>&quot;make it 15 seconds&quot; · &quot;faster cuts&quot; · &quot;first shot longer&quot;</li>
        <li>&quot;start with the deck&quot; · &quot;pool first, then the rest&quot; · &quot;drop the bathroom&quot; · &quot;only show the outside&quot;</li>
        <li>&quot;add the price $1.2m&quot; · &quot;open house saturday 2-4&quot; · &quot;add my number&quot; · &quot;say under offer&quot;</li>
        <li>&quot;bigger text&quot; · &quot;put the title lower&quot; · &quot;no text&quot;</li>
        <li>&quot;something more upbeat&quot; · &quot;brighter&quot; · &quot;make it look like a luxury listing&quot;</li>
        <li>With a 360 photo: &quot;face the door in the bedroom&quot; · &quot;bedroom shot: end on the bed&quot; · &quot;do a full spin&quot;</li>
      </ul>
      <p>
        <Link href="/signup" className="btn btn-block">
          Make your first reel free
        </Link>
      </p>
    </article>
  );
}
