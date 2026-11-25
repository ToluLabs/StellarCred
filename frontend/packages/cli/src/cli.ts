// Entry point for `npx stellarcred`. The build adds the shebang.
import { run } from "./commands";

const code = await run(process.argv.slice(2), process.env, {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
process.exitCode = code;
