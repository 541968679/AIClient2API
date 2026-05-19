import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWriteFile } from './file-lock.js';

export const DEFAULT_PROXIES_FILE_PATH = 'configs/proxies.json';
export const SUPPORTED_DIRECT_PROXY_PROTOCOLS = new Set(['http', 'https', 'socks', 'socks4', 'socks5', 'socks5h']);
export const SUPPORTED_SUBSCRIPTION_PROTOCOLS = new Set(['vless', 'vmess', 'trojan']);

function nowISO() {
    return new Date().toISOString();
}

export function getProxiesFilePath(config = {}) {
    return config.PROXIES_FILE_PATH || config.PROXY_REGISTRY_FILE_PATH || DEFAULT_PROXIES_FILE_PATH;
}

function ensureParentDir(filePath) {
    const dir = path.dirname(filePath);
    if (dir && dir !== '.' && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function normalizeBool(value, defaultValue) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return defaultValue;
}

function normalizePort(value) {
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid proxy port: ${value}`);
    }
    return port;
}

function decodeMaybe(value = '') {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function normalizeProxyRecord(raw = {}) {
    const createdAt = raw.createdAt || raw.created_at || nowISO();
    const updatedAt = raw.updatedAt || raw.updated_at || createdAt;
    const protocol = String(raw.protocol || '').replace(':', '').toLowerCase();
    const sourceType = raw.sourceType || raw.source_type || (raw.upstreamUrl ? 'subscription' : 'manual');
    const status = raw.status || (raw.enabled === false ? 'inactive' : 'active');
    const enabled = normalizeBool(raw.enabled, status !== 'inactive');
    const poolEnabled = normalizeBool(raw.poolEnabled ?? raw.pool_enabled, true);
    const name = String(raw.name || raw.remark || raw.tag || '').trim();

    return {
        id: raw.id || crypto.randomUUID(),
        name: name || raw.host || raw.localUrl || raw.upstreamUrl || 'Proxy',
        protocol,
        host: raw.host || '',
        port: raw.port ? normalizePort(raw.port) : null,
        username: raw.username || '',
        password: raw.password || '',
        enabled,
        status: enabled ? status : 'inactive',
        poolEnabled,
        sourceType,
        upstreamType: raw.upstreamType || raw.upstream_type || protocol || '',
        upstreamUrl: raw.upstreamUrl || raw.upstream_url || '',
        localUrl: raw.localUrl || raw.local_url || '',
        localHost: raw.localHost || raw.local_host || '',
        localPort: raw.localPort || raw.local_port || null,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        exitIp: raw.exitIp || raw.exit_ip || '',
        latencyMs: raw.latencyMs ?? raw.latency_ms ?? null,
        lastCheckAt: raw.lastCheckAt || raw.last_check_at || null,
        lastError: raw.lastError || raw.last_error || '',
        createdAt,
        updatedAt
    };
}

export function loadProxies(config = {}) {
    const filePath = getProxiesFilePath(config);
    if (!existsSync(filePath)) {
        return [];
    }

    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    const records = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.proxies) ? parsed.proxies : []);
    return records.map(normalizeProxyRecord);
}

export async function saveProxies(config = {}, proxies = []) {
    const filePath = getProxiesFilePath(config);
    ensureParentDir(filePath);
    const normalized = proxies.map(normalizeProxyRecord);
    await atomicWriteFile(filePath, JSON.stringify({ proxies: normalized }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    return normalized;
}

export function buildProxyUrl(proxy) {
    const record = normalizeProxyRecord(proxy);
    if (record.localUrl) {
        return record.localUrl;
    }
    if (!record.protocol || !record.host || !record.port) {
        return '';
    }

    const url = new URL(`${record.protocol}://${record.host}:${record.port}`);
    if (record.username || record.password) {
        url.username = record.username || '';
        url.password = record.password || '';
    }
    return url.toString();
}

export function redactProxyUrl(proxyUrl = '') {
    if (!proxyUrl || typeof proxyUrl !== 'string') return '';
    try {
        const url = new URL(proxyUrl);
        if (url.password) url.password = '******';
        if (url.username) url.username = url.username ? '******' : '';
        return url.toString();
    } catch {
        return proxyUrl.replace(/\/\/([^:@/\s]+):([^@/\s]+)@/, '//******:******@');
    }
}

export function isRedactedProxyUrl(proxyUrl = '') {
    return typeof proxyUrl === 'string' && proxyUrl.includes('******');
}

export function sanitizeProxy(proxy, options = {}) {
    const record = normalizeProxyRecord(proxy);
    const assignedCount = proxy.assignedCount ?? proxy.assigned_count;
    const sanitized = {
        ...record,
        url: redactProxyUrl(buildProxyUrl(record))
    };
    if (assignedCount !== undefined) {
        sanitized.assignedCount = assignedCount;
    }
    if (options.includeSecret !== true) {
        sanitized.password = record.password ? '******' : '';
        sanitized.upstreamUrl = record.upstreamUrl ? redactProxyUrl(record.upstreamUrl) : '';
    }
    return sanitized;
}

function parseUrlProxy(line, defaults = {}) {
    const parsed = new URL(line);
    const protocol = parsed.protocol.replace(':', '').toLowerCase();
    if (!SUPPORTED_DIRECT_PROXY_PROTOCOLS.has(protocol)) {
        throw new Error(`Unsupported direct proxy protocol: ${protocol}`);
    }
    if (!parsed.port) {
        throw new Error(`Proxy port is required: ${line}`);
    }
    return normalizeProxyRecord({
        id: defaults.id,
        name: defaults.name || parsed.searchParams.get('name') || `${protocol}://${parsed.hostname}:${parsed.port}`,
        protocol,
        host: parsed.hostname,
        port: normalizePort(parsed.port),
        username: decodeMaybe(parsed.username),
        password: decodeMaybe(parsed.password),
        enabled: defaults.enabled,
        poolEnabled: defaults.poolEnabled,
        tags: defaults.tags || []
    });
}

function parsePlainProxy(line, defaults = {}) {
    const protocol = defaults.protocol || 'http';
    if (!SUPPORTED_DIRECT_PROXY_PROTOCOLS.has(protocol)) {
        throw new Error(`Unsupported direct proxy protocol: ${protocol}`);
    }

    let hostPort = line;
    let username = '';
    let password = '';

    if (line.includes('@')) {
        const [auth, target] = line.split('@');
        hostPort = target;
        const authParts = auth.split(':');
        username = authParts[0] || '';
        password = authParts.slice(1).join(':') || '';
    } else {
        const parts = line.split(':');
        if (parts.length >= 4) {
            hostPort = `${parts[0]}:${parts[1]}`;
            username = parts[2] || '';
            password = parts.slice(3).join(':') || '';
        }
    }

    const lastColon = hostPort.lastIndexOf(':');
    if (lastColon <= 0) {
        throw new Error(`Invalid proxy line: ${line}`);
    }

    const host = hostPort.slice(0, lastColon).replace(/^\[|\]$/g, '');
    const port = normalizePort(hostPort.slice(lastColon + 1));
    return normalizeProxyRecord({
        name: defaults.name || `${protocol}://${host}:${port}`,
        protocol,
        host,
        port,
        username,
        password,
        enabled: defaults.enabled,
        poolEnabled: defaults.poolEnabled,
        tags: defaults.tags || []
    });
}

export function parseProxyLine(line, defaults = {}) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) {
        return null;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        const scheme = trimmed.slice(0, trimmed.indexOf('://')).toLowerCase();
        if (SUPPORTED_DIRECT_PROXY_PROTOCOLS.has(scheme)) {
            return parseUrlProxy(trimmed, defaults);
        }
        if (SUPPORTED_SUBSCRIPTION_PROTOCOLS.has(scheme)) {
            return parseSubscriptionNodeLine(trimmed, defaults);
        }
        throw new Error(`Unsupported proxy protocol: ${scheme}`);
    }
    return parsePlainProxy(trimmed, defaults);
}

function decodeBase64URLSafe(input) {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64').toString('utf-8');
}

function safeNodeName(rawUrl, fallback) {
    const hashIndex = rawUrl.indexOf('#');
    if (hashIndex >= 0) {
        const name = decodeMaybe(rawUrl.slice(hashIndex + 1)).trim();
        if (name) return name;
    }
    return fallback;
}

export function parseSubscriptionNodeLine(line, defaults = {}) {
    const trimmed = String(line || '').trim();
    const scheme = trimmed.slice(0, trimmed.indexOf('://')).toLowerCase();
    if (!SUPPORTED_SUBSCRIPTION_PROTOCOLS.has(scheme)) {
        throw new Error(`Unsupported subscription node protocol: ${scheme}`);
    }

    const index = Number.isInteger(defaults.index) ? defaults.index : 0;
    const localHost = defaults.localHost || 'a2-proxy';
    const localPort = defaults.localPort || (defaults.startPort ? defaults.startPort + index : null);
    const localUrl = defaults.localUrl || (localPort ? `http://${localHost}:${localPort}` : '');
    const name = defaults.name || safeNodeName(trimmed, `${scheme.toUpperCase()} Node ${index + 1}`);

    return normalizeProxyRecord({
        name,
        protocol: 'http',
        host: localHost,
        port: localPort,
        enabled: defaults.enabled,
        poolEnabled: defaults.poolEnabled,
        sourceType: 'subscription',
        upstreamType: scheme,
        upstreamUrl: trimmed,
        localUrl,
        localHost,
        localPort,
        tags: defaults.tags || []
    });
}

export function parseSubscriptionContent(content, options = {}) {
    const raw = String(content || '').trim();
    if (!raw) return [];

    let decoded = raw;
    const singleLine = !raw.includes('\n') && /^[A-Za-z0-9+/_=-]+$/.test(raw);
    if (singleLine) {
        try {
            const candidate = decodeBase64URLSafe(raw);
            if (candidate.includes('://')) {
                decoded = candidate;
            }
        } catch {
            decoded = raw;
        }
    }

    const keyword = String(options.keyword || '').trim().toLowerCase();
    return decoded
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !keyword || decodeMaybe(line).toLowerCase().includes(keyword))
        .map((line, index) => parseProxyLine(line, { ...options, index }));
}

function proxyDedupKey(proxy) {
    const record = normalizeProxyRecord(proxy);
    if (record.upstreamUrl) return `${record.upstreamType}:${record.upstreamUrl}`;
    return [record.protocol, record.host, record.port, record.username, record.password, record.localUrl].join('|');
}

export function mergeImportedProxies(existing = [], imported = []) {
    const merged = existing.map(normalizeProxyRecord);
    const existingKeys = new Map(merged.map(proxy => [proxyDedupKey(proxy), proxy.id]));
    const result = {
        proxies: merged,
        created: 0,
        reused: 0,
        failed: 0,
        items: []
    };

    for (const proxy of imported) {
        try {
            const normalized = normalizeProxyRecord(proxy);
            const key = proxyDedupKey(normalized);
            const existingID = existingKeys.get(key);
            if (existingID) {
                result.reused++;
                result.items.push({ success: true, reused: true, id: existingID, name: normalized.name });
                continue;
            }
            result.proxies.push(normalized);
            existingKeys.set(key, normalized.id);
            result.created++;
            result.items.push({ success: true, reused: false, id: normalized.id, name: normalized.name });
        } catch (error) {
            result.failed++;
            result.items.push({ success: false, error: error.message });
        }
    }

    return result;
}

export function loadProviderPools(config = {}, providerPoolManager = null) {
    if (providerPoolManager?.providerPools) {
        return providerPoolManager.providerPools;
    }
    if (config.providerPools) {
        return config.providerPools;
    }
    const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    if (!existsSync(filePath)) {
        return {};
    }
    return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export function countProxyAssignments(providerPools = {}) {
    const counts = {};
    for (const providers of Object.values(providerPools)) {
        if (!Array.isArray(providers)) continue;
        for (const provider of providers) {
            if (provider?.isDisabled) continue;
            const proxyId = provider?.proxyId || provider?.proxy_id;
            if (!proxyId) continue;
            counts[proxyId] = (counts[proxyId] || 0) + 1;
        }
    }
    return counts;
}

export function listProxiesWithAssignmentCounts(config = {}, providerPoolManager = null) {
    const proxies = loadProxies(config);
    const providerPools = loadProviderPools(config, providerPoolManager);
    const counts = countProxyAssignments(providerPools);
    return proxies.map(proxy => ({
        ...proxy,
        assignedCount: counts[proxy.id] || 0
    }));
}

export function pickProxyFromPool(proxies = [], counts = {}) {
    const candidates = proxies
        .map(normalizeProxyRecord)
        .filter(proxy => proxy.enabled && proxy.status !== 'inactive' && proxy.poolEnabled && buildProxyUrl(proxy));

    if (candidates.length === 0) {
        return null;
    }

    let minCount = Number.POSITIVE_INFINITY;
    for (const proxy of candidates) {
        minCount = Math.min(minCount, counts[proxy.id] || 0);
    }

    const leastUsed = candidates.filter(proxy => (counts[proxy.id] || 0) === minCount);
    return leastUsed[Math.floor(Math.random() * leastUsed.length)];
}

export function assignProxyToProviderConfig(providerConfig, proxies, counts = {}) {
    if (!providerConfig || providerConfig.proxyId) {
        return null;
    }
    const selected = pickProxyFromPool(proxies, counts);
    if (!selected) {
        return null;
    }
    providerConfig.proxyId = selected.id;
    counts[selected.id] = (counts[selected.id] || 0) + 1;
    return selected;
}

export function resolveProxyUrlForProviderConfig(providerConfig = {}, config = {}) {
    const override = providerConfig.proxyUrlOverride || providerConfig.proxyUrl || providerConfig.PROVIDER_PROXY_URL;
    if (override && typeof override === 'string') {
        return override.trim();
    }

    const proxyId = providerConfig.proxyId || providerConfig.proxy_id;
    if (!proxyId) {
        return '';
    }

    const proxy = loadProxies(config).find(item => item.id === proxyId);
    if (!proxy || !proxy.enabled || proxy.status === 'inactive') {
        return '';
    }
    return buildProxyUrl(proxy);
}

function parseVlessOutbound(proxy) {
    const url = new URL(proxy.upstreamUrl);
    const params = url.searchParams;
    const outbound = {
        type: 'vless',
        tag: `proxy-${proxy.id}`,
        server: url.hostname,
        server_port: normalizePort(url.port || (params.get('security') === 'tls' ? 443 : 80)),
        uuid: url.username,
        packet_encoding: params.get('packetEncoding') || 'xudp'
    };

    if ((params.get('security') || '').toLowerCase() === 'tls') {
        outbound.tls = {
            enabled: true,
            server_name: params.get('sni') || params.get('host') || url.hostname,
            utls: {
                enabled: true,
                fingerprint: params.get('fp') || 'chrome'
            }
        };
    }

    if ((params.get('type') || '').toLowerCase() === 'ws') {
        const headers = {};
        const host = params.get('host');
        if (host) headers.Host = host;
        outbound.transport = {
            type: 'ws',
            path: params.get('path') || '/',
            headers
        };
    }

    return outbound;
}

export function buildSingBoxConfigFromProxies(proxies = []) {
    const selected = proxies
        .map(normalizeProxyRecord)
        .filter(proxy => proxy.sourceType === 'subscription' && proxy.upstreamUrl && proxy.localPort);

    const inbounds = [];
    const outbounds = [{ type: 'direct', tag: 'direct' }];
    const rules = [];

    for (const proxy of selected) {
        if (proxy.upstreamType !== 'vless') {
            continue;
        }
        const inboundTag = `in-${proxy.id}`;
        const outboundTag = `proxy-${proxy.id}`;
        inbounds.push({
            type: 'mixed',
            tag: inboundTag,
            listen: '0.0.0.0',
            listen_port: normalizePort(proxy.localPort)
        });
        const outbound = parseVlessOutbound(proxy);
        outbound.tag = outboundTag;
        outbounds.push(outbound);
        rules.push({ inbound: [inboundTag], outbound: outboundTag });
    }

    return {
        log: { level: 'info', timestamp: true },
        inbounds,
        outbounds,
        route: {
            rules,
            final: 'direct'
        }
    };
}
