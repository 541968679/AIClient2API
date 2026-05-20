import { jest } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: new Map()
}));

describe('ProviderPoolManager.refreshNode', () => {
    let manager;

    afterEach(() => {
        if (manager?.saveTimer) {
            clearTimeout(manager.saveTimer);
            manager.saveTimer = null;
        }
    });

    test('wait mode resolves after the node refresh finishes', async () => {
        manager = new ProviderPoolManager({
            'claude-kiro-oauth': [
                {
                    uuid: 'kiro-node-1',
                    isHealthy: true,
                    isDisabled: false
                }
            ]
        }, {
            globalConfig: {},
            maxErrorCount: 10
        });

        if (manager.saveTimer) {
            clearTimeout(manager.saveTimer);
            manager.saveTimer = null;
        }
        manager._debouncedSave = jest.fn();
        manager._refreshNodeToken = jest.fn(async (_providerType, providerStatus) => {
            providerStatus.config.lastRefreshTime = 12345;
        });

        const refreshed = await manager.refreshNode('claude-kiro-oauth', 'kiro-node-1', true, { wait: true });

        expect(refreshed).toBe(true);
        expect(manager._refreshNodeToken).toHaveBeenCalledTimes(1);
        expect(manager.providerStatus['claude-kiro-oauth'][0].config.lastRefreshTime).toBe(12345);
        expect(manager.refreshingUuids.has('kiro-node-1')).toBe(false);
    });
});
