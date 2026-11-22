// Pure helpers for the QR scanner's camera selection, torch and targeting
// features, kept free of React/DOM state so they can be unit tested.

export interface CameraOption {
  deviceId: string;
  label: string;
}

/** Builds dropdown options from enumerateDevices() output (video inputs only). */
export function toCameraOptions(devices: ReadonlyArray<Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">>): CameraOption[] {
  return devices
    .filter((d) => d.kind === "videoinput" && d.deviceId)
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/** getUserMedia constraints: a specific camera if chosen, else the rear camera. */
export function buildVideoConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    video: deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: "environment" },
  };
}

/** True when the active track reports torch support. */
export function supportsTorch(track: MediaStreamTrack | null | undefined): boolean {
  if (!track || typeof track.getCapabilities !== "function") return false;
  const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
  return Boolean(caps.torch);
}

/** Turns the torch on/off; resolves false if unsupported or rejected. */
export async function setTorch(track: MediaStreamTrack | null | undefined, on: boolean): Promise<boolean> {
  if (!track || !supportsTorch(track)) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Bounding box (in frame pixels) of a detected QR code's corner points. */
export function boundingBoxFromCorners(corners: ReadonlyArray<Point>): BoundingBox | null {
  if (corners.length === 0) return null;
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/** Converts a frame-pixel box to percentages for overlay positioning. */
export function boxToPercent(box: BoundingBox, frameWidth: number, frameHeight: number): BoundingBox {
  if (frameWidth <= 0 || frameHeight <= 0) return { left: 0, top: 0, width: 0, height: 0 };
  return {
    left: (box.left / frameWidth) * 100,
    top: (box.top / frameHeight) * 100,
    width: (box.width / frameWidth) * 100,
    height: (box.height / frameHeight) * 100,
  };
}
