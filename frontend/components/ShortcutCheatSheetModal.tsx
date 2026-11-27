"use client";

import { Modal } from "@/components/Modal";

interface ShortcutEntry {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  heading: string;
  items: ShortcutEntry[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    heading: "Navigation",
    items: [
      { keys: ["/"], description: "Focus credential search" },
      { keys: ["j", "↓"], description: "Next credential" },
      { keys: ["k", "↑"], description: "Previous credential" },
      { keys: ["Esc"], description: "Clear selection / close modal" },
    ],
  },
  {
    heading: "Triage Actions",
    items: [
      { keys: ["v"], description: "View details for active credential" },
      { keys: ["p"], description: "Prove or re-prove active credential" },
      { keys: ["x"], description: "Toggle batch selection" },
      { keys: ["e"], description: "Open export data modal" },
    ],
  },
  {
    heading: "General",
    items: [{ keys: ["?"], description: "Show keyboard shortcuts" }],
  },
];

export interface ShortcutCheatSheetModalProps {
  onClose: () => void;
}

/**
 * In-app keyboard shortcut reference modal for power-user credential triage.
 */
export function ShortcutCheatSheetModal({ onClose }: ShortcutCheatSheetModalProps) {
  return (
    <Modal id="shortcut-cheat-sheet" title="Keyboard Shortcuts" onClose={onClose} maxWidth="440px">
      <div className="stack" style={{ gap: "1.1rem" }}>
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.heading} aria-label={group.heading}>
            <h3
              className="eyebrow"
              style={{
                fontSize: "0.6875rem",
                marginBottom: "0.5rem",
                color: "var(--faint)",
              }}
            >
              {group.heading}
            </h3>
            <div className="stack" style={{ gap: "0.4rem" }}>
              {group.items.map((item) => (
                <div
                  key={item.description}
                  className="between"
                  style={{
                    fontSize: "0.8125rem",
                    padding: "0.25rem 0",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span>{item.description}</span>
                  <span className="row" style={{ gap: "0.25rem" }}>
                    {item.keys.map((k, idx) => (
                      <span key={k} className="row" style={{ gap: "0.25rem" }}>
                        {idx > 0 && (
                          <span className="faint" style={{ fontSize: "0.7rem" }}>
                            /
                          </span>
                        )}
                        <kbd className="kbd">{k}</kbd>
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}
