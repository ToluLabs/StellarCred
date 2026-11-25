import { verifyRoutePresentation, validateRouteProtectionOptions, type RouteProtectionOptions, type VerifiedRouteCredential } from "./middleware";

export interface StellarCredExpressRequest {
  headers: Record<string, string | string[] | undefined>;
  stellarCred?: VerifiedRouteCredential;
}
export interface StellarCredExpressResponse { status(code: number): this; json(body: { error: string; message: string }): unknown }
export type StellarCredExpressNext = (error?: unknown) => void;

export function stellarCredExpress<Request extends StellarCredExpressRequest = StellarCredExpressRequest>(options: RouteProtectionOptions<Request>) {
  validateRouteProtectionOptions(options);
  const headerName = (options.headerName ?? "x-stellarcred-presentation").toLowerCase();
  return async (request: Request, response: StellarCredExpressResponse, next: StellarCredExpressNext): Promise<void> => {
    try {
      const raw = request.headers[headerName];
      const result = await verifyRoutePresentation(Array.isArray(raw) ? raw[0] : raw, request, options);
      if (!result.ok) {
        response.status(result.status).json({ error: "stellarcred_verification_failed", message: result.message });
        return;
      }
      request.stellarCred = result.credential;
      next();
    } catch (error) { next(error); }
  };
}
