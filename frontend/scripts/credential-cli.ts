import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCredentialDocument, serializeCredentialDocument } from "../lib/credential-json";

function usage(): never {
  throw new Error(
    "Usage: pnpm credential:cli -- <export|import> <input.json> <output.json>\n" +
      "Both commands validate and preserve the app's plaintext credential JSON format.",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const [command, inputArg, outputArg, ...extra] = args;
  if (
    !command ||
    !inputArg ||
    !outputArg ||
    extra.length ||
    !["export", "import"].includes(command)
  )
    usage();

  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const inputPath = resolve(invocationDirectory, inputArg);
  const outputPath = resolve(invocationDirectory, outputArg);
  if (inputPath === outputPath) {
    throw new Error("Input and output paths must differ; the source file will not be overwritten.");
  }

  const credentialDocument = parseCredentialDocument(await readFile(inputPath, "utf8"));
  await writeFile(outputPath, serializeCredentialDocument(credentialDocument), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(`${command} complete: ${outputPath}`);
  console.warn(
    "This plaintext file contains sensitive credential data. Store it securely and delete it when no longer needed.",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown credential transfer error";
  console.error(`Credential CLI failed: ${message}`);
  process.exitCode = 1;
});
