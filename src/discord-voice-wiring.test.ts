/**
 * Wiring test for the Discord voice host startup integration point.
 *
 * The voice module is env-gated, so importing it directly would not prove the host starts it.
 * This structural test asserts `main()` dynamically imports the module and awaits
 * `startDiscordVoice()` immediately after the delivery adapter is installed.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

function sourceFile(): ts.SourceFile {
  const p = path.resolve(process.cwd(), 'src/index.ts');
  return ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
}

function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function statementText(statement: ts.Statement): string {
  return statement.getText().replace(/\s+/g, ' ');
}

describe('index.ts starts Discord voice after delivery adapter setup', () => {
  const main = findFunction(sourceFile(), 'main');
  const statements = main?.body?.statements ? Array.from(main.body.statements) : [];

  it('finds main()', () => {
    expect(main).toBeDefined();
  });

  it('awaits startDiscordVoice after setDeliveryAdapter', () => {
    const setDeliveryIndex = statements.findIndex((statement) =>
      statementText(statement).includes('setDeliveryAdapter(createChannelDeliveryAdapter())'),
    );
    expect(setDeliveryIndex).toBeGreaterThanOrEqual(0);

    const importIndex = statements.findIndex((statement) =>
      statementText(statement).includes("import('./modules/discord-voice/index.js')"),
    );
    expect(importIndex).toBe(setDeliveryIndex + 1);

    const startIndex = statements.findIndex((statement) =>
      statementText(statement).includes('await startDiscordVoice()'),
    );
    expect(startIndex).toBe(importIndex + 1);
  });
});
