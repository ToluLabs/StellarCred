import path from "node:path";
import { fileURLToPath } from "node:url";
import { Application } from "typedoc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..").replace(/\\/g, "/");

async function buildDocs() {
  const app = await Application.bootstrapWithPlugins({
    entryPoints: [
      `${packageRoot}/src/index.ts`,
      `${packageRoot}/src/server.ts`,
      `${packageRoot}/src/react.ts`,
      `${packageRoot}/src/testing.ts`,
    ],
    tsconfig: `${packageRoot}/tsconfig.json`,
    out: `${packageRoot}/docs/api`,
    readme: `${packageRoot}/README.md`,
    name: "@stellarcred/sdk",
    excludePrivate: true,
    excludeProtected: true,
    excludeInternal: true,
    githubPages: true,
    highlightLanguages: [
      "typescript",
      "javascript",
      "bash",
      "json",
      "vue",
      "svelte",
      "tsx",
    ],
  });

  const project = await app.convert();
  if (!project) {
    console.error("TypeDoc conversion failed.");
    process.exit(1);
  }

  await app.generateDocs(project, `${packageRoot}/docs/api`);
  console.log("TypeDoc API reference generated successfully at docs/api/");
}

buildDocs().catch((err) => {
  console.error("Error generating documentation:", err);
  process.exit(1);
});
