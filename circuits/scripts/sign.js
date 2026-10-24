// secp256k1 ECDSA-  issuer side of the credential signature, matching
// Noir's std::ecdsa_secp256k1::verify_signature. The message signed is the raw
// 32-byte commitment (prehash:false, so z = commitment), which the circuit
// passes straight to verify_signature. Uses the frontend's @noble/curves.
//
//   node sign.js <commitment-decimal>   -> issuer_x/issuer_y/sig TOML lines
//   node sign.js --pubkey               -> demo issuer pubkey (x/y byte arrays)
//   node sign.js --pubkey-hex           -> demo issuer pubkey as 64-byte hex (x||y)
//
// DEMO IEY ONLY. A real issuer keeps its secret key private and off the client.

const path = require("path");
const fs = require("fs");

function loadModule(modulePath) {
  const candidates = [
    path.join(__dirname, "../../frontend/node_modules", modulePath),
    path.join(__dirname, "../../node_modules", modulePath),
    path.join(__dirname, "../node_modules", modulePath),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }

  throw new Error(`Unable to find module '${modulePath}'. Checked: ${candidates.join(", ")}`);
}

const { secp256k1 } = loadModule("@noble/curves/secp256k1.js");
const { sha256 } = loadModule("@noble/hashes/sha2.js");

// Use ISSUER_PRIVATE_KEY from env when set; fall back to the dev demo key.
const DEMO_SK = process.env.ISSUER_PRIVATE_KEY
  ? Buffer.from(process.env.ISSUER_PRIVATE_KEY, "hex")
  : sha256(new TextEncoder().encode("stellarcred-demo-issuer"));

// Serialize concurrent signing jobs that share the demo key and the module-level
// state. @noble/curves is pure and re-entrant, but the demo key derivation and
// any future shared buffers are guarded here so concurrent proof jobs cannot
// interleave on shared mutable state. The lock is a simple mutex queue that
// chains promises, so jobs run in FIFO order without starving each other.
const lockQueue = [];
let lockBusy = false;

function acquireLock() {
  if (!lockBusy) {
    lockBusy = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => lockQueue.push(resolve));
}

function releaseLock() {
  const next = lockQueue.shift();
  if (next) {
    next();
  } else {
    lockBusy = false;
  }
}

async function withLock(fn) {
  await acquireLock();
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

const be32 = (v) => {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 255n);
    v >>= 8n;
  }
  return b;
};

function pubkey(sk = DEMO_SK) {
  const p = secp256k1.getPublicKey(sk, false); // 0x04 || x(32) || y(32)
  return { x: p.slice(1, 33), y: p.slice(33, 65) };
}

function signSync(commitment, sk = DEMO_SK) {
  // prehash:false -> sign the raw 32-byte commitment as the digest.
  const sig = secp256k1.sign(be32(commitment), sk, { prehash: false });
  return { ...pubkey(sk), sig };
}

// Async variant that serializes access to shared state so concurrent proof
// jobs can sign safely. Sync variant is retained for backward compatibility.
async function sign(commitment, sk = DEMO_SK) {
  return withLock(() => signSync(commitment, sk));
}

module.exports = { sign, signSync, pubkey, withLock, DEMO_SK };

if (require.main === module) {
  const arg = process.argv[2];
  const arr = (u) => "[" + Array.from(u).join(", ") + "]";
  const hex = (u) => Buffer.from(u).toString("hex");
  if (arg === "--pubkey") {
    const { x, y } = pubkey();
    console.log(`issuer_x = ${arr(x)}`);
    console.log(`issuer_y = ${arr(y)}`);
  } else if (arg === "--pubkey-hex") {
    const { x, y } = pubkey();
    console.log(hex(x) + hex(y));
  } else {
    const { x, y, sig } = signSync(BigInt(arg));
    console.log(`issuer_x = ${arr(x)}`);
    console.log(`issuer_y = ${arr(y)}`);
    console.log(`sig = ${arr(sig)}`);
  }
}
