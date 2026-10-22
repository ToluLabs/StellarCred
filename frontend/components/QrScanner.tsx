"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import type jsQRType from "jsqr";

export function QrScanner({
  title = "Scan QR code",
  hint = "Point your camera at a StellarCred QR code.",
  onScan,
  onClose,
}: {
  title?: string;
  hint?: string;
  onScan: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    // jsqr is lazy-loaded: it's only needed while the camera loop is actually
    // decoding frames, and QrScanner itself is only mounted via next/dynamic
    // (ssr:false) — but a static import would still pin it in the verify
    // chunk for every visitor of the page, scanner open or not.
    let jsQR: typeof jsQRType | null = null;

    async function tick() {
      if (!jsQR) {
        try {
          ({ default: jsQR } = await import("jsqr"));
        } catch {
          return;
        }
        if (cancelled || !jsQR) return;
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(frame.data, frame.width, frame.height);
      if (code?.data) {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        onScan(code.data);
        return;
      }
      frameRef.current = requestAnimationFrame(tick);
    }

    async function start() {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setError(
          "Camera access requires a secure (HTTPS) context. Use the paste option below."
        );
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        if (!cancelled) tick();
      } catch (e) {
        if (cancelled) return;
        const name = (e as { name?: string }).name;
        setError(
          name === "NotAllowedError"
            ? "Camera access was denied. Allow camera access in your browser settings and try again."
            : name === "NotFoundError"
              ? "No camera found on this device."
              : "Couldn't access the camera.",
        );
      }
    }

    start();

    return () => {
      cancelled = true;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // onScan/onClose intentionally excluded — re-running this effect would
    // restart the camera stream on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal title={title} onClose={onClose}>
      {error ? (
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "var(--danger)", fontSize: "0.875rem", marginBottom: "1rem" }}>{error}</p>
          <button
            type="button"
            onClick={() => {
              const text = window.prompt("Paste QR code content:");
              if (text) onScan(text.trim());
            }}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              cursor: "pointer",
            }}
          >
            Paste QR content instead
          </button>
        </div>
      ) : (
        <div
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: "1",
            borderRadius: "var(--radius)",
            overflow: "hidden",
            background: "#000",
          }}
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- live camera feed, not pre-recorded media */}
          <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <p className="faint" style={{ fontSize: "0.8rem", marginTop: "1rem", textAlign: "center" }}>
        {hint}
      </p>
    </Modal>
  );
}
