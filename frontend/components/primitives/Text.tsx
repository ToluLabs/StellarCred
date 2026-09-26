/**
 * Text — a polymorphic text primitive with consistent typography.
 * Avoids inline style sprawl by using token-driven props.
 *
 * Usage:
 *   <Text variant="lg" color="muted">Hello</Text>
 *   <Heading level={2}>Title</Heading>
 */

export type TextVariant =
  | "xs" | "sm" | "md" | "base" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl" | "hero";

export interface TextProps extends React.HTMLAttributes<HTMLParagraphElement> {
  /** Which size from the type scale */
  variant?: TextVariant;
  /** Color from the semantic palette: text | muted | faint | accent | warn | danger */
  color?: "text" | "muted" | "faint" | "accent" | "warn" | "danger";
  /** When true, renders uppercase eyebrow-style text */
  eyebrow?: boolean;
  /** When true, applies gradient-text class (green gradient) */
  gradient?: boolean;
  /** Render as a different element */
  as?: "p" | "span" | "div" | "h1" | "h2" | "h3" | "h4" | "small" | "label";
  /** Font weight override (defaults to 600 when eyebrow is set) */
  fontWeight?: React.CSSProperties["fontWeight"];
  /** Additional className */
  className?: string;
}

const variantFontSize: Record<TextVariant, string> = {
  xs: "var(--type-xs, 0.65rem)",
  sm: "var(--type-sm, 0.72rem)",
  md: "var(--type-md, 0.75rem)",
  base: "var(--type-base, 0.8125rem)",
  lg: "var(--type-lg, 0.875rem)",
  xl: "var(--type-xl, 0.9375rem)",
  "2xl": "var(--type-2xl, 1rem)",
  "3xl": "var(--type-3xl, 1.1rem)",
  "4xl": "var(--type-4xl, 1.35rem)",
  "5xl": "var(--type-5xl, 1.5rem)",
  hero: "var(--type-hero, clamp(2.6rem, 6vw, 4rem))",
};

const colorMap = {
  text: "var(--text)",
  muted: "var(--muted)",
  faint: "var(--faint)",
  accent: "var(--accent)",
  warn: "var(--warn)",
  danger: "var(--danger)",
};

export function Text({
  variant = "base",
  color: colorName = "text",
  eyebrow = false,
  gradient = false,
  as = "p",
  className = "",
  children,
  style,
  fontWeight,
  ...props
}: TextProps) {
  // Polymorphic tag: typing the dynamic element as a union of intrinsic tags
  // makes the JSX checker instantiate every member (e.g. <label>, <symbol>),
  // so we widen to ElementType where the spread is accepted.
  const tagName = as as string;
  const Tag = tagName as React.ElementType;
  const classes = [
    eyebrow ? "eyebrow" : "",
    gradient ? "gradient-text" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag
      className={classes}
      style={{
        fontSize: variantFontSize[variant],
        color: colorMap[colorName],
        fontWeight: eyebrow ? 600 : fontWeight,
        letterSpacing: eyebrow ? "0.07em" : undefined,
        textTransform: eyebrow ? "uppercase" : undefined,
        margin: 0,
        lineHeight: tagName.startsWith("h") ? 1.1 : 1.6,
        ...style,
      }}
      {...props}
    >
      {children}
    </Tag>
  );
}

export interface HeadingProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /** h1-h4 */
  level?: 1 | 2 | 3 | 4;
  /** When true, renders with eyebrow styling */
  eyebrow?: boolean;
  className?: string;
}

export function Heading({
  level = 1,
  eyebrow = false,
  className = "",
  children,
  style,
  ...props
}: HeadingProps) {
  // Narrow to heading tags only — `keyof JSX.IntrinsicElements` would make the
  // JSX checker instantiate the spread against every intrinsic element (e.g.
  // <symbol>), which fails for heading attributes.
  const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
  return (
    <Tag
      className={`heading-group ${className}`.trim()}
      style={{
        fontFamily: "var(--font-display), var(--font-body), system-ui, sans-serif",
        fontWeight: 700,
        letterSpacing: eyebrow ? "-0.03em" : undefined,
        lineHeight: 1.1,
        color: "var(--text)",
        margin: 0,
        ...style,
      }}
      {...props}
    >
      {children}
    </Tag>
  );
}
