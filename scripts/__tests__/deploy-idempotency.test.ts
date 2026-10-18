/**
 * Rerun safety for scripts/deploy.sh and scripts/deploy-mainnet.sh (#806).
 *
 * Each test builds a throwaway copy of the repo layout the scripts expect and
 * puts fake `stellar` and `node` binaries first on PATH. The fake `stellar`
 * keeps its own "chain" on disk and rejects the same things the real
 * contracts do: a second `set_vk` for a type (VkAlreadySet) and a
 * `register_issuer` with a different pubkey (KeyChangeRequiresRotation).
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../..");
const CONTRACTS = ["issuer_registry", "credential_verifier", "proof_registry", "gated_pool"];
const PUBKEY = "ab".repeat(64);

const FAKE_STELLAR = `#!/usr/bin/env bash
set -euo pipefail
chain="$FAKE_CHAIN"
echo "$*" >> "$chain/calls.log"
case "$1 $2" in
  "contract build") exit 0 ;;
  "keys address") echo GADMINFAKE; exit 0 ;;
  "contract deploy")
    n=$(cat "$chain/deploy_count" 2>/dev/null || echo 0); n=$((n + 1))
    echo "$n" > "$chain/deploy_count"
    if [ "\${FAIL_DEPLOY_AT:-}" = "$n" ]; then echo "simulated deploy failure" >&2; exit 1; fi
    touch "$chain/contract-CFAKE$n"; echo "CFAKE$n"; exit 0 ;;
  "contract invoke") ;;
  *) exit 0 ;;
esac
id=""; fn=""
while [ $# -gt 0 ]; do
  case "$1" in
    --id) id="$2"; shift 2 ;;
    --) shift; fn="$1"; shift; break ;;
    *) shift ;;
  esac
done
[ -f "$chain/contract-$id" ] || { echo "contract $id not found" >&2; exit 1; }
arg() { local want="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
case "$fn" in
  version) echo 1000000 ;;
  get_issuer)
    [ -f "$chain/issuer-$id" ] || { echo "Error(Contract, #2)" >&2; exit 1; }
    cat "$chain/issuer-$id" ;;
  register_issuer)
    pk="$(arg --pubkey "$@")"; types="$(arg --credential_types "$@")"
    if [ -f "$chain/issuer-$id" ] && ! grep -q "$pk" "$chain/issuer-$id"; then
      echo "Error(Contract, #12) KeyChangeRequiresRotation" >&2; exit 1
    fi
    echo "{\\"credential_types\\":$types,\\"pubkey\\":\\"$pk\\",\\"revoked\\":false}" > "$chain/issuer-$id" ;;
  get_latest_version)
    ct="$(arg --credential_type "$@")"
    [ -f "$chain/vk-$id-$ct" ] || { echo "Error(Contract, #3) VkNotSet" >&2; exit 1; }
    echo 1 ;;
  set_vk)
    ct="$(arg --credential_type "$@")"
    [ -f "$chain/vk-$id-$ct" ] && { echo "Error(Contract, #5) VkAlreadySet" >&2; exit 1; }
    touch "$chain/vk-$id-$ct" ;;
esac
`;

const FAKE_NODE = `#!/usr/bin/env bash
echo "${PUBKEY}"
`;

let root: string;
let chain: string;

function setup() {
  root = mkdtempSync(join(tmpdir(), "deploy-idem-"));
  chain = join(root, ".chain");
  mkdirSync(chain);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/stellar"), FAKE_STELLAR);
  writeFileSync(join(root, "bin/node"), FAKE_NODE);
  chmodSync(join(root, "bin/stellar"), 0o755);
  chmodSync(join(root, "bin/node"), 0o755);

  mkdirSync(join(root, "scripts"));
  for (const f of ["deploy.sh", "deploy-mainnet.sh"]) {
    cpSync(join(REPO, "scripts", f), join(root, "scripts", f));
  }
  if (existsSync(join(REPO, "scripts/lib"))) {
    cpSync(join(REPO, "scripts/lib"), join(root, "scripts/lib"), { recursive: true });
  }
  writeFileSync(join(root, "scripts/gen-bindings.sh"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(root, "scripts/gen-bindings.sh"), 0o755);

  for (const dir of ["target/wasm32-unknown-unknown/release", "target/wasm32v1-none/release"]) {
    mkdirSync(join(root, dir), { recursive: true });
    for (const c of CONTRACTS) writeFileSync(join(root, dir, `${c}.wasm`), `wasm:${c}`);
  }
  for (const c of CONTRACTS) {
    mkdirSync(join(root, "contracts", c), { recursive: true });
    writeFileSync(join(root, "contracts", c, "Cargo.toml"), 'version = "1.0.0"\n');
  }
  for (const t of ["kyc", "age"]) {
    mkdirSync(join(root, "fixtures", t), { recursive: true });
    writeFileSync(join(root, "fixtures", t, "vk"), `vk:${t}`);
  }
}

function run(script: string, env: Record<string, string> = {}) {
  writeFileSync(join(chain, "calls.log"), "");
  const res = spawnSync("bash", [join("scripts", script)], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      FAKE_CHAIN: chain,
      ISSUER_PRIVATE_KEY: "11".repeat(32),
      SOURCE: "deployer",
      ...env,
    },
  });
  const calls = readFileSync(join(chain, "calls.log"), "utf8").split("\n").filter(Boolean);
  const vars = res.stdout
    .split("\n")
    .filter((l) => /^NEXT_PUBLIC_\w+=/.test(l))
    .join("\n");
  return {
    status: res.status,
    output: res.stdout + res.stderr,
    vars,
    deploys: calls.filter((c) => c.startsWith("contract deploy")).length,
    count: (fn: string) => calls.filter((c) => new RegExp(`-- ${fn}( |$)`).test(c)).length,
  };
}

beforeEach(setup);
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.each(["deploy.sh", "deploy-mainnet.sh"])("%s rerun", (script) => {
  it("second run reuses every resource and prints the same IDs", () => {
    const first = run(script);
    expect(first.status, first.output).toBe(0);
    expect(first.deploys).toBe(4);
    expect(first.count("register_issuer")).toBe(1);
    expect(first.count("set_vk")).toBe(2);

    const second = run(script);
    expect(second.status, second.output).toBe(0);
    expect(second.deploys).toBe(0);
    expect(second.count("register_issuer")).toBe(0);
    expect(second.count("set_vk")).toBe(0);
    expect(second.vars).toBe(first.vars);
    expect(second.vars).toContain("NEXT_PUBLIC_GATED_POOL_ID=CFAKE4");
  });

  it("resumes after a failed deploy without redeploying finished contracts", () => {
    const failed = run(script, { FAIL_DEPLOY_AT: "3" });
    expect(failed.status).not.toBe(0);

    const resumed = run(script);
    expect(resumed.status, resumed.output).toBe(0);
    expect(resumed.deploys).toBe(2);
    expect(resumed.vars).toContain("NEXT_PUBLIC_ISSUER_REGISTRY_ID=CFAKE1");
    expect(resumed.vars).toContain("NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID=CFAKE2");
  });

  it("redeploys only a recorded contract that no longer exists on chain", () => {
    expect(run(script).status).toBe(0);
    rmSync(join(chain, "contract-CFAKE4"));

    const rerun = run(script);
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.deploys).toBe(1);
    expect(rerun.vars).toContain("NEXT_PUBLIC_GATED_POOL_ID=CFAKE5");
  });

  it("DEPLOY_FRESH=1 ignores recorded state and deploys a new set", () => {
    expect(run(script).status).toBe(0);

    const fresh = run(script, { DEPLOY_FRESH: "1" });
    expect(fresh.status, fresh.output).toBe(0);
    expect(fresh.deploys).toBe(4);
    expect(fresh.count("set_vk")).toBe(2);
  });
});
