import {
  createSchema,
  createYoga,
  type YogaInitialContext,
} from "graphql-yoga";
import type { Db } from "./db-types";
import { toClaimRow } from "./db-types";

interface GraphQLContext extends YogaInitialContext {
  db: Db;
}

const typeDefs = /* GraphQL */ `
  type Claim {
    id: Int!
    wallet: String!
    credentialType: String!
    issuer: String!
    verifiedAt: Int!
    expiry: Int!
    ledgerSequence: Int!
    threshold: Int
    revoked: Boolean!
    reasonCode: String!
  }

  input ClaimFilter {
    wallet: String
    credentialType: String
    issuer: String
    active: Boolean
    revoked: Boolean
    verifiedAfter: Int
    verifiedBefore: Int
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type ClaimConnection {
    edges: [Claim!]!
    pageInfo: PageInfo!
  }

  type Query {
    claims(
      filter: ClaimFilter
      first: Int = 20
      after: String
    ): ClaimConnection!
  }
`;

// Cursor paging and the claim filter predicates (wallet / credentialType /
// issuer / active / revoked / verifiedAfter / verifiedBefore) are applied by
// Db.queryClaims, which both drivers implement — see db-shared.ts. The GraphQL
// layer used to carry its own copies of those helpers; the resolvers delegate,
// so the schema takes no query-building code.
export function createGraphQLSchema(_db: Db) {
  return createSchema<GraphQLContext>({
    typeDefs,
    resolvers: {
      Query: {
        claims: async (_parent: any, args: any, context: any) => {
          const { filter, first = 20, after } = args;
          const limit = Math.min(Math.max(1, first), 100);
          const db = context.db as Db;

          const result = await db.queryClaims(filter || {}, limit, after);

          const edges = result.rows.map((row: any) => {
            const claim = toClaimRow(row);
            return {
              ...claim,
              credentialType: claim.credential_type,
              verifiedAt: claim.verified_at,
              ledgerSequence: claim.ledger_sequence,
              revoked: claim.revoked !== 0,
              reasonCode: claim.reason_code,
            };
          });

          return {
            edges,
            pageInfo: {
              hasNextPage: result.hasNextPage,
              endCursor: result.endCursor,
            },
          };
        },
      },
    },
  });
}

export function createGraphQLHandler(db: Db) {
  const schema = createGraphQLSchema(db);
  return createYoga<GraphQLContext>({
    schema,
    context: async () => ({ db }),
  });
}
