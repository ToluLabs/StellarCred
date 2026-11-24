/**
 * Input — consistent form field wrapper with label support.
 *
 * Design tokens used: color.*, radius.sm, type.base/sm, spacing.*
 */

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Label displayed above the input */
  label?: string;
  /** Helper/error text below the input */
  helper?: string;
  /** Renders in error state. Pass `true` for the styled state, or a string to
   *  also show that message below the input in the danger color. */
  error?: boolean | string;
  /** Additional className for the wrapper */
  wrapperClassName?: string;
}

export function Input({
  label,
  helper,
  error = false,
  wrapperClassName = "",
  className = "",
  id,
  ...props
}: InputProps) {
  const inputId = id || props.name || label?.toLowerCase().replace(/\s+/g, "-");
  const hasError = Boolean(error);
  const errorMessage = typeof error === "string" ? error : undefined;

  return (
    <div className={`input-field ${wrapperClassName}`.trim()}>
      {label && (
        <label
          htmlFor={inputId}
          className="field-label"
          style={{
            display: "block",
            fontSize: "var(--type-base, 0.8125rem)",
            fontWeight: 500,
            color: "var(--muted)",
            marginBottom: "var(--spacing-sm, 0.45rem)",
            letterSpacing: "-0.005em",
          }}
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`input-field__input ${className} ${hasError ? "input-field__input--error" : ""}`.trim()}
        style={{
          width: "100%",
          backgroundColor: "var(--input)",
          color: "var(--text)",
          border: `1px solid ${hasError ? "var(--danger)" : "var(--border)"}`,
          borderRadius: "var(--radius-sm)",
          padding: "var(--spacing-md, 0.625rem) var(--spacing-lg, 0.8rem)",
          fontFamily: "var(--font-mono), monospace",
          fontSize: "var(--type-base, 0.8125rem)",
          transition: "border-color var(--transition-normal, 0.15s var(--ease)), box-shadow var(--transition-normal, 0.15s var(--ease))",
          appearance: "none",
        }}
        {...props}
      />
      {(errorMessage || helper) && (
        <div
          style={{
            fontSize: "var(--type-xs, 0.72rem)",
            color: hasError ? "var(--danger)" : "var(--faint)",
            marginTop: "var(--spacing-xs, 0.25rem)",
          }}
        >
          {errorMessage || helper}
        </div>
      )}
    </div>
  );
}
