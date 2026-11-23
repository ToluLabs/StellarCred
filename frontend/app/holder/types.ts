import type { Credential } from "@/lib/credential";

export type PageView =
  | { kind: "list" }
  | { kind: "single"; cred: Credential }
  | { kind: "batch"; creds: Credential[] };

export type BulkAction = {
  type: "remove-selected" | "clear-expired";
  commitments: string[];
};
