import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getRegisteredProviders: jest.fn(() => []),
    getServiceAdapter: jest.fn(),
    invalidateServiceAdapter: jest.fn()
}));

describe('ProviderPoolManager scheduled recovery checks', () => {
    function createManager(providerConfig = {}, options = {}) {
        const manager = new ProviderPoolManager(
            {
                'claude-kiro-oauth': [
                    {
                        uuid: 'node-1',
                        customName: 'Node 1',
                        isHealthy: false,
                        errorCount: 10,
                        lastErrorTime: new Date(Date.now() - 1000).toISOString(),
                        lastErrorMessage: '429 Too Many Requests',
                        scheduledRecoveryTime: new Date(Date.now() + 60_000).toISOString(),
                        ...providerConfig
                    }
                ]
            },
            {
                saveDebounceTime: 1,
                globalConfig: {
                    RATE_LIMIT_COOLDOWN_MS: 1000,
                    RATE_LIMIT_COOLDOWN_JITTER_MS: 0,
                    RATE_LIMIT_COOLDOWN_MAX_MS: 1000
                },
                ...options
            }
        );
        if (manager.saveTimer) {
            clearTimeout(manager.saveTimer);
            manager.saveTimer = null;
        }
        for (const timerEntry of manager.recoveryCheckTimers.values()) {
            clearTimeout(timerEntry.timer);
        }
        manager.recoveryCheckTimers.clear();
        manager._debouncedSave = jest.fn();
        manager._scheduleRecoveryCheck = jest.fn();
        return manager;
    }

    test('expired cooldown stays unhealthy until recovery health check passes', async () => {
        const manager = createManager();
        const provider = manager.providerStatus['claude-kiro-oauth'][0].config;
        manager._checkProviderHealth = jest.fn(async () => ({
            success: false,
            modelName: 'claude-haiku-4-5',
            errorMessage: '429 Too Many Requests'
        }));

        await manager._recoverProviderAfterHealthCheck('claude-kiro-oauth', provider);

        expect(provider.isHealthy).toBe(false);
        expect(provider.lastErrorMessage).toBe('429恢复失败: 429 Too Many Requests');
        expect(new Date(provider.scheduledRecoveryTime).getTime()).toBeGreaterThan(Date.now());

        manager._checkProviderHealth = jest.fn(async () => ({
            success: true,
            modelName: 'claude-haiku-4-5',
            errorMessage: null
        }));
        provider.scheduledRecoveryTime = new Date(Date.now() - 1).toISOString();

        await manager._recoverProviderAfterHealthCheck('claude-kiro-oauth', provider);

        expect(provider.isHealthy).toBe(true);
        expect(provider.errorCount).toBe(0);
        expect(provider.lastErrorMessage).toBeNull();
        expect(provider.scheduledRecoveryTime).toBeNull();
        expect(provider.lastHealthCheckModel).toBe('claude-haiku-4-5');
    });
});
