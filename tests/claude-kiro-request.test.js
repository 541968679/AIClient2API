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

function createService() {
    const service = new KiroApiService({
        MODEL_PROVIDER: 'claude-kiro-oauth'
    });
    service.isInitialized = true;
    service.accessToken = 'test-token';
    service.isExpiryDateNear = jest.fn(() => false);
    service._ensureAccessTokenForRequest = jest.fn(async () => {});
    return service;
}

const claudeCodeMetadata = {
    user_id: JSON.stringify({
        session_id: 'claude-code-session-1',
        device_id: 'device-1'
    })
};

describe('Kiro CodeWhisperer request conversion', () => {
    test('keeps stable conversationId only for single-turn metadata requests', async () => {
        const service = createService();
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'hello' }] }
        ];

        const first = await service.buildCodewhispererRequest(
            messages,
            'claude-opus-4-8',
            null,
            'system prompt',
            null,
            claudeCodeMetadata
        );
        const second = await service.buildCodewhispererRequest(
            messages,
            'claude-opus-4-8',
            null,
            'system prompt',
            null,
            claudeCodeMetadata
        );

        expect(first.conversationState.conversationId).toBe(second.conversationState.conversationId);
        expect(first.conversationState.history).toBeUndefined();
    });

    test('uses a fresh conversationId when Claude Code sends explicit history', async () => {
        const service = createService();
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'first' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
            { role: 'user', content: [{ type: 'text', text: 'third' }] }
        ];

        const first = await service.buildCodewhispererRequest(
            messages,
            'claude-opus-4-8',
            null,
            'system prompt',
            null,
            claudeCodeMetadata
        );
        const second = await service.buildCodewhispererRequest(
            messages,
            'claude-opus-4-8',
            null,
            'system prompt',
            null,
            claudeCodeMetadata
        );

        expect(first.conversationState.conversationId).not.toBe(second.conversationState.conversationId);
        expect(first.conversationState.history).toHaveLength(2);
        expect(first.conversationState.history[0].userInputMessage.content).toContain('first');
        expect(first.conversationState.history[1].assistantResponseMessage.content).toBe('second');
        expect(first.conversationState.currentMessage.userInputMessage.content).toBe('third');
    });
});
