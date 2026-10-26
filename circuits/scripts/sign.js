// secp256k1 ECDSA signer — issuer side of the credential signature, matching
// Noir's std::ecdsa_secp256k1::verify_signature. The message signed is the raw
// 32-byte commitment (prehash:false, so z = commitment), which the circuit
// passes straight to verify_signature. Uses the frontend's @noble/curves.
//
//   node sign.js <commitment-decimal>   -> issuer_x/issuer_y/sig TOML lines
//   node sign.js --pubkey               -> demo issuer pubkey (x/y byte arrays)
//   node sign.js --pubkey-hex           -> demo issuer pubkey as 64-byte hex (x||y)
//
// DEMO KEY ONLY. A real issuer keeps its secret key private and off the client.

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

function sign(commitment, sk = DEMO_SK) {
  // prehash:false -> sign the raw 32-byte commitment as the digest.
  const sig = secp256k1.sign(be32(commitment), sk, { prehash: false });
  return { ...pubkey(sk), sig };
}

module.exports = { sign, pubkey, DEMO_SK };

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
    const { x, y, sig } = sign(BigInt(arg));
    console.log(`issuer_x = ${arr(x)}`);
    console.log(`issuer_y = ${arr(y)}`);
    console.log(`sig = ${arr(sig)}`);
  }
}
