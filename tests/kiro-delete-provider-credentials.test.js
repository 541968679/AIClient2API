import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { handleDeleteProvider } from '../src/ui-modules/provider-api.js';

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

function createJsonResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        },
        end(content) {
            this.body = content || '';
        }
    };
}

describe('Kiro provider deletion credential cleanup', () => {
    let originalCwd;
    let tempDir;

    beforeEach(() => {
        originalCwd = process.cwd();
        tempDir = mkdtempSync(path.join(tmpdir(), 'a2-kiro-delete-'));
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        rmSync(tempDir, { recursive: true, force: true });
    });

    test('deletes the unreferenced credential file when deleting a provider', async () => {
        const providerPoolsPath = path.join('configs', 'provider_pools.json');
        const credentialsPath = path.join('configs', 'kiro', 'account.json').replace(/\\/g, '/');

        mkdirSync(path.join(tempDir, 'configs', 'kiro'), { recursive: true });
        writeFileSync(path.join(tempDir, credentialsPath), JSON.stringify({ refreshToken: 'rt-delete-me' }), 'utf8');
        writeFileSync(path.join(tempDir, providerPoolsPath), JSON.stringify({
            'claude-kiro-oauth': [
                {
                    uuid: 'kiro-node-1',
                    KIRO_OAUTH_CREDS_FILE_PATH: credentialsPath
                }
            ]
        }, null, 2), 'utf8');

        const res = createJsonResponse();
        const providerPoolManager = {
            providerPools: {},
            initializeProviderStatus: jest.fn()
        };

        await handleDeleteProvider(
            {},
            res,
            { PROVIDER_POOLS_FILE_PATH: providerPoolsPath },
            providerPoolManager,
            'claude-kiro-oauth',
            'kiro-node-1'
        );

        const responseBody = JSON.parse(res.body);
        const savedPools = JSON.parse(readFileSync(path.join(tempDir, providerPoolsPath), 'utf8'));

        expect(res.statusCode).toBe(200);
        expect(savedPools['claude-kiro-oauth']).toBeUndefined();
        expect(existsSync(path.join(tempDir, credentialsPath))).toBe(false);
        expect(responseBody.credentialCleanup.deletedCredentialFiles).toEqual([credentialsPath]);
        expect(providerPoolManager.initializeProviderStatus).toHaveBeenCalled();
    });
});
