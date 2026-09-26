/**
 * Button — consistent button primitive with variants and sizes.
 *
 * Variants: primary | secondary | ghost | link
 * Sizes: sm | md | lg
 *
 * Uses CSS classes from globals.css for state-based styling (hover, focus, disabled)
 * while token-driven inline styles handle geometry (padding, fontSize, radius).
 *
 * Design tokens used: color.*, radius.sm, type.base/lg, spacing.*
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "link";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual variant */
  variant?: ButtonVariant;
  /** Size variant */
  size?: ButtonSize;
  /** When true, renders as an anchor tag styled as a button */
  as?: "button" | "a";
  /** If as="a", the href to navigate to */
  href?: string;
  /** Additional className */
  className?: string;
  /** Children */
  children: React.ReactNode;
  /** Internal ref forwarding */
  ref?: React.Ref<HTMLButtonElement | HTMLAnchorElement>;
}

const sizeStyle: Record<ButtonSize, React.CSSProperties> = {
  sm: {
    padding: "var(--spacing-sm, 0.38rem) var(--spacing-md, 0.7rem)",
    fontSize: "var(--type-sm, 0.8125rem)",
  },
  md: {
    padding: "var(--spacing-md, 0.6rem) var(--spacing-xl, 1.1rem)",
    fontSize: "var(--type-base, 0.875rem)",
  },
  lg: {
    padding: "var(--spacing-lg, 0.75rem) var(--spacing-3xl, 1.5rem)",
    fontSize: "var(--type-xl, 0.9375rem)",
    borderRadius: "var(--radius)",
  },
};

const baseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--spacing-sm, 0.45rem)",
  fontFamily: "inherit",
  fontWeight: 500,
  letterSpacing: "-0.01em",
  borderRadius: "var(--radius-sm)",
  border: "1px solid transparent",
  cursor: "pointer",
  whiteSpace: "nowrap",
  textDecoration: "none",
  transition: "background 0.15s var(--ease), border-color 0.15s var(--ease), box-shadow 0.15s var(--ease), opacity 0.15s var(--ease), transform 0.07s var(--ease)",
};

export function Button({
  variant = "primary",
  size = "md",
  as: Tag = "button",
  href,
  className = "",
  children,
  disabled,
  style,
  ref,
  ...props
}: ButtonProps) {
  const classes = [
    "btn",
    "btn-" + variant,
    size !== "md" ? "btn-" + size : "",
    className,
  ].filter(Boolean).join(" ");

  const geometryStyle: React.CSSProperties = {
    ...baseStyle,
    ...sizeStyle[size],
    ...style,
  };

  if (Tag === "a" && href) {
    return (
      <a
        href={href}
        ref={ref as React.Ref<HTMLAnchorElement>}
        className={classes}
        style={geometryStyle}
        {...(props as unknown as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {children}
      </a>
    );
  }

  return (
    <button
      className={classes}
      style={geometryStyle}
      disabled={disabled}
      ref={ref as React.Ref<HTMLButtonElement>}
      {...props}
    >
      {children}
    </button>
  );
}
