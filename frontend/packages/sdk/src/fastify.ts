import { verifyRoutePresentation, validateRouteProtectionOptions, type RouteProtectionOptions, type VerifiedRouteCredential } from "./middleware";

export interface StellarCredFastifyRequest {
  headers: Record<string, string | string[] | undefined>;
  stellarCred?: VerifiedRouteCredential;
}
export interface StellarCredFastifyReply { code(status: number): this; send(body: { error: string; message: string }): unknown }

export function stellarCredFastify<Request extends StellarCredFastifyRequest = StellarCredFastifyRequest>(options: RouteProtectionOptions<Request>) {
  validateRouteProtectionOptions(options);
  const headerName = (options.headerName ?? "x-stellarcred-presentation").toLowerCase();
  return async (request: Request, reply: StellarCredFastifyReply): Promise<void> => {
    const raw = request.headers[headerName];
    const result = await verifyRoutePresentation(Array.isArray(raw) ? raw[0] : raw, request, options);
    if (!result.ok) {
      reply.code(result.status).send({ error: "stellarcred_verification_failed", message: result.message });
      return;
    }
    request.stellarCred = result.credential;
  };
}
