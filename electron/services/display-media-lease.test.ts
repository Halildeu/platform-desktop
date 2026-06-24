import { describe, expect, it } from "vitest";

import {
  DisplayMediaLease,
  shouldGrantDisplayMediaRequest,
} from "./display-media-lease";

describe("DisplayMediaLease", () => {
  it("fails closed when there is no recorder lease or active recording", () => {
    const lease = new DisplayMediaLease(1000);

    expect(lease.canGrant(10)).toBe(false);
  });

  it("allows display media only inside the bounded pre-capture lease", () => {
    const lease = new DisplayMediaLease(1000);

    expect(lease.begin(10)).toBe(1010);
    expect(lease.canGrant(1000)).toBe(true);
    expect(lease.canGrant(1010)).toBe(false);
  });

  it("allows display media while recording is active and clears when recording stops", () => {
    const lease = new DisplayMediaLease(1000);

    lease.setRecordingActive(true);
    expect(lease.canGrant(1_000_000)).toBe(true);

    lease.setRecordingActive(false);
    expect(lease.canGrant(1_000_000)).toBe(false);
  });

  it("explicit clear revokes an unused capture lease", () => {
    const lease = new DisplayMediaLease(1000);

    lease.begin(10);
    lease.clear();

    expect(lease.canGrant(20)).toBe(false);
  });

  it("display media request policy requires lease and the main frame process", () => {
    expect(
      shouldGrantDisplayMediaRequest({
        canGrantLease: false,
        requestProcessId: 10,
        mainFrameProcessId: 10,
      }),
    ).toBe(false);
    expect(
      shouldGrantDisplayMediaRequest({
        canGrantLease: true,
        requestProcessId: 11,
        mainFrameProcessId: 10,
      }),
    ).toBe(false);
    expect(
      shouldGrantDisplayMediaRequest({
        canGrantLease: true,
        requestProcessId: 10,
        mainFrameProcessId: 10,
      }),
    ).toBe(true);
  });
});
