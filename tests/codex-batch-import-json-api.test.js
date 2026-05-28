import { Readable } from 'stream';
import { jest } from '@jest/globals';
import { handleBatchImportCodexTokens } from '../src/ui-modules/oauth-api.js';
import { batchImportCodexTokensStream } from '../src/auth/oauth-handlers.js';

jest.mock('../src/auth/oauth-handlers.js', () => ({
    handleGeminiCliOAuth: jest.fn(),
    handleGeminiAntigravityOAuth: jest.fn(),
    batchImportGeminiTokensStream: jest.fn(),
    handleQwenOAuth: jest.fn(),
    handleKiroOAuth: jest.fn(),
    handleIFlowOAuth: jest.fn(),
    handleCodexOAuth: jest.fn(),
    batchImportCodexTokensStream: jest.fn(),
    batchImportKiroRefreshTokensStream: jest.fn(),
    importAwsCredentials: jest.fn(),
    batchImportGrokTokensStream: jest.fn()
}));

function createJsonRequest(payload) {
    return Readable.from([JSON.stringify(payload)]);
}

function createStreamResponse() {
    const chunks = [];
    return {
        statusCode: null,
        headers: null,
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        body: '',
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
            this.headersSent = true;
        },
        write(chunk) {
            chunks.push(chunk.toString());
            this.body = chunks.join('');
        },
        end(chunk) {
            if (chunk) {
                chunks.push(chunk.toString());
            }
            this.body = chunks.join('');
            this.writableEnded = true;
        }
    };
}

describe('Codex batch import JSON API', () => {
    beforeEach(() => {
        batchImportCodexTokensStream.mockReset();
        batchImportCodexTokensStream.mockImplementation(async (tokens, onProgress) => {
            tokens.forEach((token, index) => {
                onProgress({
                    index: index + 1,
                    total: tokens.length,
                    current: { index: index + 1, success: true, path: `configs/codex/${index + 1}.json` },
                    successCount: index + 1,
                    failedCount: 0
                });
            });

            return {
                total: tokens.length,
                success: tokens.length,
                failed: 0,
                details: []
            };
        });
    });

    test('passes direct refresh token strings and token objects to the importer', async () => {
        const importTokens = [
            'rt-one',
            { refresh_token: 'rt-two' },
            { access_token: 'access-token', id_token: 'id-token', refresh_token: 'rt-three' }
        ];
        const req = createJsonRequest({ tokens: importTokens });
        const res = createStreamResponse();

        await handleBatchImportCodexTokens(req, res);

        expect(res.statusCode).toBe(200);
        expect(batchImportCodexTokensStream).toHaveBeenCalledWith(
            importTokens,
            expect.any(Function),
            false
        );
        expect(res.body).toContain('event: complete');
    });

    test('extracts refresh_token fields from arbitrary JSON payloads before importing', async () => {
        const req = createJsonRequest({
            refreshTokens: [' rt-one '],
            data: {
                accounts: [
                    { refresh_token: 'rt-two' },
                    { refreshToken: 'rt-three' }
                ]
            },
            skipDuplicateCheck: true
        });
        const res = createStreamResponse();

        await handleBatchImportCodexTokens(req, res);

        expect(res.statusCode).toBe(200);
        expect(batchImportCodexTokensStream).toHaveBeenCalledWith(
            ['rt-one', 'rt-two', 'rt-three'],
            expect.any(Function),
            true
        );
    });
});
