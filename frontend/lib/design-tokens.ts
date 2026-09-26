/**
 * Design Tokens — single source of truth for spacing, color, radius, typography.
 * Every primitive component consumes these so the whole UI stays consistent and
 * themeable (dark / light via [data-theme] on <html>).
 */

export const tokens = {
  // --- Spacing (4px base grid) ---
  spacing: {
    xs: "0.25rem",  // 4px
    sm: "0.375rem", // 6px
    md: "0.5rem",   // 8px
    lg: "0.75rem",  // 12px
    xl: "1rem",     // 16px
    "2xl": "1.5rem",
    "3xl": "2rem",
    "4xl": "3rem",
  },

  // --- Border radius ---
  radius: {
    xs: "var(--radius-xs)",   // 6px
    sm: "var(--radius-sm)",   // 8px
    md: "var(--radius)",      // 12px
    lg: "var(--radius-lg)",   // 16px
    xl: "var(--radius-xl)",   // 24px
    full: "999px",
  },

  // --- Typography scale ---
  type: {
    xs: "0.65rem",
    sm: "0.72rem",
    md: "0.75rem",
    base: "0.8125rem",
    lg: "0.875rem",
    xl: "0.9375rem",
    "2xl": "1rem",
    "3xl": "1.1rem",
    "4xl": "1.35rem",
    "5xl": "1.5rem",
    hero: "clamp(2.6rem, 6vw, 4rem)",
  },

  // --- Shadows ---
  shadow: {
    sm: "var(--shadow-sm)",
    card: "var(--shadow-card)",
    glow: "var(--shadow-glow)",
  },

  // --- Semantic color helpers (consume CSS variables) ---
  color: {
    transparent: "transparent",
    text: "var(--text)",
    muted: "var(--muted)",
    faint: "var(--faint)",
    accent: "var(--accent)",
    accentDim: "var(--accent-dim)",
    accentSoft: "var(--accent-soft)",
    warn: "var(--warn)",
    danger: "var(--danger)",
    border: "var(--border)",
    borderStrong: "var(--border-strong)",
    bg: "var(--bg)",
    bgRaised: "var(--bg-raised)",
    bgSoft: "var(--bg-soft)",
    card: "var(--card)",
    cardHover: "var(--card-hover)",
    input: "var(--input)",
    onAccent: "var(--on-accent)",
  },

  // --- Motion ---
  transition: {
    fast: "0.1s var(--ease)",
    normal: "0.15s var(--ease)",
    slow: "0.2s var(--ease)",
    hover: "0.15s var(--ease)",
  },
};

/**
 * @deprecated — use tokens.* directly. Kept for backwards compat while files migrate.
 */
export const spacing = tokens.spacing;
export const radius = tokens.radius;
export const type = tokens.type;
export const shadow = tokens.shadow;
export const color = tokens.color;
