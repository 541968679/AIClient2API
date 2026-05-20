import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { checkKiroCredentialsDuplicate } from '../src/auth/kiro-oauth.js';
import { CONFIG } from '../src/core/config-manager.js';

jest.mock('../src/services/ui-manager.js', () => ({
    broadcastEvent: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    autoLinkProviderConfigs: jest.fn()
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    getProxyConfigForProvider: jest.fn(() => null)
}));

describe('Kiro duplicate detection', () => {
    let originalCwd;
    let tempDir;
    let originalProviderPools;
    let originalPoolsFilePath;

    beforeEach(() => {
        originalCwd = process.cwd();
        tempDir = mkdtempSync(path.join(tmpdir(), 'a2-kiro-dup-'));
        process.chdir(tempDir);
        originalProviderPools = CONFIG.providerPools;
        originalPoolsFilePath = CONFIG.PROVIDER_POOLS_FILE_PATH;
        mkdirSync(path.join(tempDir, 'configs', 'kiro'), { recursive: true });
    });

    afterEach(() => {
        CONFIG.providerPools = originalProviderPools;
        CONFIG.PROVIDER_POOLS_FILE_PATH = originalPoolsFilePath;
        process.chdir(originalCwd);
        rmSync(tempDir, { recursive: true, force: true });
    });

    test('ignores orphaned credential files and only flags linked credentials', async () => {
        const orphanPath = path.join('configs', 'kiro', 'orphan.json').replace(/\\/g, '/');
        const linkedPath = path.join('configs', 'kiro', 'linked.json').replace(/\\/g, '/');

        writeFileSync(path.join(tempDir, orphanPath), JSON.stringify({ refreshToken: 'rt-orphan' }), 'utf8');
        writeFileSync(path.join(tempDir, linkedPath), JSON.stringify({ refreshToken: 'rt-linked' }), 'utf8');

        CONFIG.providerPools = {
            'claude-kiro-oauth': [
                {
                    uuid: 'kiro-node-1',
                    KIRO_OAUTH_CREDS_FILE_PATH: linkedPath
                }
            ]
        };
        CONFIG.PROVIDER_POOLS_FILE_PATH = path.join('configs', 'provider_pools.json');

        await expect(checkKiroCredentialsDuplicate('rt-orphan')).resolves.toEqual({ isDuplicate: false });
        await expect(checkKiroCredentialsDuplicate('rt-linked')).resolves.toEqual({
            isDuplicate: true,
            existingPath: linkedPath
        });
    });
});
