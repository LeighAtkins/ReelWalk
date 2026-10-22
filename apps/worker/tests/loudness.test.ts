import { describe, expect, it } from "vitest";
import { loudnormFilter, parseLoudnorm, withinTarget } from "../src/loudness";

const output = `[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-17.31",\n\t"input_tp" : "0.12",\n\t"input_lra" : "9.80",\n\t"input_thresh" : "-27.60",\n\t"output_i" : "-14.02",\n\t"output_tp" : "-1.00",\n\t"output_lra" : "9.70",\n\t"output_thresh" : "-24.30",\n\t"normalization_type" : "dynamic",\n\t"target_offset" : "0.02"\n}\n`;

describe("export loudness", () => {
  it("reads ffmpeg's measurement and feeds it back as a linear correction", () => {
    const measured = parseLoudnorm(output);
    expect(measured).toMatchObject({ input_i: "-17.31", input_tp: "0.12" });
    // −16 LUFS since ADR 0066 (ADR 0045 chose −14 before the library sound Instagram mixes on top was accounted for).
    expect(loudnormFilter(measured!)).toBe("loudnorm=I=-16:TP=-1:LRA=11:measured_I=-17.31:measured_TP=0.12:measured_LRA=9.80:measured_thresh=-27.60:offset=0.02:linear=true");
    expect(withinTarget(measured!)).toBe(false);
    expect(withinTarget({ ...measured!, input_i: "-16.4", input_tp: "-1.3" })).toBe(true);
  });

  it("ignores output without a measurement", () => {
    expect(parseLoudnorm("ffmpeg version 7\n")).toBeNull();
    expect(parseLoudnorm("{ not json")).toBeNull();
  });
});
