import { describe, it, expect, vi } from "vitest";
import {
  toCameraOptions,
  buildVideoConstraints,
  supportsTorch,
  setTorch,
  boundingBoxFromCorners,
  boxToPercent,
} from "../camera-controls";

describe("toCameraOptions", () => {
  it("keeps only video inputs and labels unnamed ones", () => {
    const opts = toCameraOptions([
      { kind: "audioinput", deviceId: "a", label: "Mic" },
      { kind: "videoinput", deviceId: "v1", label: "Front" },
      { kind: "videoinput", deviceId: "v2", label: "" },
    ]);
    expect(opts).toEqual([
      { deviceId: "v1", label: "Front" },
      { deviceId: "v2", label: "Camera 2" },
    ]);
  });
});

describe("buildVideoConstraints", () => {
  it("defaults to the rear camera", () => {
    expect(buildVideoConstraints()).toEqual({ video: { facingMode: "environment" } });
  });
  it("targets a chosen device", () => {
    expect(buildVideoConstraints("x")).toEqual({ video: { deviceId: { exact: "x" } } });
  });
});

describe("torch", () => {
  const track = (caps: object, apply = vi.fn().mockResolvedValue(undefined)) =>
    ({ getCapabilities: () => caps, applyConstraints: apply }) as unknown as MediaStreamTrack;

  it("detects support", () => {
    expect(supportsTorch(track({ torch: true }))).toBe(true);
    expect(supportsTorch(track({}))).toBe(false);
    expect(supportsTorch(null)).toBe(false);
  });
  it("applies the torch constraint", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    expect(await setTorch(track({ torch: true }, apply), true)).toBe(true);
    expect(apply).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
  });
  it("returns false when unsupported or rejected", async () => {
    expect(await setTorch(track({}), true)).toBe(false);
    const apply = vi.fn().mockRejectedValue(new Error("no"));
    expect(await setTorch(track({ torch: true }, apply), true)).toBe(false);
  });
});

describe("bounding box", () => {
  it("computes a box from corners", () => {
    expect(
      boundingBoxFromCorners([
        { x: 10, y: 20 },
        { x: 50, y: 22 },
        { x: 48, y: 60 },
        { x: 12, y: 58 },
      ]),
    ).toEqual({ left: 10, top: 20, width: 40, height: 40 });
    expect(boundingBoxFromCorners([])).toBeNull();
  });
  it("converts to percentages", () => {
    expect(boxToPercent({ left: 10, top: 20, width: 40, height: 40 }, 100, 200)).toEqual({
      left: 10,
      top: 10,
      width: 40,
      height: 20,
    });
    expect(boxToPercent({ left: 1, top: 1, width: 1, height: 1 }, 0, 0).width).toBe(0);
  });
});
