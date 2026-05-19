import { getRequestBody } from '../utils/common.js';
import logger from '../utils/logger.js';
import { withFileLock } from '../utils/file-lock.js';
import { parseProxyUrl } from '../utils/proxy-utils.js';
import axios from 'axios';
import {
    buildProxyUrl,
    buildSingBoxConfigFromProxies,
    getProxiesFilePath,
    isRedactedProxyUrl,
    listProxiesWithAssignmentCounts,
    loadProviderPools,
    loadProxies,
    mergeImportedProxies,
    parseProxyImportItem,
    parseProxyJsonPayload,
    parseProxyLine,
    parseSubscriptionContent,
    pickProxyFromPool,
    sanitizeProxy,
    saveProxies
} from '../utils/proxy-registry.js';
import { invalidateServiceAdapter } from '../providers/adapter.js';
import { atomicWriteFile } from '../utils/file-lock.js';

function sendJSON(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return true;
}

function syncProviderPoolManager(currentConfig, providerPoolManager, providerPools) {
    if (currentConfig) {
        currentConfig.providerPools = providerPools;
    }
    if (providerPoolManager) {
        providerPoolManager.providerPools = providerPools;
        providerPoolManager.initializeProviderStatus(true);
    }
}

function invalidateChangedProviders(providerPools, changedRefs = []) {
    for (const ref of changedRefs) {
        if (ref.providerType && ref.uuid) {
            invalidateServiceAdapter(ref.providerType, ref.uuid);
        }
    }
}

export async function handleGetProxies(req, res, currentConfig, providerPoolManager) {
    try {
        const proxies = listProxiesWithAssignmentCounts(currentConfig, providerPoolManager);
        return sendJSON(res, 200, {
            success: true,
            proxies: proxies.map(proxy => sanitizeProxy(proxy))
        });
    } catch (error) {
        logger.error('[Proxy API] Failed to list proxies:', error.message);
        return sendJSON(res, 500, { error: { message: error.message } });
    }
}

export async function handleCreateProxy(req, res, currentConfig) {
    try {
        const body = await getRequestBody(req);
        const filePath = getProxiesFilePath(currentConfig);
        return await withFileLock(filePath, async () => {
            const existing = loadProxies(currentConfig);
            const proxy = parseProxyLine(body.url || body.proxyUrl || `${body.protocol}://${body.host}:${body.port}`, {
                name: body.name,
                protocol: body.protocol,
                enabled: body.enabled !== false,
                poolEnabled: body.poolEnabled ?? body.pool_enabled ?? true,
                tags: body.tags || []
            });

            if (body.username !== undefined) proxy.username = body.username;
            if (body.password !== undefined) proxy.password = body.password;
            if (body.name !== undefined) proxy.name = body.name;

            const merged = mergeImportedProxies(existing, [proxy]);
            await saveProxies(currentConfig, merged.proxies);
            const saved = merged.proxies.find(item => item.id === proxy.id) || proxy;
            return sendJSON(res, 200, {
                success: true,
                created: merged.created,
                reused: merged.reused,
                proxy: sanitizeProxy(saved)
            });
        });
    } catch (error) {
        logger.error('[Proxy API] Failed to create proxy:', error.message);
        return sendJSON(res, 500, { error: { message: error.message } });
    }
}

export async function handleUpdateProxy(req, res, currentConfig, proxyId) {
    try {
        const body = await getRequestBody(req);
        const filePath = getProxiesFilePath(currentConfig);
        return await withFileLock(filePath, async () => {
            const proxies = loadProxies(currentConfig);
            const index = proxies.findIndex(proxy => proxy.id === proxyId);
            if (index === -1) {
                return sendJSON(res, 404, { error: { message: 'Proxy not found' } });
            }

            const current = proxies[index];
            const updated = {
                ...current,
                id: current.id,
                name: body.name !== undefined ? body.name : current.name,
                enabled: body.enabled !== undefined ? body.enabled : current.enabled,
                poolEnabled: body.poolEnabled ?? body.pool_enabled ?? current.poolEnabled,
                tags: Array.isArray(body.tags) ? body.tags : current.tags,
                updatedAt: new Date().toISOString()
            };
            const submittedUrl = body.url || body.proxyUrl;
            if (submittedUrl && !isRedactedProxyUrl(submittedUrl)) {
                const parsed = parseProxyLine(submittedUrl, {
                    name: updated.name,
                    enabled: updated.enabled,
                    poolEnabled: updated.poolEnabled,
                    tags: updated.tags
                });
                Object.assign(updated, parsed, { id: current.id });
            }

            proxies[index] = updated;
            await saveProxies(currentConfig, proxies);
            return sendJSON(res, 200, {
                success: true,
                proxy: sanitizeProxy(proxies[index])
            });
        });
    } catch (error) {
        logger.error('[Proxy API] Failed to update proxy:', error.message);
        return sendJSON(res, 500, { error: { message: error.message } });
    }
}

export async function handleDeleteProxy(req, res, currentConfig, providerPoolManager, proxyId) {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const force = url.searchParams.get('force') === 'true';
        const proxyFilePath = getProxiesFilePath(currentConfig);
        const providerFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';

        return await withFileLock(proxyFilePath, async () => {
            return await withFileLock(providerFilePath, async () => {
                const proxies = loadProxies(currentConfig);
                const index = proxies.findIndex(proxy => proxy.id === proxyId);
                if (index === -1) {
                    return sendJSON(res, 404, { error: { message: 'Proxy not found' } });
                }

                const providerPools = loadProviderPools(currentConfig, providerPoolManager);
                const inUse = [];
                for (const [providerType, providers] of Object.entries(providerPools)) {
                    if (!Array.isArray(providers)) continue;
                    for (const provider of providers) {
                        if (provider.proxyId === proxyId) {
                            inUse.push({ providerType, uuid: provider.uuid });
                        }
                    }
                }

                if (inUse.length > 0 && !force) {
                    return sendJSON(res, 409, {
                        error: { message: 'Proxy is in use' },
                        inUse
                    });
                }

                if (force && inUse.length > 0) {
                    for (const { providerType, uuid } of inUse) {
                        const provider = providerPools[providerType]?.find(item => item.uuid === uuid);
                        if (provider) {
                            delete provider.proxyId;
                        }
                    }
                    await atomicWriteFile(providerFilePath, JSON.stringify(providerPools, null, 2), 'utf-8');
                    syncProviderPoolManager(currentConfig, providerPoolManager, providerPools);
                    invalidateChangedProviders(providerPools, inUse);
                }

                proxies.splice(index, 1);
                await saveProxies(currentConfig, proxies);
                return sendJSON(res, 200, {
                    success: true,
                    deleted: 1,
                    unbound: force ? inUse.length : 0
                });
            });
        });
    } catch (error) {
        logger.error('[Proxy API] Failed to delete proxy:', error.message);
        return sendJSON(res, 500, { error: { message: error.message } });
    }
}

export async function handleImportProxies(req, res, currentConfig) {
    try {
        const body = await getRequestBody(req);
        const filePath = getProxiesFilePath(currentConfig);
        return await withFileLock(filePath, async () => {
            const existing = loadProxies(currentConfig);
            const importDefaults = {
                protocol: body.defaultProtocol || 'http',
                enabled: body.enabled !== false,
                poolEnabled: body.poolEnabled ?? body.pool_enabled ?? true,
                tags: body.tags || []
            };

            const imported = [];
            const errors = [];

            if (body.data !== undefined || body.json !== undefined) {
                try {
                    imported.push(...parseProxyJsonPayload(body.data ?? body.json, importDefaults));
                } catch (error) {
                    errors.push({ index: 1, error: error.message });
                }
            } else {
                const lines = Array.isArray(body.proxies)
                    ? body.proxies
                    : String(body.text || body.proxyText || '').split(/\r?\n/);

                lines.forEach((line, index) => {
                    try {
                        const proxy = typeof line === 'object'
                            ? parseProxyImportItem(line, importDefaults)
                            : parseProxyLine(line, importDefaults);
                        if (proxy) imported.push(proxy);
                    } catch (error) {
                        errors.push({ index: index + 1, line, error: error.message });
                    }
                });
            }

            const merged = mergeImportedProxies(existing, imported);
            merged.failed += errors.length;
            merged.items.push(...errors.map(error => ({ success: false, ...error })));
            await saveProxies(currentConfig, merged.proxies);

            return sendJSON(res, 200, {
                success: true,
                created: merged.created,
                reused: merged.reused,
                failed: merged.failed,
                items: merged.items,
                proxies: merged.proxies.map(proxy => sanitizeProxy(proxy))
            });
        });
    } catch (error) {
        logger.error('[Proxy API] Failed to import proxies:', error.message);
        return sendJSON(res, 500, { error: { message: error.message } });
    }
}

export async function handleImportSubscription(req, res, currentConfig) {
    try {
        const body = await getRequestBody(req);
        let subscriptionContent = body.content || body.subscriptionContent || '';
        const subscriptionUrl = body.subscriptionUrl || body.url || '';
        if (!subscriptionContent && subscriptionUrl) {
            const response = await axios.get(subscriptionUrl, {
                timeout: 20000,
                responseType: 'text',
                validateStatus: status => status >= 200 && status < 300
            });
            subscriptionContent = response.data;
        }
        if (!subscriptionContent) {
            return sendJSON(res, 400, { error: { message: 'subscription content or url is required' } });
        }

        const filePath = getProxiesFilePath(currentConfig);
        return await withFileLock(filePath, async () => {
            const existing = loadProxies(currentConfig);
            const imported = parseSubscriptionContent(subscriptionContent, {
                keyword: body.keyword || '',
                localHost: body.localHost || 'a2-proxy',
                startPort: Number.parseInt(body.startPort || 11001, 10),
                enabled: body.enabled !== false,
                poolEnabled: body.poolEnabled ?? body.pool_enabled ?? true,
                tags: body.tags || ['subscription']
            });

            const merged = mergeImportedProxies(existing, imported);
            await saveProxies(currentConfig, merged.proxies);
            return sendJSON(res, 200, {
                success: true,
                created: merged.created,
                reused: merged.reused,
                failed: merged.failed,
                proxies: merged.proxies.map(proxy => sanitizeProxy(proxy))
            });
        });
    } catch (error) {
        logger.error('[Proxy API] Failed to import subscription:', error.message);
        return sendJSON(res, 500, { error: { message: error.message } });
    }
}

export async function handleGenerateSingBoxConfig(req, res, currentConfig) {
    try {
        const proxies = loadProxies(currentConfig);
        const config = buildSingBoxConfigFromProxies(proxies);
        return sendJSON(res, 200, {
            success: true,
            config,
            inbounds: config.inbounds.length,
            outbounds: Math.max(0, config.outbounds.length - 1)
        });
    } catch (error) {
        logger.error('[Proxy API] Failed to generate sing-box config:', error.message);
        return sendJSON(res, 500, { error: { message: error.message } });
    }
}

export async function handleTestProxy(req, res, currentConfig, proxyId) {
    const started = Date.now();
    try {
        const proxies = loadProxies(currentConfig);
        const proxy = proxies.find(item => item.id === proxyId);
        if (!proxy) {
            return sendJSON(res, 404, { error: { message: 'Proxy not found' } });
        }

        const proxyUrl = buildProxyUrl(proxy);
        const proxyConfig = parseProxyUrl(proxyUrl);
        if (!proxyConfig) {
            return sendJSON(res, 400, { error: { message: 'Invalid proxy URL' } });
        }

        const response = await axios.get('https://api.ipify.org?format=json', {
            httpAgent: proxyConfig.httpAgent,
            httpsAgent: proxyConfig.httpsAgent,
            proxy: false,
            timeout: 12000,
            validateStatus: status => status >= 200 && status < 300
        });
        const body = response.data;
        const latencyMs = Date.now() - started;

        proxy.exitIp = body.ip || '';
        proxy.latencyMs = latencyMs;
        proxy.lastCheckAt = new Date().toISOString();
        proxy.lastError = '';
        await saveProxies(currentConfig, proxies);

        return sendJSON(res, 200, {
            success: true,
            latencyMs,
            exitIp: proxy.exitIp
        });
    } catch (error) {
        try {
            const proxies = loadProxies(currentConfig);
            const proxy = proxies.find(item => item.id === proxyId);
            if (proxy) {
                proxy.lastCheckAt = new Date().toISOString();
                proxy.lastError = error.message;
                await saveProxies(currentConfig, proxies);
            }
        } catch {
            // Best-effort metadata update only.
        }
        return sendJSON(res, 200, {
            success: false,
            latencyMs: Date.now() - started,
            error: error.message
        });
    }
}

export async function handleAutoAssignProxies(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const providerFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';

        return await withFileLock(providerFilePath, async () => {
            const proxies = listProxiesWithAssignmentCounts(currentConfig, providerPoolManager);
            const counts = Object.fromEntries(proxies.map(proxy => [proxy.id, proxy.assignedCount || 0]));
            const providerPools = loadProviderPools(currentConfig, providerPoolManager);
            const providerTypes = Array.isArray(body.providerTypes) && body.providerTypes.length > 0
                ? new Set(body.providerTypes)
                : null;
            const ids = Array.isArray(body.items)
                ? new Set(body.items.map(item => `${item.providerType}:${item.uuid}`))
                : null;
            const force = body.force === true;

            const changed = [];
            const result = { assigned: 0, skipped: 0, failed: 0, noProxy: 0, items: [] };

            for (const [providerType, providers] of Object.entries(providerPools)) {
                if (!Array.isArray(providers)) continue;
                if (providerTypes && !providerTypes.has(providerType)) continue;

                for (const provider of providers) {
                    if (!provider?.uuid) {
                        result.skipped++;
                        continue;
                    }
                    if (ids && !ids.has(`${providerType}:${provider.uuid}`)) {
                        continue;
                    }
                    if (provider.isDisabled) {
                        result.skipped++;
                        continue;
                    }
                    if (provider.proxyId && !force) {
                        result.skipped++;
                        continue;
                    }

                    const selected = pickProxyFromPool(proxies, counts);
                    if (!selected) {
                        result.noProxy++;
                        result.skipped++;
                        continue;
                    }

                    provider.proxyId = selected.id;
                    counts[selected.id] = (counts[selected.id] || 0) + 1;
                    changed.push({ providerType, uuid: provider.uuid });
                    result.assigned++;
                    result.items.push({ providerType, uuid: provider.uuid, proxyId: selected.id });
                }
            }

            if (changed.length > 0) {
                await atomicWriteFile(providerFilePath, JSON.stringify(providerPools, null, 2), 'utf-8');
                syncProviderPoolManager(currentConfig, providerPoolManager, providerPools);
                invalidateChangedProviders(providerPools, changed);
            }

            return sendJSON(res, 200, {
                success: true,
                ...result
            });
        });
    } catch (error) {
        logger.error('[Proxy API] Failed to auto assign proxies:', error.message);
        return sendJSON(res, 500, { error: { message: error.message } });
    }
}
