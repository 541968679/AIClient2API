const REFRESH_TOKEN_KEY_NAMES = new Set(['refreshtoken']);

function normalizeKey(key) {
    return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isRefreshTokenKey(key) {
    return REFRESH_TOKEN_KEY_NAMES.has(normalizeKey(key));
}

function addToken(tokens, seen, value) {
    if (typeof value !== 'string') {
        return;
    }

    const token = value.trim();
    if (!token || seen.has(token)) {
        return;
    }

    seen.add(token);
    tokens.push(token);
}

function parseJsonString(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || !['{', '['].includes(trimmed[0])) {
        return null;
    }

    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

function walkRefreshTokens(value, tokens, seen) {
    if (value === null || value === undefined) {
        return;
    }

    if (typeof value === 'string') {
        const parsed = parseJsonString(value);
        if (parsed !== null) {
            walkRefreshTokens(parsed, tokens, seen);
        }
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            walkRefreshTokens(item, tokens, seen);
        }
        return;
    }

    if (typeof value !== 'object') {
        return;
    }

    for (const [key, item] of Object.entries(value)) {
        if (isRefreshTokenKey(key)) {
            addToken(tokens, seen, item);
        }
        walkRefreshTokens(item, tokens, seen);
    }
}

export function extractRefreshTokensFromJsonPayload(payload) {
    const tokens = [];
    const seen = new Set();
    walkRefreshTokens(payload, tokens, seen);
    return tokens;
}

export function normalizeRefreshTokenList(refreshTokens) {
    const tokens = [];
    const seen = new Set();

    if (!Array.isArray(refreshTokens)) {
        return tokens;
    }

    for (const item of refreshTokens) {
        addToken(tokens, seen, item);
    }

    return tokens;
}

export function mergeRefreshTokenSources(...sources) {
    const tokens = [];
    const seen = new Set();

    for (const source of sources) {
        if (!Array.isArray(source)) {
            continue;
        }

        for (const token of source) {
            addToken(tokens, seen, token);
        }
    }

    return tokens;
}
