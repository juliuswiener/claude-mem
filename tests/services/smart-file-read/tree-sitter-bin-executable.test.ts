import { describe, it, expect } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTreeSitterBinExecutable, repairTreeSitterBin } from '../../../src/services/smart-file-read/parser.js';

// AK3 (fehlendes-tree-sitter-binary-wird-beim-setup-nachgeholt): a --ignore-scripts
// install leaves tree-sitter-cli's package.json and cli.js in place but skips the
// postinstall download that produces the actual `tree-sitter` binary
// (check-postinstall-allowlist.js:8-13). resolveTreeSitterBinPath then falls back to
// a bare name that is not on PATH, execFileSync fails on every call, and parseFile
// silently returns 0 symbols — indistinguishable from a genuinely unsupported
// language. mcp-server.ts's smart_outline / smart_search / smart_unfold handlers use
// isTreeSitterBinExecutable to tell the two apart before choosing their error message.

describe('parser.ts isTreeSitterBinExecutable', () => {
  it('reports true for a real executable file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tree-sitter-bin-'));
    const binPath = join(dir, 'tree-sitter');
    try {
      writeFileSync(binPath, '#!/bin/sh\nexit 0\n');
      chmodSync(binPath, 0o755);
      expect(isTreeSitterBinExecutable(binPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports false for a file with no execute bit set for anyone', () => {
    // No execute bit for owner/group/other: fails X_OK even when the test runs as
    // root, where access() otherwise grants execute if ANY x bit is set.
    const dir = mkdtempSync(join(tmpdir(), 'tree-sitter-bin-'));
    const binPath = join(dir, 'tree-sitter');
    try {
      writeFileSync(binPath, '#!/bin/sh\nexit 0\n');
      chmodSync(binPath, 0o644);
      expect(isTreeSitterBinExecutable(binPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds a bare name on PATH — the fallback resolveTreeSitterBinPath returns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tree-sitter-bin-'));
    const savedPath = process.env.PATH;
    try {
      writeFileSync(join(dir, 'tree-sitter'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(dir, 'tree-sitter'), 0o755);
      process.env.PATH = dir;
      expect(isTreeSitterBinExecutable('tree-sitter')).toBe(true);
      process.env.PATH = join(dir, 'nowhere');
      expect(isTreeSitterBinExecutable('tree-sitter')).toBe(false);
    } finally {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports false when the binary is missing entirely — the --ignore-scripts gap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tree-sitter-bin-'));
    try {
      expect(isTreeSitterBinExecutable(join(dir, 'tree-sitter'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The Setup hook fires only with --init/--init-only/--maintenance, never on a normal
// launch, so the repair that actually runs is this one: the MCP server calls it on the
// first smart_* request that finds no binary.
describe('parser.ts repairTreeSitterBin', () => {
  function fakeCli(installJs: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'tree-sitter-cli-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"tree-sitter-cli"}');
    writeFileSync(join(dir, 'install.js'), installJs);
    return dir;
  }
  const WRITES_BIN = "require('fs').writeFileSync('tree-sitter', '#!/bin/sh\\n', { mode: 0o755 });\n";

  it('runs install.js in the package directory and reports the binary as present', () => {
    const dir = fakeCli(WRITES_BIN);
    try {
      expect(repairTreeSitterBin(dir)).toBe(true);
      expect(isTreeSitterBinExecutable(join(dir, 'tree-sitter'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tries a failing install.js once per directory, not on every call', () => {
    const dir = fakeCli("require('fs').appendFileSync('runs', 'x'); process.exit(1);\n");
    try {
      expect(repairTreeSitterBin(dir)).toBe(false);
      expect(repairTreeSitterBin(dir)).toBe(false);
      expect(require('fs').readFileSync(join(dir, 'runs'), 'utf8')).toBe('x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
