"use client";

import { useState } from "react";
import Image from "next/image";
import { issuerAvatarDataUri, issuerBlurDataUri } from "@/lib/issuer-avatar";

export interface IssuerAvatarProps {
  /** Remote logo URL from issuer metadata; omit when unknown. */
  logoUrl?: string | null;
  /** Issuer secp256k1 public key (hex) — seeds the deterministic fallback avatar. */
  publicKey: string;
  /** Accessible name, e.g. the issuer's display name. */
  name: string;
  /** Rendered size in px (square). Defaults to 36. */
  size?: number;
  /** Pass through to next/image for above-the-fold avatars. */
  priority?: boolean;
}

/**
 * Issuer logo with progressive blur-up loading and a deterministic SVG
 * fallback avatar (#1052).
 *
 * - With a logo URL, renders next/image with a fixed width/height (no
 *   layout shift), a `sizes` hint for responsive sizing, and a blurred
 *   colour-wash placeholder while the logo loads.
 * - Without a logo, or when the logo fails to load, renders the
 *   deterministic identicon generated from the issuer's public key, so the
 *   same issuer always shows the same avatar.
 */
export function IssuerAvatar({
  logoUrl,
  publicKey,
  name,
  size = 36,
  priority = false,
}: IssuerAvatarProps) {
  const [failed, setFailed] = useState(false);
  const showLogo = Boolean(logoUrl) && !failed;

  const style: React.CSSProperties = {
    borderRadius: "50%",
    objectFit: "cover",
    flexShrink: 0,
    display: "block",
  };

  if (showLogo) {
    return (
      <Image
        src={logoUrl as string}
        alt={`${name} logo`}
        width={size}
        height={size}
        placeholder="blur"
        blurDataURL={issuerBlurDataUri(publicKey)}
        sizes={`${size}px`}
        priority={priority}
        onError={() => setFailed(true)}
        style={style}
      />
    );
  }

  return (
    <Image
      src={issuerAvatarDataUri(publicKey, size)}
      alt={`${name} avatar`}
      width={size}
      height={size}
      sizes={`${size}px`}
      priority={priority}
      style={style}
    />
  );
}
