import { Readable } from 'stream';
import { jest } from '@jest/globals';
import { handleBatchImportKiroTokens } from '../src/ui-modules/oauth-api.js';
import { batchImportKiroRefreshTokensStream } from '../src/auth/oauth-handlers.js';

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

describe('Kiro batch import JSON API', () => {
    beforeEach(() => {
        batchImportKiroRefreshTokensStream.mockReset();
        batchImportKiroRefreshTokensStream.mockImplementation(async (tokens, region, onProgress) => {
            tokens.forEach((token, index) => {
                onProgress({
                    index: index + 1,
                    total: tokens.length,
                    current: { index: index + 1, success: true, path: `configs/kiro/${index + 1}.json` },
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

    test('extracts refreshToken fields from arbitrary JSON payloads before importing', async () => {
        const req = createJsonRequest({
            json: {
                value: [
                    { refreshToken: 'rt-one', provider: 'Google' },
                    { refreshToken: 'rt-two', provider: 'Google' }
                ],
                Count: 2
            },
            refreshOnImport: false
        });
        const res = createStreamResponse();

        await handleBatchImportKiroTokens(req, res);

        expect(res.statusCode).toBe(200);
        expect(batchImportKiroRefreshTokensStream).toHaveBeenCalledWith(
            ['rt-one', 'rt-two'],
            'us-east-1',
            expect.any(Function),
            false,
            false
        );
        expect(res.body).toContain('event: complete');
    });

    test('merges direct token arrays with JSON tokens and deduplicates them', async () => {
        const req = createJsonRequest({
            refreshTokens: [' rt-one ', 'rt-two'],
            data: {
                accounts: [
                    { refresh_token: 'rt-two' },
                    { refreshToken: 'rt-three' }
                ]
            },
            region: 'eu-west-1',
            skipDuplicateCheck: true,
            refreshOnImport: true
        });
        const res = createStreamResponse();

        await handleBatchImportKiroTokens(req, res);

        expect(batchImportKiroRefreshTokensStream).toHaveBeenCalledWith(
            ['rt-one', 'rt-two', 'rt-three'],
            'eu-west-1',
            expect.any(Function),
            true,
            true
        );
    });
});
