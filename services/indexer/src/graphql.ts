/* graphql.ts — GraphQL schema and resolver wiring for the indexer.

Provides a single `claims` query supporting filtering by wallet,
credential_type, issuer, active/revoked, verified time range, and offset
pagination. Uses the existing `Db` interface's `queryClaims` method so the
REST and GraphQL layers share the same storage semantics.
*/

import type { RequestHandler } from "express";
import type { Db } from "./db";

export function createGraphqlMiddleware(db: Db): RequestHandler {
  // Lazily require GraphQL-related packages so environments that don't have
  // the optional dependencies installed can still import the module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { graphqlHTTP } = require("express-graphql");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildSchema } = require("graphql");

  const schema = buildSchema(`
    type Claim { id: Int! wallet: String! credential_type: String! issuer: String! verified_at: Int! expiry: Int! ledger_sequence: Int! threshold: Int revoked: Int! }
    type ClaimPage { claims: [Claim!]! total: Int! limit: Int! offset: Int! }
    type Query {
      claims(
        wallet: String,
        credential_type: String,
        issuer: String,
        active: Boolean,
        verifiedFrom: Int,
        verifiedTo: Int,
        limit: Int,
        offset: Int
      ): ClaimPage!
    }
  `);

  const root = {
    claims: async (args: any) => {
      const filter = {
        wallet: args.wallet ?? null,
        credential_type: args.credential_type ?? null,
        issuer: args.issuer ?? null,
        active: typeof args.active === "boolean" ? args.active : null,
        verifiedFrom: typeof args.verifiedFrom === "number" ? args.verifiedFrom : null,
        verifiedTo: typeof args.verifiedTo === "number" ? args.verifiedTo : null,
      };

      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 500) : 20;
      const offset = typeof args.offset === "number" && args.offset >= 0 ? args.offset : 0;

      const page = await db.queryClaims(filter, limit, offset);
      return {
        claims: page.claims,
        total: page.total,
        limit,
        offset,
      };
    },
  };

  return graphqlHTTP({ schema, rootValue: root, graphiql: process.env.NODE_ENV !== "production" });
}
