"use client";

/** Renders `text` as a QR code, returned as a `data:` image URL.
 *
 * `qrcode` (~30 KB gzipped) is lazy-loaded here because it is only needed when
 * a user actually requests a QR (the verify flow / holder copy modals), not on
 * every page that renders the layout/common chunk.
 */
export async function toQrDataUrl(text: string): Promise<string> {
  const { default: QRCode } = await import("qrcode");
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
  });
}
