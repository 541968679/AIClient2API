import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import axios from 'axios';
import { batchImportCodexTokensStream } from '../src/auth/codex-oauth.js';
import { autoLinkProviderConfigs } from '../src/services/service-manager.js';

jest.mock('axios', () => {
    const post = jest.fn();
    return {
        __esModule: true,
        default: {
            create: jest.fn(() => ({ post })),
            __mockPost: post
        }
    };
});

jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));

jest.mock('../src/services/ui-manager.js', () => ({
    broadcastEvent: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    autoLinkProviderConfigs: jest.fn()
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    getProxyConfigForProvider: jest.fn(() => null)
}));

function makeJwt(claims) {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.signature`;
}

describe('Codex refresh_token-only import', () => {
    let originalCwd;
    let tempDir;

    beforeEach(() => {
        originalCwd = process.cwd();
        tempDir = mkdtempSync(path.join(tmpdir(), 'a2-codex-import-'));
        process.chdir(tempDir);
        axios.__mockPost.mockReset();
        autoLinkProviderConfigs.mockReset();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        rmSync(tempDir, { recursive: true, force: true });
    });

    test('refreshes a bare refresh token before saving Codex credentials', async () => {
        const idToken = makeJwt({
            email: 'codex@example.com',
            sub: 'user-sub',
            'https://api.openai.com/auth': {
                chatgpt_account_id: 'account-123'
            }
        });

        axios.__mockPost.mockResolvedValue({
            data: {
                id_token: idToken,
                access_token: 'new-access-token',
                refresh_token: 'new-refresh-token',
                expires_in: 7200
            }
        });

        const result = await batchImportCodexTokensStream(['original-refresh-token']);

        expect(result.success).toBe(1);
        expect(result.failed).toBe(0);
        expect(axios.__mockPost).toHaveBeenCalledTimes(1);
        expect(axios.__mockPost.mock.calls[0][1]).toContain('grant_type=refresh_token');
        expect(axios.__mockPost.mock.calls[0][1]).toContain('refresh_token=original-refresh-token');

        const codexDir = path.join(tempDir, 'configs', 'codex');
        const files = readdirSync(codexDir);
        expect(files).toHaveLength(1);

        const credentials = JSON.parse(readFileSync(path.join(codexDir, files[0]), 'utf8'));
        expect(credentials).toMatchObject({
            id_token: idToken,
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            account_id: 'account-123',
            email: 'codex@example.com',
            type: 'codex'
        });
        expect(autoLinkProviderConfigs).toHaveBeenCalledWith(expect.any(Object), {
            onlyCurrentCred: true,
            credPath: expect.stringMatching(/^configs[\\/]+codex[\\/]+.*\.json$/)
        });
    });
});
