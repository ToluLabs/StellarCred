import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";
import { CodeBlock } from "./CodeBlock";
import { Input } from "./Input";
import { Heading, Text } from "./Text";

describe("Button", () => {
  it("renders a <button> by default with variant/size classes", () => {
    render(<Button variant="secondary" size="sm">Generate proof</Button>);
    const btn = screen.getByRole("button", { name: "Generate proof" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.className).toContain("btn-secondary");
    expect(btn.className).toContain("btn-sm");
  });

  it("renders an <a> when as=\"a\" and href is provided", () => {
    render(<Button as="a" href="/docs" variant="ghost">Back to docs</Button>);
    const link = screen.getByRole("link", { name: "Back to docs" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/docs");
  });

  it("forwards click handlers", () => {
    let clicked = false;
    render(<Button onClick={() => (clicked = true)}>Click me</Button>);
    screen.getByRole("button", { name: "Click me" }).click();
    expect(clicked).toBe(true);
  });
});

describe("Text", () => {
  it("renders a <p> by default and maps variant + color to tokens", () => {
    render(<Text variant="lg" color="muted">Hello</Text>);
    const el = screen.getByText("Hello");
    expect(el.tagName).toBe("P");
    const style = el.getAttribute("style") ?? "";
    expect(style).toContain("var(--type-lg");
    expect(style).toContain("var(--muted)");
  });

  it("renders as a different element and applies fontWeight", () => {
    render(<Text as="span" variant="sm" color="accent" fontWeight={600}>Label</Text>);
    const el = screen.getByText("Label");
    expect(el.tagName).toBe("SPAN");
    expect(el.getAttribute("style")).toContain("font-weight: 600");
    expect(el.getAttribute("style")).toContain("var(--accent)");
  });

  it("applies eyebrow styling", () => {
    render(<Text variant="xs" eyebrow>Design System</Text>);
    const el = screen.getByText("Design System");
    expect(el.className).toContain("eyebrow");
    expect(el).toHaveStyle({ textTransform: "uppercase" });
  });
});

describe("Heading", () => {
  it.each([1, 2, 3, 4] as const)("renders h%d", (level) => {
    render(<Heading level={level}>Title</Heading>);
    expect(screen.getByRole("heading", { level, name: "Title" })).toBeInTheDocument();
  });
});

describe("Input", () => {
  it("wires the label to the input", () => {
    render(<Input label="Wallet address" />);
    expect(screen.getByLabelText("Wallet address")).toBeInTheDocument();
  });

  it("shows helper text", () => {
    render(<Input label="Invite code" helper="6 characters" />);
    expect(screen.getByText("6 characters")).toBeInTheDocument();
  });

  it("renders error styling when error={true}", () => {
    render(<Input label="Amount" error />);
    const input = screen.getByLabelText("Amount");
    expect(input.className).toContain("input-field__input--error");
    expect(input.getAttribute("style")).toContain("var(--danger)");
  });

  it("accepts a string error message and renders it", () => {
    render(<Input label="Amount" error="Amount must be greater than 0" />);
    const input = screen.getByLabelText("Amount");
    expect(input.className).toContain("input-field__input--error");
    expect(screen.getByText("Amount must be greater than 0")).toBeInTheDocument();
  });
});

describe("CodeBlock", () => {
  it("renders children inside a <pre><code>", () => {
    render(<CodeBlock>{"<Badge>Held</Badge>"}</CodeBlock>);
    expect(screen.getByText("<Badge>Held</Badge>").tagName).toBe("CODE");
  });

  it("merges style overrides over the defaults", () => {
    render(<CodeBlock style={{ fontSize: "var(--type-xs)" }}>code</CodeBlock>);
    const pre = screen.getByText("code").parentElement!;
    expect(pre.tagName).toBe("PRE");
    expect(pre.getAttribute("style")).toContain("var(--type-xs)");
    expect(pre.getAttribute("style")).toContain("white-space: pre");
  });

  it("shows an optional language label", () => {
    render(<CodeBlock label="tsx">code</CodeBlock>);
    expect(screen.getByText("tsx")).toBeInTheDocument();
  });
});
