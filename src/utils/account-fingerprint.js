import crypto from 'crypto';

export function createRefreshTokenFingerprint(refreshToken) {
    if (!refreshToken || typeof refreshToken !== 'string') {
        return null;
    }

    const normalizedToken = refreshToken.trim();
    if (!normalizedToken) {
        return null;
    }

    return crypto
        .createHash('sha256')
        .update(normalizedToken)
        .digest('hex')
        .slice(0, 12)
        .toUpperCase();
}

export function createKiroAccountIdentity(refreshToken) {
    const fingerprint = createRefreshTokenFingerprint(refreshToken);
    if (!fingerprint) {
        return {};
    }

    return {
        accountFingerprint: `kiro-${fingerprint.toLowerCase()}`,
        accountName: `Kiro-${fingerprint}`
    };
}
