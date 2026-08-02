/**
 * Tests for container-config.ts configFromDb — verify that
 * additionalMounts with missing/invalid hostPath are sanitized
 * so they never reach validateAdditionalMounts with undefined.
 */
import { describe, expect, it } from 'vitest';
import { configFromDb } from './container-config.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

function makeGroup(id: string): AgentGroup {
  return { id, name: 'test', folder: 'test', agent_provider: null, created_at: new Date().toISOString() };
}

function makeRow(overrides: Partial<ContainerConfigRow> = {}): ContainerConfigRow {
  return {
    agent_group_id: 'ag-test',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    image_tag: null,
    additional_mounts: '[]',
    skills: '["onecli-gateway","welcome"]',
    provider: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    model: null,
    effort: null,
    cli_scope: 'group',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('configFromDb additionalMounts sanitization', () => {
  it('filters out entries with undefined hostPath', () => {
    const row = makeRow({
      additional_mounts: JSON.stringify([{ hostPath: undefined }, { hostPath: '/valid/path', containerPath: 'test' }]),
    });
    const cfg = configFromDb(row, makeGroup('ag-test'));
    expect(cfg.additionalMounts).toHaveLength(1);
    expect(cfg.additionalMounts[0].hostPath).toBe('/valid/path');
  });

  it('filters out entries with null hostPath', () => {
    const row = makeRow({
      additional_mounts: JSON.stringify([{ hostPath: null }, { hostPath: '/valid/path' }]),
    });
    const cfg = configFromDb(row, makeGroup('ag-test'));
    expect(cfg.additionalMounts).toHaveLength(1);
    expect(cfg.additionalMounts[0].hostPath).toBe('/valid/path');
  });

  it('filters out entries with empty-string hostPath', () => {
    const row = makeRow({
      additional_mounts: JSON.stringify([{ hostPath: '', containerPath: 'test' }, { hostPath: '/valid/path' }]),
    });
    const cfg = configFromDb(row, makeGroup('ag-test'));
    expect(cfg.additionalMounts).toHaveLength(1);
    expect(cfg.additionalMounts[0].hostPath).toBe('/valid/path');
  });

  it('filters out entries with non-string hostPath', () => {
    const row = makeRow({
      additional_mounts: JSON.stringify([{ hostPath: 123 }, { hostPath: true }, { hostPath: '/valid/path' }]),
    });
    const cfg = configFromDb(row, makeGroup('ag-test'));
    expect(cfg.additionalMounts).toHaveLength(1);
    expect(cfg.additionalMounts[0].hostPath).toBe('/valid/path');
  });

  it('handles non-array additional_mounts JSON gracefully', () => {
    const row = makeRow({ additional_mounts: 'null' });
    const cfg = configFromDb(row, makeGroup('ag-test'));
    expect(cfg.additionalMounts).toHaveLength(0);
  });

  it('preserves valid entries', () => {
    const row = makeRow({
      additional_mounts: JSON.stringify([
        { hostPath: '/path/one', containerPath: 'one', readonly: true },
        { hostPath: '/path/two', containerPath: 'two', readonly: false },
      ]),
    });
    const cfg = configFromDb(row, makeGroup('ag-test'));
    expect(cfg.additionalMounts).toHaveLength(2);
  });
});
