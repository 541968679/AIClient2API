import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../src/utils/logger.js', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    isProxyEnabledForProvider: jest.fn(() => false)
}));

jest.mock('../src/providers/openai/openai-responses-core.js', () => ({
    OpenAIResponsesApiService: class {
        constructor(config) {
            this.config = config;
        }
    }
}));

jest.mock('../src/providers/gemini/gemini-core.js', () => ({
    GeminiApiService: class {
        constructor(config) {
            this.config = config;
        }
    }
}));

jest.mock('../src/providers/gemini/antigravity-core.js', () => ({
    AntigravityApiService: class {
        constructor(config) {
            this.config = config;
        }
    }
}));

jest.mock('../src/providers/openai/openai-core.js', () => ({
    OpenAIApiService: class {
        constructor(config) {
            this.config = config;
        }
    }
}));

jest.mock('../src/providers/claude/claude-core.js', () => ({
    ClaudeApiService: class {
        constructor(config) {
            this.config = config;
        }
    }
}));

jest.mock('../src/providers/claude/claude-kiro.js', () => ({
    KiroApiService: class {
        constructor(config) {
            this.config = config;
        }
    }
}));

jest.mock('../src/providers/openai/qwen-core.js', () => ({
    QwenApiService: class {
        constructor(config) {
            this.config = config;
        }
    }
}));

jest.mock('../src/providers/openai/iflow-core.js', () => ({
    IFlowApiService: class {
        constructor(config) {
            this.config = config;
        }
    }
}));

jest.mock('../src/providers/openai/codex-core.js', () => ({
    CodexApiService: class {
        constructor(config) {
            this.config = config;
        }
    }
}));

jest.mock('../src/providers/forward/forward-core.js', () => ({
    ForwardApiService: class {
        constructor(config) {
            this.config = config;
        }
    }
}));

jest.mock('../src/providers/grok/grok-core.js', () => ({
    GrokApiService: class {
        constructor(config) {
            this.config = config;
        }
    }
}));

import {
    getServiceAdapter,
    serviceInstances
} from '../src/providers/adapter.js';

describe('adapter proxy cache handling', () => {
    afterEach(() => {
        for (const key of Object.keys(serviceInstances)) {
            delete serviceInstances[key];
        }
    });

    test('injects resolved proxyId URL into provider config before creating adapter', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-adapter-proxy-'));
        const proxiesPath = path.join(tempDir, 'proxies.json');

        try {
            fs.writeFileSync(proxiesPath, JSON.stringify({
                proxies: [
                    {
                        id: 'proxy-1',
                        name: 'local proxy',
                        protocol: 'http',
                        host: '127.0.0.1',
                        port: 18080,
                        enabled: true,
                        poolEnabled: true
                    }
                ]
            }));

            const adapter = getServiceAdapter({
                MODEL_PROVIDER: 'claude-kiro-oauth',
                uuid: 'kiro-proxied',
                proxyId: 'proxy-1',
                PROXIES_FILE_PATH: proxiesPath
            });

            expect(adapter.kiroApiService.config.PROVIDER_PROXY_URL).toBe('http://127.0.0.1:18080/');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('rebuilds cached adapter when effective proxy changes', () => {
        const first = getServiceAdapter({
            MODEL_PROVIDER: 'claude-kiro-oauth',
            uuid: 'kiro-rebuild',
            proxyUrl: 'http://127.0.0.1:18081'
        });

        const second = getServiceAdapter({
            MODEL_PROVIDER: 'claude-kiro-oauth',
            uuid: 'kiro-rebuild',
            proxyUrl: 'http://127.0.0.1:18082'
        });

        expect(second).not.toBe(first);
        expect(second.kiroApiService.config.PROVIDER_PROXY_URL).toBe('http://127.0.0.1:18082');
    });

    test('rebuilds cached adapter when proxy is removed', () => {
        const proxied = getServiceAdapter({
            MODEL_PROVIDER: 'claude-kiro-oauth',
            uuid: 'kiro-direct',
            proxyUrl: 'http://127.0.0.1:18083'
        });

        const direct = getServiceAdapter({
            MODEL_PROVIDER: 'claude-kiro-oauth',
            uuid: 'kiro-direct'
        });

        expect(direct).not.toBe(proxied);
        expect(direct.kiroApiService.config.PROVIDER_PROXY_URL).toBeUndefined();
    });
});
