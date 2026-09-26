/**
 * CodeBlock — consistent inline code snippet display.
 * Replaces the ad-hoc CodeBlock built into app/page.tsx and other pages.
 *
 * Design tokens used: color.*, radius.md, type.sm, spacing.xl
 */

export interface CodeBlockProps {
  children: React.ReactNode;
  className?: string;
  /** Optional language label shown at top */
  label?: string;
  /** Optional style overrides, merged over the token-driven defaults */
  style?: React.CSSProperties;
}

export function CodeBlock({ children, className = "", label, style }: CodeBlockProps) {
  return (
    <pre
      className={`code-block ${className}`.trim()}
      style={{
        fontFamily: "var(--font-mono), monospace",
        fontSize: "var(--type-sm, 0.8rem)",
        backgroundColor: "var(--bg-raised)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "var(--spacing-xl, 1rem) var(--spacing-2xl, 1.25rem)",
        overflowX: "auto",
        lineHeight: 1.7,
        color: "var(--muted)",
        margin: 0,
        whiteSpace: "pre",
        ...style,
      }}
    >
      {label && (
        <div
          style={{
            fontFamily: "var(--font-sans, system-ui, sans-serif)",
            fontSize: "var(--type-xs, 0.65rem)",
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--muted)",
            marginBottom: "var(--spacing-sm, 0.375rem)",
          }}
        >
          {label}
        </div>
      )}
      <code style={{ color: "var(--text)" }}>{children}</code>
    </pre>
  );
}
