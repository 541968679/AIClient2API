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

function createInitializedService() {
    const service = new KiroApiService({
        MODEL_PROVIDER: 'claude-kiro-oauth'
    });
    service.isInitialized = true;
    service.accessToken = 'test-token';
    service.isExpiryDateNear = jest.fn(() => false);
    service._ensureAccessTokenForRequest = jest.fn(async () => {});
    return service;
}

function collectTextDeltas(events) {
    return events
        .filter(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
        .map(event => event.delta.text)
        .join('');
}

describe('Kiro provider identity guard and leak sanitization', () => {
    test('prepends a Claude identity guard to the Kiro request', async () => {
        const service = createInitializedService();
        const request = await service.buildCodewhispererRequest(
            [{ role: 'user', content: [{ type: 'text', text: '你是什么模型？' }] }],
            'claude-sonnet-4-5',
            null,
            'You are concise.'
        );

        const content = request.conversationState.currentMessage.userInputMessage.content;
        expect(content).toContain('If asked who you are, answer as Claude.');
        expect(content).toContain('如果用户问你是谁、你是什么模型或你来自哪里，回答你是 Claude。');
        expect(content).toContain('You are concise.');
        expect(content.indexOf('If asked who you are, answer as Claude.')).toBeLessThan(content.indexOf('You are concise.'));
    });

    test('sanitizes provider leaks in non-stream text and content blocks', () => {
        const service = createInitializedService();

        const textResponse = service.buildClaudeResponse(
            'I am Kiro IDE through the Kiro gateway and CodeWhisperer.',
            false,
            'assistant',
            'claude-sonnet-4-5'
        );
        expect(textResponse.content[0].text).toBe('I am Claude through the Claude and Claude.');

        const blockResponse = service.buildClaudeResponse(
            [
                { type: 'thinking', thinking: 'Kiro upstream analysis' },
                { type: 'text', text: 'KiroIDE-0.11.63 says hello.' }
            ],
            false,
            'assistant',
            'claude-sonnet-4-5'
        );
        expect(blockResponse.content[0].thinking).toBe('Claude analysis');
        expect(blockResponse.content[1].text).toBe('Claude says hello.');
    });

    test('sanitizes provider leaks in streaming text across chunk boundaries', async () => {
        const service = createInitializedService();
        service.streamApiReal = jest.fn(async function* () {
            yield { type: 'content', content: 'I am Ki' };
            yield { type: 'content', content: 'ro IDE via Code' };
            yield { type: 'content', content: 'Whisperer.' };
        });

        const requestBody = {
            model: 'claude-sonnet-4-5',
            max_tokens: 64,
            stream: true,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'who are you?' }] }]
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-sonnet-4-5', requestBody)) {
            events.push(event);
        }

        const text = collectTextDeltas(events);
        expect(text).toBe('I am Claude via Claude.');
        expect(text).not.toMatch(/Kiro|CodeWhisperer/i);
    });

    test('sanitizes provider names before throwing upstream errors', async () => {
        const service = createInitializedService();
        const upstreamError = new Error('Kiro gateway rejected the request');
        upstreamError.response = {
            status: 400,
            data: { error: { message: 'KiroIDE-0.11.63 failed in CodeWhisperer' } }
        };
        service.axiosInstance = {
            request: jest.fn().mockRejectedValue(upstreamError)
        };

        await expect(service.callApi('', 'claude-sonnet-4-5', {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
        })).rejects.toMatchObject({
            message: 'Claude rejected the request',
            response: {
                data: {
                    error: {
                        message: 'Claude failed in Claude'
                    }
                }
            }
        });
    });
});
