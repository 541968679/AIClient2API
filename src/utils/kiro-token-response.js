function pickDefined(source, keys) {
    if (!source || typeof source !== 'object') {
        return undefined;
    }

    for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null) {
            return source[key];
        }
    }

    return undefined;
}

function pickString(source, keys, fallback = '') {
    const value = pickDefined(source, keys);
    if (typeof value === 'string' && value.trim()) {
        return value;
    }
    return fallback;
}

function pickPositiveNumber(source, keys, fallback) {
    const value = pickDefined(source, keys);
    const numberValue = Number(value);
    if (Number.isFinite(numberValue) && numberValue > 0) {
        return numberValue;
    }
    return fallback;
}

export function normalizeKiroTokenResponse(data, previousRefreshToken = '') {
    return {
        accessToken: pickString(data, ['accessToken', 'access_token']),
        refreshToken: pickString(data, ['refreshToken', 'refresh_token'], previousRefreshToken),
        profileArn: pickString(data, ['profileArn', 'profile_arn']),
        expiresIn: pickPositiveNumber(data, ['expiresIn', 'expires_in'], 3600)
    };
}
