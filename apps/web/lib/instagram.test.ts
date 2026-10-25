import { describe, expect, it } from "vitest";
import { InstagramError, instagramErrorMessage, isTransientInstagramError } from "./instagram";

describe("Instagram publishing failures", () => {
  it("tells an invalidated token to reconnect, rather than change the sound", () => {
    const error = new InstagramError("The session has been invalidated because the user changed their password.", 400, 190, false);
    expect(instagramErrorMessage(error)).toBe("Your Instagram connection has expired. Reconnect it on the Account tab.");
    expect(isTransientInstagramError(error)).toBe(false);
  });

  it("explains missing permissions and preserves genuine audio refusal details", () => {
    expect(instagramErrorMessage(new InstagramError("Permission denied", 403, 200, false))).toContain("missing an Instagram permission");
    expect(instagramErrorMessage(new InstagramError("The audio is not available.", 400, 100, false))).toBe("The audio is not available.");
  });
});
