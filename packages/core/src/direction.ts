import { z } from "zod";

/**
 * Direction for a presenter take (ADR 0069): tone, energy, eye line and
 * blocking, each mapped to the words that move Veo and the image model.
 * Yesterday's honest-listings reel asked for "deadpan and dry" in prose and
 * got a smile on every line; the levers that hold are physical ones (what
 * the lips and eyebrows do, where she stands in the first frame), so the
 * composed still carries the expression and the pose, and the Veo prompt
 * repeats them as actions, never as adjectives alone.
 */
export const DIRECTION_TONES = ["dry", "warm", "excited", "hushed"] as const;
export type DirectionTone = typeof DIRECTION_TONES[number];
export const DIRECTION_ENERGIES = ["still", "natural", "animated"] as const;
export type DirectionEnergy = typeof DIRECTION_ENERGIES[number];
export const EYE_LINES = ["lens", "off-left", "off-right"] as const;
export type EyeLine = typeof EYE_LINES[number];
export const BLOCKINGS = ["stand", "walk-in-left", "walk-in-right", "turn-to-object", "lean-in", "step-back-reveal"] as const;
export type Blocking = typeof BLOCKINGS[number];

export const DIRECTION_LABELS = {
  tone: { dry: "Dry", warm: "Warm", excited: "Excited", hushed: "Hushed" },
  energy: { still: "Still", natural: "Natural", animated: "Animated" },
  eyeLine: { lens: "To the lens", "off-left": "Off left", "off-right": "Off right" },
  blocking: { stand: "Stand", "walk-in-left": "Walk in from left", "walk-in-right": "Walk in from right", "turn-to-object": "Turn to object", "lean-in": "Lean in", "step-back-reveal": "Step back, reveal" },
} as const;

/** A reference performance: up to three seconds of a clip, described by the vision model into words the prompt can carry. */
export const PERFORMANCE_MAX_MS = 3000;
export const performanceRefSchema = z.object({
  assetId: z.string().min(1).max(64),
  fromMs: z.number().int().min(0).max(86_400_000),
  toMs: z.number().int().min(0).max(86_400_000),
  /** What the reference does (delivery, expression, gesture), as the vision model described it. */
  description: z.string().trim().min(3).max(400).optional(),
}).refine(ref => ref.toMs > ref.fromMs && ref.toMs - ref.fromMs <= PERFORMANCE_MAX_MS, `A performance reference is at most ${PERFORMANCE_MAX_MS / 1000} seconds.`);

export const aiDirectionSchema = z.object({
  tone: z.enum(DIRECTION_TONES).optional(),
  energy: z.enum(DIRECTION_ENERGIES).optional(),
  eyeLine: z.enum(EYE_LINES).optional(),
  blocking: z.enum(BLOCKINGS).optional(),
  /** What she turns to or reveals ("the pool", "the view"); used by turn-to-object and step-back-reveal. */
  object: z.string().trim().min(1).max(60).optional(),
  performance: performanceRefSchema.optional(),
});
export type AiDirection = z.infer<typeof aiDirectionSchema>;

/** Whether any direction was given at all. */
export const hasDirection = (direction: AiDirection | null | undefined): direction is AiDirection =>
  Boolean(direction && (direction.tone || direction.energy || direction.eyeLine || direction.blocking || direction.performance?.description));

const side = (eyeLine: EyeLine) => eyeLine === "off-left" ? "to her left, past the camera" : "to her right, past the camera";

/**
 * What Veo is told. Physical, repeatable instructions: Veo honours what the
 * face and body do more than how the line should feel. Kept to the point,
 * since the voiced prompt also carries the line and the accent.
 */
export function directionPrompt(direction: AiDirection | null | undefined): string {
  if (!direction) return "";
  const object = direction.object ?? "the room behind her";
  const tone: Record<DirectionTone, string> = {
    dry: "Deadpan delivery: her face stays flat and unsmiling for the whole take, lips level and closed between phrases, eyebrows still; she never grins or laughs. A flat, even voice with no lift at the end of a sentence.",
    warm: "Warm delivery: a soft smile that reaches her eyes, relaxed shoulders, an easy conversational voice.",
    excited: "Excited delivery: wide bright eyes, a big smile, eyebrows up, quick lively speech; she leans a little toward the camera.",
    hushed: "Hushed delivery, as if sharing a secret: she leans in slightly and speaks quietly, almost a whisper, small mouth movements, eyes steady.",
  };
  const energy: Record<DirectionEnergy, string> = {
    still: "She stands completely still: no hand gestures, no weight shift; only her face moves.",
    natural: "Small natural gestures, one hand at most, her weight settled.",
    animated: "Animated: open hand gestures, head movement, she shifts her weight as she talks.",
  };
  const eyeLine: Record<EyeLine, string> = {
    lens: "She looks straight into the lens the whole time.",
    "off-left": `She looks ${side("off-left")}, as if to someone standing there, never into the lens.`,
    "off-right": `She looks ${side("off-right")}, as if to someone standing there, never into the lens.`,
  };
  const blocking: Record<Blocking, string> = {
    stand: "She stays on her mark for the whole take.",
    "walk-in-left": "She walks in from the left edge of the frame, stops on her mark in the middle third and turns to camera before she speaks.",
    "walk-in-right": "She walks in from the right edge of the frame, stops on her mark in the middle third and turns to camera before she speaks.",
    "turn-to-object": `She starts turned toward ${object}, then turns to camera as she begins the line.`,
    "lean-in": "As she starts the line she leans in toward the lens, her face coming closer, and holds there.",
    "step-back-reveal": `She starts close to the lens, filling the frame, then steps back and to one side as she speaks, revealing ${object}.`,
  };
  return [
    direction.tone ? tone[direction.tone] : "",
    direction.energy ? energy[direction.energy] : "",
    direction.eyeLine ? eyeLine[direction.eyeLine] : "",
    direction.blocking ? blocking[direction.blocking] : "",
    direction.performance?.description ? `Match the delivery of this reference performance: ${direction.performance.description}` : "",
  ].filter(Boolean).join(" ");
}

/**
 * What the composed still shows, for one end of the take. The first frame
 * fixes her expression and her pose, which Veo continues from; blocking that
 * moves her gives the first and last frames different poses.
 */
export function directionStill(direction: AiDirection | null | undefined, end: "first" | "last"): string {
  if (!direction) return "";
  const object = direction.object ?? "the room behind her";
  const tone: Record<DirectionTone, string> = {
    dry: "Her expression is neutral and unsmiling, lips closed and level, eyebrows relaxed.",
    warm: "A soft, friendly smile.",
    excited: "A big bright smile, eyebrows raised, eyes wide.",
    hushed: "A small, conspiratorial expression, lips slightly parted, as if about to whisper.",
  };
  const eyeLine: Record<EyeLine, string> = {
    lens: "Her eyes look straight into the lens.",
    "off-left": `Her eyes look ${side("off-left")}, not into the lens.`,
    "off-right": `Her eyes look ${side("off-right")}, not into the lens.`,
  };
  const blocking: Record<Blocking, Record<"first" | "last", string>> = {
    stand: { first: "", last: "" },
    "walk-in-left": { first: "She is mid-stride at the left edge of the frame, turning toward camera.", last: "She stands on her mark in the middle third, facing camera." },
    "walk-in-right": { first: "She is mid-stride at the right edge of the frame, turning toward camera.", last: "She stands on her mark in the middle third, facing camera." },
    "turn-to-object": { first: `She is turned three-quarters away from the camera, toward ${object}.`, last: "She faces the camera squarely." },
    "lean-in": { first: "She stands upright on her mark.", last: "She leans in toward the lens, her face nearer and larger." },
    "step-back-reveal": { first: "She is very close to the lens, her head and shoulders filling the upper frame.", last: `She has stepped back and to one side; ${object} is clear behind her.` },
  };
  return [
    direction.tone ? tone[direction.tone] : "",
    direction.eyeLine ? eyeLine[direction.eyeLine] : "",
    direction.blocking ? blocking[direction.blocking][end] : "",
  ].filter(Boolean).join(" ");
}
