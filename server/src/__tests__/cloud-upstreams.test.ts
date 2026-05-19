import { describe, expect, it } from "vitest";

import { HttpError } from "../errors.js";
import { cloudUpstreamRemoteFailureReport } from "../services/cloud-upstreams.js";

describe("cloud upstream remote failures", () => {
  it("preserves the cloud response body and message on run reports", () => {
    const body = {
      error: "bad_request",
      message: "entities[42].body must be an object",
      errors: [{ path: "entities[42].body" }],
    };

    expect(cloudUpstreamRemoteFailureReport(new HttpError(400, "bad_request", body))).toEqual({
      error: "bad_request",
      errorMessage: "entities[42].body must be an object",
      details: body,
    });
  });

  it("falls back to the thrown error message for non-remote failures", () => {
    expect(cloudUpstreamRemoteFailureReport(new Error("network failed"))).toEqual({
      error: "network failed",
    });
  });
});
