# Route protection middleware

The SDK publishes framework adapters at @stellarcred/sdk/express and
@stellarcred/sdk/fastify. Both expect a wallet-signed challenge in the
x-stellarcred-presentation header. The value is base64url-encoded JSON with
wallet, challenge, and signature fields.

Generate the challenge server-side with createWalletChallenge from
@stellarcred/sdk/server, deliver it to the wallet to sign, then encode the
signed challenge as the header value. The middleware verifies wallet
ownership, consumes the nonce to prevent replay, verifies every schema claim
against the chain, and applies the route predicate. It fails closed: invalid
proofs receive 401, failed claim/predicate checks receive 403, and chain
verification errors receive 503.

Express example:

    import { stellarCredExpress } from "@stellarcred/sdk/express";

    app.get("/private", stellarCredExpress({
      schema: [{ type: "kyc" }, { type: "age", minThreshold: 18 }],
      predicate: ({ results }) => results.kyc === true && results.age === true,
    }), handler);

Fastify example:

    import { stellarCredFastify } from "@stellarcred/sdk/fastify";

    fastify.get("/private", {
      preHandler: stellarCredFastify({
        schema: [{ type: "kyc" }],
        predicate: ({ wallet }) => wallet.length === 56,
      }),
    }, handler);

On success, request.stellarCred contains the verified wallet, requested
claims, and results. Configure the same challengeStore instance (or a
shared, atomic implementation) in challenge issuance and verification. The
default in-memory store is suitable only for a single process; use shared
storage for multi-instance deployments. Set expectedDomain and
expectedStatement when issuing and checking application-specific challenges.
