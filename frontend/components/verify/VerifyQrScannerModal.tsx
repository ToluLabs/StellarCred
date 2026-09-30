"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconQrcode } from "@tabler/icons-react";
import { QrScanner } from "@/components/QrScanner";
import { useToast } from "@/components/Toast";

export interface VerifyQrScannerModalProps {
  locked: boolean;
}

export function VerifyQrScannerModal({ locked }: VerifyQrScannerModalProps) {
  const [scanning, setScanning] = useState(false);
  const router = useRouter();
  const toast = useToast();

  function onScanRequest(text: string) {
    setScanning(false);
    let dest: URL;
    try {
      dest = new URL(text, window.location.origin);
    } catch {
      toast.error("That QR code isn't a valid StellarCred verify request.");
      return;
    }

    // A real verify request always has return_url — reject anything else
    // outright rather than treating an arbitrary scanned URL as trustworthy.
    if (dest.pathname !== "/verify" || !dest.searchParams.has("return_url")) {
      toast.error("That QR code isn't a valid StellarCred verify request.");
      return;
    }

    if (dest.origin === window.location.origin) {
      // The scanned URL itself is same-origin, but its embedded return_url
      // is where the wallet address ends up after issuance — a QR can stay
      // on stellarcred.xyz throughout and still smuggle in a cross-origin
      // return_url, so that param needs the same confirmation the top-level
      // origin check gets below.
      const embeddedReturnUrl = dest.searchParams.get("return_url");
      if (embeddedReturnUrl && !embeddedReturnUrl.startsWith("/")) {
        let returnDest: URL | null = null;
        try {
          returnDest = new URL(embeddedReturnUrl);
        } catch {
          toast.error("That QR code isn't a valid StellarCred verify request.");
          return;
        }
        if (returnDest.protocol !== "https:") {
          toast.error("That QR code isn't a valid StellarCred verify request.");
          return;
        }
        if (returnDest.origin !== window.location.origin) {
          if (
            !window.confirm(
              `This code will request verification on behalf of ${returnDest.hostname}, and your wallet address will be sent there once you finish. Continue?`,
            )
          ) {
            return;
          }
        }
      }
      router.push(dest.pathname + dest.search);
    } else if (dest.protocol === "https:") {
      // Leaving the app entirely on a scanned code's say-so is exactly the
      // shape of an open-redirect/phishing risk (a malicious QR could point
      // anywhere) — confirm the destination with the user first instead of
      // silently redirecting.
      if (
        !window.confirm(
          `This code will take you to ${dest.hostname} to continue verification there. Continue?`,
        )
      ) {
        return;
      }
      window.location.href = dest.toString();
    } else {
      toast.error("That QR code isn't a valid StellarCred verify request.");
    }
  }

  if (locked) return null;

  return (
    <>
      <div style={{ textAlign: "right", marginBottom: "0.75rem" }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setScanning(true)}
        >
          <IconQrcode size={14} />
          Scan QR
        </button>
      </div>

      {scanning && (
        <QrScanner
          title="Scan a verify request"
          hint="Point your camera at the QR code a protocol displayed."
          onScan={onScanRequest}
          onClose={() => setScanning(false)}
        />
      )}
    </>
  );
}
