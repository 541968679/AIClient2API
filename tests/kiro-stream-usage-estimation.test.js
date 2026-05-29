import { jest } from '@jest/globals';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(config => config),
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/providers/adapter.js', () => ({
    getRegisteredProviders: jest.fn(() => []),
    getServiceAdapter: jest.fn(),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: new Map()
}));

jest.mock('../src/providers/provider-models.js', () => ({
    extractModelIdsFromNativeList: jest.fn(() => []),
    getConfiguredSupportedModels: jest.fn(() => []),
    getProviderModels: jest.fn(() => []),
    normalizeModelIds: jest.fn(models => Array.isArray(models) ? models : []),
    usesManagedModelList: jest.fn(() => false)
}));

describe('Kiro stream usage estimation', () => {
    test('uses estimated input tokens when contextUsagePercentage is missing', async () => {
        const service = new KiroApiService({
            MODEL_PROVIDER: 'claude-kiro-oauth'
        });
        service.isInitialized = true;
        service.isExpiryDateNear = jest.fn(() => false);
        service._ensureAccessTokenForRequest = jest.fn(async () => {});
        service.streamApiReal = jest.fn(async function* () {
            yield { type: 'content', content: 'ok' };
        });

        const requestBody = {
            model: 'claude-opus-4-8',
            max_tokens: 16,
            stream: true,
            system: 'You are concise.',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Reply with ok.' }
                    ]
                }
            ]
        };

        const expectedInputTokens = service.estimateInputTokens(requestBody);
        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-8', requestBody)) {
            events.push(event);
        }

        const messageDelta = events.find(event => event.type === 'message_delta');
        expect(messageDelta).toBeDefined();
        expect(expectedInputTokens).toBeGreaterThan(0);
        expect(messageDelta.usage.input_tokens + messageDelta.usage.cache_read_input_tokens).toBe(expectedInputTokens);
        expect(messageDelta.usage.output_tokens).toBeGreaterThan(0);
        expect(events.at(-1)).toEqual({ type: 'message_stop' });
    });
});
