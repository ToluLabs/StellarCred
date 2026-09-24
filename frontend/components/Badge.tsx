/**
 * Badge — status indicator with dot + text.
 * Variants: neutral | verified | pending | denied
 *
 * Consumers: CredCard, CredentialCard, anywhere a status chip is needed.
 *
 * Design tokens used: color.*, radius.full, type.sm
 */

export type BadgeVariant = "neutral" | "verified" | "pending" | "denied";

export interface BadgeProps {
  /** Visual variant */
  variant?: BadgeVariant;
  /** Children rendered as the badge label */
  children: React.ReactNode;
  /** Show the status dot (default true) */
  dot?: boolean;
  /** Additional className */
  className?: string;
  /** Render as a different element (e.g. <li>) */
  as?: keyof JSX.IntrinsicElements;
}

/**
 * Status shown with a dot + text. Neutral by default; semantic variants for
 * verified / pending / denied.
 */
export function Badge({
  variant = "neutral",
  children,
  dot = true,
  className = "",
  as: Tag = "span",
}: BadgeProps) {
  const classes = [
    "badge",
    variant !== "neutral" ? `badge-${variant}` : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={classes}>
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {children}
    </Tag>
  );
}
