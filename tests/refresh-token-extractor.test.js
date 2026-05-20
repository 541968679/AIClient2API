import {
    extractRefreshTokensFromJsonPayload,
    isRefreshTokenKey,
    mergeRefreshTokenSources,
    normalizeRefreshTokenList
} from '../src/utils/refresh-token-extractor.js';

describe('refresh token extraction utilities', () => {
    test('extracts refreshToken values from the Kiro JSON sample shape', () => {
        const payload = {
            value: [
                { refreshToken: 'rt-one', provider: 'Google', email: 'first@example.com' },
                { refreshToken: 'rt-two', provider: 'Google', email: 'second@example.com' }
            ],
            Count: 2
        };

        expect(extractRefreshTokensFromJsonPayload(payload)).toEqual(['rt-one', 'rt-two']);
    });

    test('recursively extracts supported refresh token key variants', () => {
        const payload = {
            accounts: [
                { refresh_token: 'rt_snake' },
                { nested: { 'refresh-token': 'rt-dash' } },
                { deeply: [{ RefreshToken: 'rt-camel-case' }] }
            ]
        };

        expect(extractRefreshTokensFromJsonPayload(payload)).toEqual([
            'rt_snake',
            'rt-dash',
            'rt-camel-case'
        ]);
    });

    test('deduplicates and ignores non-string refreshToken values', () => {
        const payload = {
            refreshToken: ' duplicate ',
            nested: [
                { refreshToken: 'duplicate' },
                { refreshToken: '' },
                { refreshToken: null },
                { refreshToken: 123 }
            ]
        };

        expect(extractRefreshTokensFromJsonPayload(payload)).toEqual(['duplicate']);
    });

    test('parses JSON strings before extraction', () => {
        const payload = JSON.stringify({
            value: [{ refreshToken: 'rt-from-json-string' }]
        });

        expect(extractRefreshTokensFromJsonPayload(payload)).toEqual(['rt-from-json-string']);
    });

    test('normalizes direct token arrays without leaking duplicates', () => {
        expect(normalizeRefreshTokenList([' rt-one ', 'rt-one', '', null, 'rt-two'])).toEqual([
            'rt-one',
            'rt-two'
        ]);
    });

    test('merges token sources preserving first-seen order', () => {
        expect(mergeRefreshTokenSources(['rt-one', 'rt-two'], ['rt-two', 'rt-three'])).toEqual([
            'rt-one',
            'rt-two',
            'rt-three'
        ]);
    });

    test('matches refresh token keys case-insensitively across common separators', () => {
        expect(isRefreshTokenKey('refreshToken')).toBe(true);
        expect(isRefreshTokenKey('refresh_token')).toBe(true);
        expect(isRefreshTokenKey('refresh-token')).toBe(true);
        expect(isRefreshTokenKey('accessToken')).toBe(false);
    });
});
