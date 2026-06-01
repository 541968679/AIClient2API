import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
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
    function createInitializedService(config = {}) {
        const service = new KiroApiService({
            MODEL_PROVIDER: 'claude-kiro-oauth',
            ...config
        });
        service.isInitialized = true;
        service.accessToken = 'test-token';
        service.baseUrl = 'https://kiro.example.test/generateAssistantResponse';
        service.isExpiryDateNear = jest.fn(() => false);
        service._ensureAccessTokenForRequest = jest.fn(async () => {});
        return service;
    }

    async function collectStreamApiRealEvents(service, chunks) {
        service.axiosInstance = {
            request: jest.fn(async () => ({
                data: Readable.from(chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
            }))
        };

        const events = [];
        for await (const event of service.streamApiReal('', 'claude-opus-4-8', {
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Reply briefly.' }
                    ]
                }
            ]
        })) {
            events.push(event);
        }
        return events;
    }

    function createAwsEventStreamFrame(payload, header = Buffer.alloc(0)) {
        const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        const totalLength = 12 + header.length + payloadBuffer.length + 4;
        const frame = Buffer.alloc(totalLength);
        frame.writeUInt32BE(totalLength, 0);
        frame.writeUInt32BE(header.length, 4);
        header.copy(frame, 12);
        payloadBuffer.copy(frame, 12 + header.length);
        return frame;
    }

    test('uses estimated input tokens when contextUsagePercentage is missing', async () => {
        const service = createInitializedService();
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

    test('falls back to emitted output characters when token counting returns zero', async () => {
        const service = createInitializedService();
        service.streamApiReal = jest.fn(async function* () {
            yield { type: 'content', content: 'fallback text' };
        });
        service.countTextTokens = jest.fn(() => 0);

        const requestBody = {
            model: 'claude-opus-4-8',
            max_tokens: 16,
            stream: true,
            system: 'You are concise.',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Reply with fallback text.' }
                    ]
                }
            ]
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-8', requestBody)) {
            events.push(event);
        }

        const messageDelta = events.find(event => event.type === 'message_delta');
        expect(messageDelta).toBeDefined();
        expect(messageDelta.usage.output_tokens).toBe(Math.ceil('fallback text'.length / 4));
        expect(events.at(-1)).toEqual({ type: 'message_stop' });
    });

    test('treats thinking-only streams as completed turns', async () => {
        const service = createInitializedService();
        service.streamApiReal = jest.fn(async function* () {
            yield { type: 'content', content: '<thinking>\ninternal reasoning</thinking>' };
        });

        const requestBody = {
            model: 'claude-opus-4-6',
            max_tokens: 16,
            stream: true,
            thinking: {
                type: 'enabled',
                budget_tokens: 1024
            },
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Think briefly.' }
                    ]
                }
            ]
        };

        const events = [];
        for await (const event of service.generateContentStream('claude-opus-4-6', requestBody)) {
            events.push(event);
        }

        const messageDelta = events.find(event => event.type === 'message_delta');
        const textDelta = events.find(event => event.delta?.type === 'text_delta');
        expect(messageDelta).toBeDefined();
        expect(messageDelta.delta.stop_reason).toBe('end_turn');
        expect(textDelta.delta.text).toBe(' ');
        expect(events.at(-1)).toEqual({ type: 'message_stop' });
    });

    test('uses Kiro text payloads as fallback when content payloads are absent', async () => {
        const service = createInitializedService();

        const events = await collectStreamApiRealEvents(service, [
            ':message-typeevent{"text":"first "}',
            ':message-typeevent{"text":"second"}'
        ]);

        expect(events).toEqual([
            { type: 'content', content: 'first ' },
            { type: 'content', content: 'second' }
        ]);
    });

    test('does not emit Kiro text fallback when content payloads are present', async () => {
        const service = createInitializedService();

        const events = await collectStreamApiRealEvents(service, [
            ':message-typeevent{"text":"fallback "}',
            ':message-typeevent{"content":"content only"}'
        ]);

        expect(events).toEqual([
            { type: 'content', content: 'content only' }
        ]);
    });

    test('uses Kiro text fallback when same payload has empty content', async () => {
        const service = createInitializedService();

        const events = await collectStreamApiRealEvents(service, [
            ':message-typeevent{"content":"","text":"fallback text"}'
        ]);

        expect(events).toEqual([
            { type: 'content', content: 'fallback text' }
        ]);
    });

    test('uses Kiro text fallback when same payload has whitespace content', async () => {
        const service = createInitializedService();

        const events = await collectStreamApiRealEvents(service, [
            ':message-typeevent{"content":"   ","text":"fallback text"}'
        ]);

        expect(events).toEqual([
            { type: 'content', content: 'fallback text' }
        ]);
    });

    test('does not let whitespace content suppress buffered Kiro text fallback', async () => {
        const service = createInitializedService();

        const events = await collectStreamApiRealEvents(service, [
            ':message-typeevent{"text":"fallback text"}',
            ':message-typeevent{"content":"   "}'
        ]);

        expect(events).toEqual([
            { type: 'content', content: '   ' },
            { type: 'content', content: 'fallback text' }
        ]);
    });

    test('parses Kiro JSON payloads from AWS event stream frames as bytes', async () => {
        const service = createInitializedService();
        const noisyHeader = Buffer.from('not-json { this header must not block payload');

        const events = await collectStreamApiRealEvents(service, [
            createAwsEventStreamFrame('{"text":"framed fallback"}', noisyHeader)
        ]);

        expect(events).toEqual([
            { type: 'content', content: 'framed fallback' }
        ]);
    });

    test('keeps incomplete AWS event stream frames buffered across chunks', async () => {
        const service = createInitializedService();
        const frame = createAwsEventStreamFrame('{"text":"split frame fallback"}');

        const events = await collectStreamApiRealEvents(service, [
            frame.subarray(0, 8),
            frame.subarray(8, 19),
            frame.subarray(19)
        ]);

        expect(events).toEqual([
            { type: 'content', content: 'split frame fallback' }
        ]);
    });
});
