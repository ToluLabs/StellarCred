# StellarCred Webhook Integration Guide

This guide describes how to configure, receive, and verify asynchronous issuance callbacks from external identity providers (Persona, Plaid, or custom providers) using StellarCred's dedicated webhook endpoint (#846).

---

## 1. Overview

During credential verification and issuance, some external checks (such as government ID document review or fraud checks) complete asynchronously. External providers send webhook HTTP POST notifications to StellarCred to update verification status.

The dedicated endpoint:

```http
POST /api/webhooks/issuance
```

- **Authentication**: HMAC-SHA256 signature verification via `X-Issuance-Signature` or `X-Webhook-Signature`.
- **Reconciliation**: Automatically normalizes callback payloads and records issuance state.
- **Privacy & Security**: Zero sensitive keys, tokens, or PII are logged or stored.

---

## 2. Environment Configuration

Set the shared webhook secret in your server environment:

```env
ISSUANCE_WEBHOOK_SECRET=your_secure_random_hmac_secret_here
```

Generate a secure secret using OpenSSL or Node.js:

```bash
openssl rand -hex 32
```

---

## 3. Webhook Request Specification

### Headers

| Header | Description |
|:---|:---|
| `Content-Type` | `application/json` |
| `X-Issuance-Signature` | Hex HMAC-SHA256 signature, or `sha256=<hex>`, or timestamped `t=<ts>,v1=<hex>`. |
| `X-Request-Id` | *(Optional)* Unique request ID for distributed tracing. |

### Payload Formats

#### Standard Issuance Callback

```json
{
  "eventId": "evt_9876543210",
  "provider": "custom_kyc_provider",
  "eventType": "issuance.completed",
  "status": "completed",
  "credentialType": "kyc",
  "timestamp": 1700000000000,
  "inquiryId": "inq_abc123",
  "walletAddress": "GBZXN7PIRZGNMHGA728JDOQTT2TWSTTRNMG2YJYBC6QUFFJWDT5V37O7",
  "metadata": {
    "jurisdiction": "USA",
    "tier": 2
  }
}
```

#### Status Values

- `completed` (or `approved`, `success`): The credential issuance succeeded.
- `failed` (or `rejected`, `declined`): The credential check was denied.
- `pending`: Asynchronous verification is underway.

---

## 4. Provider Configuration

### Configuring Persona

1. Go to your **Persona Dashboard** -> **Integrations** -> **Webhooks**.
2. Click **Create Webhook**.
3. Set the Destination URL:
   ```text
   https://your-domain.com/api/webhooks/issuance
   ```
4. Subscribe to events:
   - `inquiry.completed`
   - `inquiry.approved`
   - `inquiry.declined`
5. Copy the Persona Signing Secret and set it as `ISSUANCE_WEBHOOK_SECRET` in your deployment environment.

### Configuring Custom Providers

To sign webhooks from your own microservice:

```javascript
// Node.js example
const crypto = require("crypto");

function createSignature(bodyString, secret) {
  return crypto.createHmac("sha256", secret).update(bodyString).digest("hex");
}

const payload = JSON.stringify({
  eventId: "evt_12345",
  provider: "my_kyc",
  status: "completed",
  credentialType: "kyc",
  timestamp: Date.now()
});

const signature = createSignature(payload, process.env.ISSUANCE_WEBHOOK_SECRET);

fetch("https://your-domain.com/api/webhooks/issuance", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Issuance-Signature": signature
  },
  body: payload
});
```

---

## 5. Security and Privacy Guarantees

1. **Constant-Time Verification**: Signatures are compared using constant-time algorithms (`crypto.timingSafeEqual`) to prevent timing side-channel attacks.
2. **Replay Protection**: Timestamped signatures (`t=...,v1=...`) must be within 5 minutes of server time.
3. **No Key Exposure**: Secrets are never echoed in HTTP responses or logged to stdout.
4. **PII Sanitization**: Internal payload parsers strip out any sensitive credentials, SSNs, passwords, or tokens before state persistence.
