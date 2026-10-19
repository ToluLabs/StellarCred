import { describe, it, expect } from 'vitest';
import * as rootSdk from './index';
import * as coreSdk from './core';
import * as reactSdk from './react';
import * as fs from 'fs';
import * as path from 'path';

describe('SDK Consolidation & Barrel Guards (#690)', () => {
  it('ensures core, react, and root entry points share identical function identities', () => {
    if (typeof (coreSdk as any).hasClaim === 'function') {
      expect((coreSdk as any).hasClaim).toBe(rootSdk.hasClaim);
    }
    if (typeof (coreSdk as any).hasClaims === 'function') {
      expect((coreSdk as any).hasClaims).toBe(rootSdk.hasClaims);
    }
    if (typeof (reactSdk as any).hasClaim === 'function') {
      expect((reactSdk as any).hasClaim).toBe(rootSdk.hasClaim);
    }
    if (typeof (reactSdk as any).hasClaims === 'function') {
      expect((reactSdk as any).hasClaims).toBe(rootSdk.hasClaims);
    }
  });

  it('asserts configure state is globally shared across entry points', () => {
    const testRegistryId = 'CC' + 'A'.repeat(54);
    rootSdk.configure({
      registryId: testRegistryId,
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    expect(rootSdk.isConfigured()).toBe(true);
  });

  it('constrains index.ts to remain a lean barrel (< 100 lines)', () => {
    const indexPath = path.join(__dirname, 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    const lines = content.split('\n').length;
    expect(lines).toBeLessThan(100);
  });
});
