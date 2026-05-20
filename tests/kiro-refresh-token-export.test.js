import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';
import { handleExportRefreshTokens } from '../src/ui-modules/provider-api.js';

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

function createDownloadResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        },
        end(content) {
            this.body = Buffer.isBuffer(content) ? content.toString('utf8') : (content || '');
        }
    };
}

describe('Kiro refresh token export', () => {
    let originalCwd;
    let tempDir;

    beforeEach(() => {
        originalCwd = process.cwd();
        tempDir = mkdtempSync(path.join(tmpdir(), 'a2-kiro-rt-export-'));
        process.chdir(tempDir);
        mkdirSync(path.join(tempDir, 'configs', 'kiro'), { recursive: true });
    });

    afterEach(() => {
        process.chdir(originalCwd);
        rmSync(tempDir, { recursive: true, force: true });
    });

    test('exports the rotated refresh token after provider refresh writes it back', async () => {
        const credentialsPath = path.join('configs', 'kiro', 'account.json').replace(/\\/g, '/');
        const absoluteCredentialsPath = path.join(tempDir, credentialsPath);

        writeFileSync(absoluteCredentialsPath, JSON.stringify({
            accessToken: 'old-access-token',
            refreshToken: 'old-refresh-token',
            expiresAt: new Date(0).toISOString(),
            authMethod: 'social',
            region: 'us-east-1'
        }, null, 2), 'utf8');

        const service = new KiroApiService({
            MODEL_PROVIDER: 'claude-kiro-oauth',
            KIRO_OAUTH_CREDS_FILE_PATH: credentialsPath
        });
        service.refreshToken = 'old-refresh-token';
        service.accessToken = 'old-access-token';
        service.authMethod = 'social';
        service.refreshUrl = 'https://example.test/refreshToken';
        service.axiosSocialRefreshInstance = {
            request: jest.fn().mockResolvedValue({
                data: {
                    accessToken: 'new-access-token',
                    refresh_token: 'new-refresh-token',
                    expires_in: 1800,
                    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/test'
                }
            })
        };
        service.axiosInstance = { request: jest.fn() };
        service._applySidecar = jest.fn(config => config);

        await service._doTokenRefresh(service.saveCredentialsToFile.bind(service), credentialsPath);

        const savedCredentials = JSON.parse(readFileSync(absoluteCredentialsPath, 'utf8'));
        expect(savedCredentials.accessToken).toBe('new-access-token');
        expect(savedCredentials.refreshToken).toBe('new-refresh-token');

        const req = {
            url: '/api/providers/claude-kiro-oauth/export-refresh-tokens?format=json',
            headers: { host: 'localhost' }
        };
        const res = createDownloadResponse();
        const providerPoolManager = {
            providerStatus: {
                'claude-kiro-oauth': [
                    {
                        config: {
                            uuid: 'kiro-node-1',
                            customName: 'Kiro Test',
                            isHealthy: true,
                            isDisabled: false,
                            KIRO_OAUTH_CREDS_FILE_PATH: credentialsPath
                        }
                    }
                ]
            }
        };

        await handleExportRefreshTokens(req, res, {}, providerPoolManager, 'claude-kiro-oauth');

        const exported = JSON.parse(res.body);
        expect(res.statusCode).toBe(200);
        expect(exported.tokenCount).toBe(1);
        expect(exported.tokens[0].refreshToken).toBe('new-refresh-token');
    });
});
