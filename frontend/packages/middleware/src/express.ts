import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ClaimType } from "@stellarcred/sdk";
import {
  evaluateClaimGate,
  buildGateRedirectUrl,
  buildGateFailureBody,
  assertNonEmptyClaims,
  type ClaimGateOptions,
  type ClaimGateResult,
} from "./core";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by {@link stellarCredGate} once the request passes the gate. */
      stellarcred?: ClaimGateResult & { wallet: string };
    }
  }
}

export interface ExpressClaimGateOptions extends ClaimGateOptions {
  /**
   * Resolve the caller's Stellar wallet address from the request. Required —
   * this middleware only performs the read-only on-chain check; it does not
   * authenticate the caller. Wire it to whatever already establishes the
   * caller's wallet in your app (a verified session, a signed cookie/JWT,
   * etc.) — never trust an unauthenticated header or query param here, since
   * anyone can set those to someone else's address.
   *
   * Return `null`/`undefined` for a request with no established wallet; it
   * is treated as failing every requested claim.
   */
  getWallet: (req: Request) => string | null | undefined;
}

/**
 * Express middleware that gates a route on one or more StellarCred claims.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { stellarCredGate } from "@stellarcred/middleware/express";
 *
 * app.get(
 *   "/vault",
 *   stellarCredGate({
 *     claims: ["kyc", "funds"],
 *     minThresholds: { funds: 50000 },
 *     getWallet: (req) => req.session?.walletAddress,
 *     onFail: "redirect",
 *     returnUrl: "https://myapp.example/vault",
 *   }),
 *   (req, res) => res.json({ ok: true, wallet: req.stellarcred?.wallet }),
 * );
 * ```
 */
export function stellarCredGate(options: ExpressClaimGateOptions): RequestHandler {
  assertNonEmptyClaims(options.claims);

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const wallet = options.getWallet(req) ?? undefined;

      if (!wallet) {
        return failGate(res, options, [...options.claims]);
      }

      const result = await evaluateClaimGate(wallet, options);
      if (!result.ok) {
        return failGate(res, options, result.missing);
      }

      req.stellarcred = { ...result, wallet };
      next();
    } catch (err) {
      next(err);
    }
  };
}

function failGate(res: Response, options: ExpressClaimGateOptions, missing: ClaimType[]) {
  if (options.onFail === "redirect") {
    const url = buildGateRedirectUrl(missing, options);
    return res.redirect(302, url);
  }
  return res.status(403).json(buildGateFailureBody(options.claims, missing));
}
