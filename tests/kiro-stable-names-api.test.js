import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Readable } from 'stream';
import { jest } from '@jest/globals';
import { createKiroAccountIdentity } from '../src/utils/account-fingerprint.js';
import { handleUpdateStableProviderNames } from '../src/ui-modules/provider-api.js';

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

function createJsonRequest(payload) {
    const body = JSON.stringify(payload);
    return Readable.from([body]);
}

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

describe('Kiro stable provider name updates', () => {
    let originalCwd;
    let tempDir;

    beforeEach(() => {
        originalCwd = process.cwd();
        tempDir = mkdtempSync(path.join(tmpdir(), 'a2-kiro-names-'));
        process.chdir(tempDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        rmSync(tempDir, { recursive: true, force: true });
    });

    test('overwrites existing Kiro provider names with RT-derived stable names', async () => {
        const refreshToken = 'sample-refresh-token-for-provider-api';
        const identity = createKiroAccountIdentity(refreshToken);
        const providerPoolsPath = path.join('configs', 'provider_pools.json');
        const credentialsPath = path.join('configs', 'kiro', 'account.json').replace(/\\/g, '/');

        mkdirSync(path.join(tempDir, 'configs', 'kiro'), { recursive: true });
        writeFileSync(path.join(tempDir, credentialsPath), JSON.stringify({ refreshToken }), 'utf-8');
        writeFileSync(path.join(tempDir, providerPoolsPath), JSON.stringify({
            'claude-kiro-oauth': [
                {
                    uuid: 'kiro-node-1',
                    customName: 'Old manual name',
                    KIRO_OAUTH_CREDS_FILE_PATH: credentialsPath
                }
            ]
        }, null, 2), 'utf-8');

        const req = createJsonRequest({ force: true });
        const res = createJsonResponse();
        const providerPoolManager = {
            providerPools: {},
            initializeProviderStatus: jest.fn()
        };

        await handleUpdateStableProviderNames(
            req,
            res,
            { PROVIDER_POOLS_FILE_PATH: providerPoolsPath },
            providerPoolManager,
            'claude-kiro-oauth'
        );

        const responseBody = JSON.parse(res.body);
        const savedPools = JSON.parse(readFileSync(path.join(tempDir, providerPoolsPath), 'utf-8'));
        const savedProvider = savedPools['claude-kiro-oauth'][0];

        expect(res.statusCode).toBe(200);
        expect(responseBody.updatedCount).toBe(1);
        expect(responseBody.skippedCount).toBe(0);
        expect(responseBody.errorCount).toBe(0);
        expect(savedProvider.customName).toBe(identity.accountName);
        expect(savedProvider.accountFingerprint).toBe(identity.accountFingerprint);
        expect(providerPoolManager.initializeProviderStatus).toHaveBeenCalled();
    });
});
