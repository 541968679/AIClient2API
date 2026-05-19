import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProviderStatus } from '../src/services/service-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

jest.mock('../src/providers/provider-pool-manager.js', () => ({
    ProviderPoolManager: jest.fn()
}));

describe('getProviderStatus', () => {
    test('includes scheduled recovery time for cooled down providers', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-provider-status-'));
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');
        const scheduledRecoveryTime = new Date(Date.now() + 60_000).toISOString();

        fs.writeFileSync(providerPoolsPath, JSON.stringify({
            'claude-kiro-oauth': [
                {
                    uuid: 'kiro-1',
                    customName: 'Kiro 1',
                    isHealthy: false,
                    isDisabled: false,
                    lastErrorTime: new Date().toISOString(),
                    lastErrorMessage: '429 Too Many Requests',
                    scheduledRecoveryTime,
                    KIRO_OAUTH_CREDS_FILE_PATH: 'configs/kiro/kiro-1.json'
                }
            ]
        }));

        try {
            const status = await getProviderStatus({
                PROVIDER_POOLS_FILE_PATH: providerPoolsPath
            });

            expect(status.providerPoolsSlim).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        uuid: 'kiro-1',
                        provider: 'claude-kiro-oauth',
                        scheduledRecoveryTime
                    })
                ])
            );
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
