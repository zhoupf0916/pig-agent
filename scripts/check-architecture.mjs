import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { builtinModules } from "node:module";
const root = fileURLToPath(new URL("..", import.meta.url));
const errors = [];
async function walk(directory) {
  for (const entry of await readdir(path.join(root, directory), {
    withFileTypes: true,
  })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(relative);
      continue;
    }
    if (!/\.(tsx?|m?js|cjs)$/.test(entry.name)) continue;
    const text = await readFile(path.join(root, relative), "utf8");
    const imports = ts
      .preProcessFile(text, true, true)
      .importedFiles.map((item) => item.fileName);
    for (const dependency of imports) {
      if (dependency.startsWith(".")) {
        const target = path.relative(
          root,
          path.resolve(root, directory, dependency),
        );
        const owner = relative.split(path.sep).slice(0, 2).join("/");
        if (!target.startsWith(owner + "/"))
          errors.push(
            `${relative}: 跨包源码引用 ${dependency}；请通过 workspace 包导出`,
          );
      }
      if (
        dependency.startsWith("@pig-agent/") &&
        !dependency.startsWith("@pig-agent/contracts")
      )
        errors.push(`${relative}: 应用之间禁止直接引用 ${dependency}`);
      if (
        relative.startsWith("packages/contracts/") &&
        !dependency.startsWith(".")
      )
        errors.push(`${relative}: contracts 必须保持平台无关：${dependency}`);
      if (
        relative.startsWith("apps/web/src/") &&
        (dependency.startsWith("node:") || builtinModules.includes(dependency))
      )
        errors.push(`${relative}: Web 不得依赖 Node API`);
    }
  }
}
await walk("apps");
await walk("packages");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log("Architecture boundaries verified.");
