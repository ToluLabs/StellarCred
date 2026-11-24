"use client";

import React from "react";
import Link from "next/link";
import {
  IconSitemap,
  IconPalette,
  IconTypography,
  IconDeviceMobile,
} from "@tabler/icons-react";
import { Badge } from "@/components/Badge";
import { useToast } from "@/components/Toast";
import { Input } from "@/components/primitives/Input";
import { CodeBlock } from "@/components/primitives/CodeBlock";
import { Text, Heading } from "@/components/primitives/Text";
import { Button } from "@/components/primitives/Button";

/**
 * Component Showcase — documents every shared primitive.
 * Links to the docs page from the navigation.
 */
export default function ComponentShowcasePage() {
  return (
    <>
      <section
        style={{
          paddingTop: "3rem",
          marginBottom: "4rem",
        }}
      >
        <div style={{ marginBottom: "1rem" }}>
          <Text variant="xs" eyebrow>
            Design System
          </Text>
          <Heading level={1}>Component Library</Heading>
        </div>
        <Text variant="lg" color="muted" style={{ maxWidth: 560, marginBottom: "2.5rem" }}>
          A consistent set of UI primitives — Badge, Button, Card, Modal, Toast,
          Input, Text, and CodeBlock. Each consumes the same design tokens so
          spacing, color, radius, and typography stay in sync across the app.
        </Text>

        {/* Quick visual index */}
        <div
          className="grid grid-3"
          style={{ gap: "1rem" }}
        >
          {[
            { name: "Badge", desc: "Status chip with dot + label", icon: <IconTypography size={18} stroke={1.6} color="var(--accent)" /> },
            { name: "Button", desc: "Primary / secondary / ghost / link", icon: <IconDeviceMobile size={18} stroke={1.6} color="var(--accent)" /> },
            { name: "Card", desc: "Raised surface with optional hover", icon: <IconSitemap size={18} stroke={1.6} color="var(--accent)" /> },
            { name: "Modal", desc: "Focus-trapped dialog with backdrop", icon: <IconPalette size={18} stroke={1.6} color="var(--accent)" /> },
            { name: "Toast", desc: "Auto-dismissing notification stack", icon: <IconTypography size={18} stroke={1.6} color="var(--accent)" /> },
            { name: "Input", desc: "Consistent form field with label", icon: <IconTypography size={18} stroke={1.6} color="var(--accent)" /> },
          ].map((item) => (
            <div
              key={item.name}
              className="card"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
                padding: "var(--spacing-xl, 1rem)",
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "var(--radius-sm)",
                  background: "rgba(62,207,142,0.08)",
                  border: "1px solid rgba(62,207,142,0.18)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                {item.icon}
              </div>
              <div>
                <Text variant="sm" color="accent" fontWeight={600}>
                  {item.name}
                </Text>
                <Text variant="sm" color="muted">
                  {item.desc}
                </Text>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Badge variants ─────────────────────────────────────────── */}
      <section style={{ marginTop: "4rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <Text variant="xs" eyebrow style={{ marginBottom: "0.5rem" }}>
            Primitives
          </Text>
          <Heading level={2}>Badge</Heading>
        </div>
        <Text variant="base" color="muted" style={{ marginBottom: "1.5rem", maxWidth: 560 }}>
          Used to surface status (verified / pending / denied) on credential cards
          and elsewhere. Neutral by default; semantic variants for each state.
        </Text>
        <div
          className="card"
          style={{
            padding: "var(--spacing-xl, 1.5rem)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-lg, 1rem)",
          }}
        >
          <div
            className="row"
            style={{ gap: "var(--spacing-md, 0.75rem)", flexWrap: "wrap" }}
          >
            <Badge variant="neutral">Neutral</Badge>
            <Badge variant="verified">Verified</Badge>
            <Badge variant="pending">Pending</Badge>
            <Badge variant="denied">Denied</Badge>
          </div>
          <div
            className="row"
            style={{ gap: "var(--spacing-md, 0.75rem)", flexWrap: "wrap" }}
          >
            <Badge variant="verified" dot={false}>Verified (no dot)</Badge>
            <Badge variant="pending" dot>Pending (with dot)</Badge>
            <Badge variant="denied" dot>Denied (with dot)</Badge>
          </div>
          <div
            className="row faint"
            style={{ gap: "var(--spacing-md, 0.75rem)", fontSize: "var(--type-sm)" }}
          >
            <span>Example usage:</span>
            <CodeBlock style={{ fontSize: "var(--type-xs)" }}>
              {"<Badge variant=\"verified\" dot={false}>Held</Badge>"}
            </CodeBlock>
          </div>
        </div>
      </section>

      {/* ── Button variants ────────────────────────────────────────── */}
      <section style={{ marginTop: "4rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <Text variant="xs" eyebrow style={{ marginBottom: "0.5rem" }}>
            Primitives
          </Text>
          <Heading level={2}>Button</Heading>
        </div>
        <Text variant="base" color="muted" style={{ marginBottom: "1.5rem", maxWidth: 560 }}>
          Three visual styles (primary / secondary / ghost / link) plus sizes (sm / md / lg).
          Disabled state is automatic. Used in CredCard actions, nav, and CTAs.
        </Text>
        <div
          className="card"
          style={{
            padding: "var(--spacing-xl, 1.5rem)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-lg, 1rem)",
          }}
        >
          <div
            className="row"
            style={{ gap: "var(--spacing-md, 0.75rem)", flexWrap: "wrap" }}
          >
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="link">Link</Button>
          </div>
          <div
            className="row"
            style={{ gap: "var(--spacing-md, 0.75rem)", flexWrap: "wrap" }}
          >
            <Button variant="primary" size="sm">Small primary</Button>
            <Button variant="secondary" size="sm">Small secondary</Button>
            <Button variant="ghost" size="sm">Small ghost</Button>
          </div>
          <div
            className="row"
            style={{ gap: "var(--spacing-md, 0.75rem)", flexWrap: "wrap" }}
          >
            <Button variant="primary" size="lg">Large primary</Button>
            <Button variant="secondary" size="lg">Large secondary</Button>
          </div>
          <div
            className="row"
            style={{ gap: "var(--spacing-md, 0.75rem)", flexWrap: "wrap" }}
          >
            <Button variant="primary" disabled>Disabled primary</Button>
            <Button variant="secondary" disabled>Disabled secondary</Button>
            <Button variant="ghost" disabled>Disabled ghost</Button>
          </div>
          <div
            className="row faint"
            style={{ gap: "var(--spacing-md, 0.75rem)", fontSize: "var(--type-sm)" }}
          >
            <span>Example usage:</span>
            <CodeBlock style={{ fontSize: "var(--type-xs)" }}>
              {"<Button variant=\"primary\" size=\"sm\">Generate proof</Button>"}
            </CodeBlock>
          </div>
        </div>
      </section>

      {/* ── Card ───────────────────────────────────────────────────── */}
      <section style={{ marginTop: "4rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <Text variant="xs" eyebrow style={{ marginBottom: "0.5rem" }}>
            Primitives
          </Text>
          <Heading level={2}>Card</Heading>
        </div>
        <Text variant="base" color="muted" style={{ marginBottom: "1.5rem", maxWidth: 560 }}>
          Raised surface with a subtle top-edge shimmer. Optional link hover state
          lifts the card. Used for feature cards, credential cards, and info panels.
        </Text>
        <div
          className="grid grid-2"
          style={{ gap: "var(--spacing-lg, 1.25rem)" }}
        >
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md, 0.85rem)" }}>
            <Text variant="sm" color="accent" fontWeight={600}>
              Basic card
            </Text>
            <Text variant="base">
              Default card uses <code>card</code> class with standard padding and
              border. Content is sized naturally inside.
            </Text>
          </div>
          <div className="card card-link" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md, 0.85rem)" }}>
            <Text variant="sm" color="accent" fontWeight={600}>
              Link card (hoverable)
            </Text>
            <Text variant="base">
              Add <code>card-link</code> to enable the lift + border transition on
              hover. Wrap in a link for clickable cards.
            </Text>
          </div>
        </div>
        <div
          className="row faint"
          style={{ gap: "var(--spacing-md, 0.75rem)", fontSize: "var(--type-sm)", marginTop: "var(--spacing-lg, 1rem)" }}
        >
          <span>Example usage:</span>
          <CodeBlock style={{ fontSize: "var(--type-xs)" }}>
            {"<div className=\"card\">{content}</div>"}
          </CodeBlock>
        </div>
      </section>

      {/* ── Modal ──────────────────────────────────────────────────── */}
      <section style={{ marginTop: "4rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <Text variant="xs" eyebrow style={{ marginBottom: "0.5rem" }}>
            Primitives
          </Text>
          <Heading level={2}>Modal</Heading>
        </div>
        <Text variant="base" color="muted" style={{ marginBottom: "1.5rem", maxWidth: 560 }}>
          Focus-trapped dialog with Escape-to-close and backdrop click-out. Portal
          rendered to <code>document.body</code> to avoid SSR/hydration issues.
        </Text>
        <div
          className="card"
          style={{ padding: "var(--spacing-xl, 1.5rem)" }}
        >
          <div style={{ display: "flex", gap: "var(--spacing-md, 0.75rem)", flexWrap: "wrap" }}>
            <Button variant="primary">
              Open modal (demo)
            </Button>
            <Button variant="secondary">Cancel</Button>
          </div>
          <Text variant="sm" color="faint" style={{ marginTop: "var(--spacing-md, 0.75rem)" }}>
            The Modal component is interactive in the app. This page documents the
            API; the dialog is not rendered here to keep the showcase static.
          </Text>
          <div className="row faint" style={{ gap: "var(--spacing-md, 0.75rem)", fontSize: "var(--type-sm)", marginTop: "var(--spacing-lg, 1rem)" }}>
            <span>Example usage:</span>
            <CodeBlock style={{ fontSize: "var(--type-xs)" }}>
              {"<Modal title=\"Verify credential\" onClose={handleClose}>"}
              {"  children"}
              {"</Modal>"}
            </CodeBlock>
          </div>
        </div>
      </section>

      {/* ── Toast ──────────────────────────────────────────────────── */}
      <section style={{ marginTop: "4rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <Text variant="xs" eyebrow style={{ marginBottom: "0.5rem" }}>
            Primitives
          </Text>
          <Heading level={2}>Toast</Heading>
        </div>
        <Text variant="base" color="muted" style={{ marginBottom: "1.5rem", maxWidth: 560 }}>
          Auto-dismissing notification stack with info / success / error variants.
          Positioned bottom-right on desktop, full-width on mobile.
        </Text>
        <div
          className="card"
          style={{ padding: "var(--spacing-xl, 1.5rem)" }}
        >
          <ToastDemo />
          <div className="row faint" style={{ gap: "var(--spacing-md, 0.75rem)", fontSize: "var(--type-sm)", marginTop: "var(--spacing-lg, 1rem)" }}>
            <span>Example usage:</span>
            <CodeBlock style={{ fontSize: "var(--type-xs)" }}>
              {"const toast = useToast();"}
              {"toast.success(\"Proof generated on-chain\");"}
            </CodeBlock>
          </div>
        </div>
      </section>

      {/* ── Input ──────────────────────────────────────────────────── */}
      <section style={{ marginTop: "4rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <Text variant="xs" eyebrow style={{ marginBottom: "0.5rem" }}>
            Primitives
          </Text>
          <Heading level={2}>Input</Heading>
        </div>
        <Text variant="base" color="muted" style={{ marginBottom: "1.5rem", maxWidth: 560 }}>
          Form field with label, helper text, and error state. Uses the same input
          styling as the rest of the app.
        </Text>
        <div
          className="card"
          style={{ padding: "var(--spacing-xl, 1.5rem)", display: "flex", flexDirection: "column", gap: "var(--spacing-md, 0.85rem)" }}
        >
          <Input label="Wallet address" placeholder="GA... or M... address" />
          <Input label="Invite code" placeholder="ABC-123" helper="Enter the 6-character code from your invite email" />
          <Input label="Amount (XLM)" placeholder="0.00" error="Amount must be greater than 0" />
          <div className="row faint" style={{ gap: "var(--spacing-md, 0.75rem)", fontSize: "var(--type-sm)" }}>
            <span>Example usage:</span>
            <CodeBlock style={{ fontSize: "var(--type-xs)" }}>
              {"<Input label=\"Wallet address\" placeholder=\"GA...\" />"}
            </CodeBlock>
          </div>
        </div>
      </section>

      {/* ── Text & Heading ─────────────────────────────────────────── */}
      <section style={{ marginTop: "4rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <Text variant="xs" eyebrow style={{ marginBottom: "0.5rem" }}>
            Primitives
          </Text>
          <Heading level={2}>Text & Heading</Heading>
        </div>
        <Text variant="base" color="muted" style={{ marginBottom: "1.5rem", maxWidth: 560 }}>
          Polymorphic text primitive with token-driven size and color. Heading
          component for h1-h4 with display font.
        </Text>
        <div
          className="card"
          style={{ padding: "var(--spacing-xl, 1.5rem)", display: "flex", flexDirection: "column", gap: "var(--spacing-md, 0.85rem)" }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm, 0.5rem)" }}>
            <Heading level={1}>Heading level 1</Heading>
            <Heading level={2}>Heading level 2</Heading>
            <Heading level={3}>Heading level 3</Heading>
            <Heading level={4}>Heading level 4</Heading>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs, 0.35rem)" }}>
            <Text variant="hero">Hero text</Text>
            <Text variant="5xl">Large heading style</Text>
            <Text variant="xl">Extra large body</Text>
            <Text variant="lg">Large</Text>
            <Text variant="base">Base body text</Text>
            <Text variant="sm">Small label</Text>
            <Text variant="xs">Extra small</Text>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm, 0.5rem)" }}>
            <Text color="muted">Muted text</Text>
            <Text color="faint">Faint text</Text>
            <Text color="accent">Accent text</Text>
            <Text color="warn">Warning text</Text>
            <Text color="danger">Danger text</Text>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm, 0.5rem)" }}>
            <Text eyebrow>Eyebrow label</Text>
            <Text gradient>Gradient accent text</Text>
          </div>
        </div>
      </section>

      {/* ── CodeBlock ──────────────────────────────────────────────── */}
      <section style={{ marginTop: "4rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <Text variant="xs" eyebrow style={{ marginBottom: "0.5rem" }}>
            Primitives
          </Text>
          <Heading level={2}>CodeBlock</Heading>
        </div>
        <Text variant="base" color="muted" style={{ marginBottom: "1.5rem", maxWidth: 560 }}>
          Consistent inline code snippet display. Replaces the ad-hoc CodeBlock
          built into app/page.tsx.
        </Text>
        <div
          className="card"
          style={{ padding: "var(--spacing-xl, 1.5rem)" }}
        >
          <CodeBlock label="TypeScript">
            {`import { Badge } from "@/components/Badge";

export function CredCard({ c }) {
  return (
    <div className="card">
      <Badge variant="verified">Held</Badge>
    </div>
  );
}`}
          </CodeBlock>
        </div>
      </section>

      {/* ── Theme toggle ───────────────────────────────────────────── */}
      <section style={{ marginTop: "4rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <Text variant="xs" eyebrow style={{ marginBottom: "0.5rem" }}>
            Theming
          </Text>
          <Heading level={2}>Dark / Light Themes</Heading>
        </div>
        <Text variant="base" color="muted" style={{ marginBottom: "1.5rem", maxWidth: 560 }}>
          All primitives consume CSS custom properties (<code>var(--text)</code>,
          <code>var(--accent)</code>, etc.) so the same component renders correctly
          in both dark and light themes. The theme is controlled via
          <code>data-theme</code> on the <code>&lt;html&gt;</code> element.
        </Text>
        <div
          className="card"
          style={{ padding: "var(--spacing-xl, 1.5rem)", display: "flex", flexDirection: "column", gap: "var(--spacing-md, 0.85rem)" }}
        >
          <div style={{ display: "flex", gap: "var(--spacing-md, 0.75rem)", flexWrap: "wrap" }}>
            {["Badge", "Button", "Card", "Modal", "Toast", "Input"].map((name) => (
              <span
                key={name}
                className="badge badge-verified"
                style={{ fontSize: "var(--type-xs)" }}
              >
                {name} works in both themes
              </span>
            ))}
          </div>
          <Text variant="sm" color="faint">
            Theme toggle in the header switches between dark (default) and light.
            All token-driven values update via CSS custom properties without any
            JavaScript re-render.
          </Text>
        </div>
      </section>

      {/* ── Back link ──────────────────────────────────────────────── */}
      <div
        style={{
          marginTop: "4rem",
          paddingTop: "2rem",
          borderTop: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Link
          href="/docs"
          className="btn btn-ghost btn-sm"
          style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm, 0.45rem)" }}
        >
          <IconSitemap size={14} stroke={1.8} />
          Back to docs
        </Link>
        <Text variant="sm" color="faint">
          StellarCred Design System · v1.0
        </Text>
      </div>
    </>
  );
}

/**
 * ToastDemo — interactive toast example for the showcase.
 */
function ToastDemo() {
  const [mounted, setMounted] = React.useState(false);
  const toast = useToast();

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div style={{ display: "flex", gap: "var(--spacing-md, 0.75rem)", flexWrap: "wrap" }}>
      <Button variant="primary" size="sm" onClick={() => toast.info("Credential exported successfully")}>
        Info toast
      </Button>
      <Button variant="secondary" size="sm" onClick={() => toast.success("Proof generated on-chain")}>
        Success toast
      </Button>
      <Button variant="ghost" size="sm" onClick={() => toast.error("Failed to submit proof")}>
        Error toast
      </Button>
    </div>
  );
}
