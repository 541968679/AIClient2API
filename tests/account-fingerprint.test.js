import {
    createKiroAccountIdentity,
    createRefreshTokenFingerprint
} from '../src/utils/account-fingerprint.js';

describe('account fingerprint utilities', () => {
    test('creates stable fingerprints from refresh tokens', () => {
        const first = createRefreshTokenFingerprint('sample-refresh-token');
        const second = createRefreshTokenFingerprint('sample-refresh-token');
        const different = createRefreshTokenFingerprint('another-refresh-token');

        expect(first).toBe(second);
        expect(first).not.toBe(different);
        expect(first).toMatch(/^[0-9A-F]{12}$/);
    });

    test('creates stable Kiro account identity without exposing the refresh token', () => {
        const identity = createKiroAccountIdentity('sample-refresh-token');

        expect(identity.accountName).toBe(`Kiro-${createRefreshTokenFingerprint('sample-refresh-token')}`);
        expect(identity.accountFingerprint).toBe(`kiro-${createRefreshTokenFingerprint('sample-refresh-token').toLowerCase()}`);
        expect(JSON.stringify(identity)).not.toContain('sample-refresh-token');
    });

    test('does not create identities from empty tokens', () => {
        expect(createRefreshTokenFingerprint('   ')).toBeNull();
        expect(createKiroAccountIdentity('   ')).toEqual({});
    });
});
