// @stellarcred/middleware
//
// Framework-specific claim-gating middleware for StellarCred. Import the
// adapter for your framework directly so unrelated peer dependencies never
// get pulled in:
//
//   import { stellarCredGate } from "@stellarcred/middleware/express";
//   import { createStellarCredMiddleware, withStellarCredGate } from "@stellarcred/middleware/next";
//
// This root entry only re-exports the framework-agnostic types shared by
// both adapters.

export type {
  ClaimGateOptions,
  ClaimGateResult,
  ClaimGateFailureMode,
  ClaimGateFailureBody,
} from "./core";
