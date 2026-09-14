import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("application JSX uses shared tooltips instead of native title hints", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const nativeTitles: string[] = [];
  for (const entry of readdirSync(root, { recursive: true })) {
    if (!entry.endsWith(".tsx")) continue;
    const source = ts.createSourceFile(
      entry,
      readFileSync(path.join(root, entry), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        /^[a-z]/.test(node.tagName.text) &&
        node.attributes.properties.some(
          (prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === "title",
        )
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        nativeTitles.push(`${entry}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(nativeTitles, []);
});
