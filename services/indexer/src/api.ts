      }
      if (
        parsedUrl.protocol !== "https:" ||
        parsedUrl.username ||
        parsedUrl.password ||
        parsedUrl.hostname.length === 0 ||
        isIP(parsedUrl.hostname) !== 0 ||
        parsedUrl.hostname === "localhost" ||
        parsedUrl.hostname.endsWith(".localhost") ||
        parsedUrl.hostname.endsWith(".local")
      ) {
        res.status(400).json({
          error: "url must be an HTTPS URL with a public DNS hostname and no credentials",
        });
        return;
      }
      if (
        typeof wallet !== "string" ||
        !StrKey.isValidEd25519PublicKey(wallet)
      ) {
        res.status(400).json({ error: "wallet must be a valid Stellar public key" });
        return;
      }
      if (typeof claimType !== "string" || !VALID_CLAIM_TYPES.has(claimType)) {
        res.status(400).json({
          error: `claimType must be one of: ${[...VALID_CLAIM_TYPES].join(", ")}`,
        });
        return;
      }

      const id = await db.createWebhookSubscription({
        url: parsedUrl.toString(),
        wallet,
        credential_type: claimType,
      });
      res.status(201).json({ id, wallet, claimType });
    }),
  );

  app.get(
    "/webhooks/subscriptions",
    webhookGuard,
    asyncHandler(async (req, res) => {
      const wallet = req.query["wallet"];
      if (wallet !== undefined && typeof wallet !== "string") {
        res.status(400).json({ error: "wallet must be a single value" });
        return;
      }
      res.json({
        subscriptions: await db.listWebhookSubscriptions(wallet as string | undefined),
      });
    }),
  );

  app.delete(
    "/webhooks/subscriptions/:id",
    webhookGuard,
    asyncHandler(async (req, res) => {
      const id = Number(req.params["id"]);
      if (!Number.isSafeInteger(id) || id < 1) {
        res.status(400).json({ error: "id must be a positive integer" });
        return;
      }
      if (!(await db.deleteWebhookSubscription(id))) {
        res.status(404).json({ error: "subscription not found" });
        return;
      }
      res.status(204).end();
    }),
  );

  app.get(
    "/webhooks/subscriptions/:id/deliveries",
    webhookGuard,
    asyncHandler(async (req, res) => {
      const id = Number(req.params["id"]);
      if (!Number.isSafeInteger(id) || id < 1) {
        res.status(400).json({ error: "id must be a positive integer" });
        return;
      }
      const subscriptions = await db.listWebhookSubscriptions();
      if (!subscriptions.some((subscription) => subscription.id === id)) {
        res.status(404).json({ error: "subscription not found" });
        return;
      }
      const deliveries = await db.webhookDeliveries(id, 100);
      res.json({
        deliveries: deliveries.map((delivery) => ({
          id: delivery.id,
          eventId: delivery.event_id,
          type: delivery.type,
          wallet: delivery.wallet,
          claimType: delivery.credential_type,
          expiry: delivery.expiry,
          ledgerSequence: delivery.ledger_sequence,
          occurredAt: delivery.occurred_at,
          reasonCode: delivery.reason_code,
          attempts: delivery.attempts,
          status: delivery.delivered_at !== null
            ? "delivered"
            : delivery.attempts >= MAX_WEBHOOK_DELIVERY_ATTEMPTS
              ? "failed"
              : "retrying",
          deliveredAt: delivery.delivered_at,
          lastError: delivery.last_error,
        })),
      });
    }),
  );

  // â”€â”€ 404 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // â”€â”€ Error handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[indexer/api] unhandled error:", err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
