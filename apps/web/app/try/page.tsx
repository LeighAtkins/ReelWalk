import { startGuestTrial } from "../guest-actions";
import { SubmitButton } from "@/components/submit-button";
export default async function TryPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return <main className="auth"><h1>Your phone. A finished listing reel.</h1><p>Upload a 5-10 second video of each room, add exterior photos and paste your listing details. Opus makes the first cut. No account or card needed to preview.</p><p>Save your reel at export to start a seven-day full trial, including Instagram scheduling. Two AI video credits are included; you approve every use.</p>{error ? <p role="alert">{error === "limit" ? "Free studios are limited on this network. Sign in or try again tomorrow." : "Could not open your studio. Please try again or sign in."}</p> : null}<form action={startGuestTrial}><SubmitButton className="btn btn-block" pendingLabel="Opening your studio...">Make my first reel</SubmitButton></form><a href="/login">Already have an account? Sign in</a></main>;
}
