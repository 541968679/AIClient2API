// 模态框管理模块

import { escapeHtml, showToast, getFieldLabel, getProviderTypeFields } from './utils.js';
import { handleProviderPasswordToggle } from './event-handlers.js';
import { t } from './i18n.js';

const MANAGED_MODEL_LIST_PROVIDERS = new Set(['openai-custom', 'openaiResponses-custom', 'claude-custom']);

// 分页配置
const PROVIDERS_PER_PAGE = 5;
let currentPage = 1;
let currentProviders = [];
let currentProviderType = '';
let nodeSearchTerm = '';
let currentViewMode = localStorage.getItem('providerViewMode') || 'list';
let cachedProxyOptions = [];
let selectedProviderUuids = new Set();
let kiroUsageByUuid = new Map();
let kiroUsageLoadedAt = null;
let kiroUsageLoading = false;
let kiroUsageRefreshingUuids = new Set();
let kiroUsageRefreshProgress = null;
let kiroUsageRefreshRunId = 0;
let kiroHealthCheckingUuids = new Set();
let kiroHealthCheckProgress = null;
let kiroHealthCheckRunId = 0;
let kiroRecoveryCountdownTimer = null;

function usesManagedModelList(providerType = '') {
    return Array.from(MANAGED_MODEL_LIST_PROVIDERS).some(baseType =>
        providerType === baseType || providerType.startsWith(`${baseType}-`)
    );
}

function normalizeModelList(models = []) {
    return [...new Set(
        (Array.isArray(models) ? models : [])
            .filter(model => typeof model === 'string')
            .map(model => model.trim())
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));
}

function serializeModelsData(models = []) {
    return encodeURIComponent(JSON.stringify(normalizeModelList(models)));
}

function parseModelsData(rawValue = '') {
    if (!rawValue) {
        return [];
    }

    try {
        return normalizeModelList(JSON.parse(decodeURIComponent(rawValue)));
    } catch (error) {
        console.warn('Failed to parse models data:', error);
        return [];
    }
}

function renderSupportedModelsValue(models = []) {
    const selectedModels = normalizeModelList(models);
    if (selectedModels.length === 0) {
        return `<div class="supported-models-empty">${escapeHtml(t('modal.provider.supportedModelsEmpty'))}</div>`;
    }

    return `
        <div class="supported-models-list">
            ${selectedModels.map(model => `
                <span class="supported-model-tag" title="${escapeHtml(model)}">${escapeHtml(model)}</span>
            `).join('')}
        </div>
    `;
}

function getSupportedModelsContainer(uuid) {
    return document.querySelector(`.supported-models-container[data-uuid="${uuid}"]`);
}

function setSupportedModelsSelection(uuid, models, options = {}) {
    const container = getSupportedModelsContainer(uuid);
    if (!container) return;

    const normalizedModels = normalizeModelList(models);
    const encodedModels = serializeModelsData(normalizedModels);
    container.dataset.selectedModels = encodedModels;

    if (options.updateOriginal) {
        container.dataset.originalModels = encodedModels;
    }

    const valueContainer = container.querySelector('.supported-models-values');
    if (valueContainer) {
        valueContainer.innerHTML = renderSupportedModelsValue(normalizedModels);
    }

    const summary = container.querySelector('.supported-models-summary');
    if (summary) {
        summary.textContent = t('modal.provider.modelPickerSelected', { count: normalizedModels.length });
    }
}

function resetSupportedModelsSelection(uuid) {
    const container = getSupportedModelsContainer(uuid);
    if (!container) return;
    setSupportedModelsSelection(uuid, parseModelsData(container.dataset.originalModels || ''));
}

function renderSupportedModelsSection(provider) {
    const selectedModels = normalizeModelList(provider.supportedModels || []);
    const encodedModels = serializeModelsData(selectedModels);

    return `
        <div class="config-item supported-models-section">
            <label>
                <i class="fas fa-layer-group"></i> <span data-i18n="modal.provider.supportedModels">${t('modal.provider.supportedModels')}</span>
                <span class="help-text" data-i18n="modal.provider.supportedModelsHelp">${t('modal.provider.supportedModelsHelp')}</span>
            </label>
            <div class="supported-models-container"
                 data-uuid="${provider.uuid}"
                 data-selected-models="${encodedModels}"
                 data-original-models="${encodedModels}">
                <div class="supported-models-toolbar">
                    <span class="supported-models-summary">${escapeHtml(t('modal.provider.modelPickerSelected', { count: selectedModels.length }))}</span>
                    <button type="button"
                            class="btn btn-outline detect-models-btn"
                            onclick="window.openSupportedModelsPicker('${currentProviderType}', '${provider.uuid}', event)"
                            disabled>
                        <i class="fas fa-wand-magic-sparkles"></i>
                        <span data-i18n="modal.provider.detectModels">${t('modal.provider.detectModels')}</span>
                    </button>
                </div>
                <div class="supported-models-values">
                    ${renderSupportedModelsValue(selectedModels)}
                </div>
            </div>
        </div>
    `;
}

function collectDraftProviderConfig(providerDetail, providerType, uuid) {
    const configInputs = providerDetail.querySelectorAll('input[data-config-key]');
    const configSelects = providerDetail.querySelectorAll('select[data-config-key]');
    const providerConfig = {};

    configInputs.forEach(input => {
        const key = input.dataset.configKey;
        let value = input.value;
        if (key === 'concurrencyLimit' || key === 'queueLimit') {
            value = parseInt(value || '0', 10);
        }
        providerConfig[key] = value;
    });

    configSelects.forEach(select => {
        const key = select.dataset.configKey;
        if (key === 'proxyId') {
            providerConfig[key] = select.value || null;
        } else {
            providerConfig[key] = select.value === 'true';
        }
    });

    const autoAssignProxyInput = providerDetail.querySelector('input[data-config-key="autoAssignProxy"]');
    if (autoAssignProxyInput) {
        providerConfig.autoAssignProxy = autoAssignProxyInput.checked;
    }

    if (usesManagedModelList(providerType)) {
        const supportedModels = parseModelsData(getSupportedModelsContainer(uuid)?.dataset.selectedModels || '');
        providerConfig.supportedModels = supportedModels;
        providerConfig.notSupportedModels = [];
    } else {
        const modelCheckboxes = providerDetail.querySelectorAll(`.model-checkbox[data-uuid="${uuid}"]:checked`);
        providerConfig.notSupportedModels = Array.from(modelCheckboxes).map(checkbox => checkbox.value);
    }

    return providerConfig;
}
let cachedModels = []; // 缓存模型列表

async function loadProxyOptions(force = false) {
    if (!force && cachedProxyOptions.length > 0) {
        return cachedProxyOptions;
    }
    try {
        const data = await window.apiClient.get('/proxies');
        cachedProxyOptions = data.proxies || [];
    } catch (error) {
        console.warn('Failed to load proxy options:', error);
        cachedProxyOptions = [];
    }
    return cachedProxyOptions;
}

function renderProxyBindingSection(provider = {}) {
    const currentProxyId = provider.proxyId || '';
    const options = cachedProxyOptions.map(proxy => {
        const selected = proxy.id === currentProxyId ? 'selected' : '';
        const count = proxy.assignedCount !== undefined ? ` (${proxy.assignedCount})` : '';
        const status = proxy.enabled === false ? ` - ${t('proxies.disabled')}` : '';
        return `<option value="${escapeHtml(proxy.id)}" ${selected}>${escapeHtml(proxy.name || proxy.id)}${count}${status}</option>`;
    }).join('');
    const proxyLabel = provider.proxy
        ? `${provider.proxy.name || provider.proxy.id} (${provider.proxy.assignedCount || 0})`
        : t('modal.provider.noProxy');

    return `
        <div class="form-grid full-width proxy-binding-section">
            <div class="config-item">
                <label>
                    <i class="fas fa-route"></i> ${escapeHtml(t('modal.provider.proxy'))}
                    <span class="help-text">${escapeHtml(proxyLabel)}</span>
                </label>
                <select class="form-control"
                        data-config-key="proxyId"
                        data-config-value="${escapeHtml(currentProxyId)}"
                        disabled>
                    <option value="">${escapeHtml(t('modal.provider.noProxy'))}</option>
                    ${options}
                </select>
            </div>
            <div class="config-item">
                <label>
                    <i class="fas fa-random"></i> ${escapeHtml(t('modal.provider.autoAssignProxy'))}
                    <span class="help-text">${escapeHtml(t('proxies.autoAssign'))}</span>
                </label>
                <input type="checkbox"
                       data-config-key="autoAssignProxy"
                       data-config-value="false"
                       disabled>
            </div>
        </div>
    `;
}

function getProviderProxySummary(provider = {}) {
    const proxyId = provider.proxyId || provider.proxy_id || '';
    const proxy = provider.proxy;
    if (proxy) {
        const count = proxy.assignedCount !== undefined ? ` (${proxy.assignedCount})` : '';
        const status = proxy.enabled === false ? ` - ${t('proxies.disabled')}` : '';
        return {
            label: proxy.name || proxy.id || proxyId,
            title: `${proxy.url || proxy.localUrl || proxy.host || proxyId}${count}${status}`,
            bound: true
        };
    }
    if (proxyId) {
        return {
            label: proxyId,
            title: proxyId,
            bound: true
        };
    }
    return {
        label: t('modal.provider.noProxy'),
        title: t('modal.provider.noProxy'),
        bound: false
    };
}

function renderProviderProxySummary(provider = {}) {
    const summary = getProviderProxySummary(provider);
    return `
        <span class="provider-proxy-summary ${summary.bound ? 'bound' : 'unbound'}" title="${escapeHtml(summary.title)}">
            <i class="fas fa-route"></i>
            <span data-i18n="modal.provider.proxy">${escapeHtml(t('modal.provider.proxy'))}</span>:
            <span class="provider-proxy-name">${escapeHtml(summary.label)}</span>
        </span>
    `;
}

function closeSupportedModelsPicker(overlay) {
    if (!overlay) return;

    if (overlay.escapeHandler) {
        document.removeEventListener('keydown', overlay.escapeHandler);
    }

    overlay.remove();
}

function showSupportedModelsPickerModal(providerType, uuid, detectedModels, currentSelectedModels = []) {
    const existingOverlay = document.querySelector('.provider-model-picker-overlay');
    if (existingOverlay) {
        closeSupportedModelsPicker(existingOverlay);
    }

    const allModels = normalizeModelList([...detectedModels, ...currentSelectedModels]);
    const selectedModels = new Set(normalizeModelList(currentSelectedModels));
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay provider-model-picker-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
        <div class="modal-content provider-model-picker-modal">
            <div class="modal-header">
                <h3>
                    <i class="fas fa-cubes"></i>
                    ${escapeHtml(t('modal.provider.modelPickerTitle', { type: providerType }))}
                </h3>
                <button class="modal-close" type="button" aria-label="${escapeHtml(t('common.close'))}">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <div class="provider-model-picker-toolbar">
                    <input type="search"
                           class="provider-model-picker-search"
                           placeholder="${escapeHtml(t('modal.provider.modelPickerSearchPlaceholder'))}">
                    <label class="provider-model-picker-select-all">
                        <input type="checkbox" class="provider-model-picker-select-all-input">
                        <span>${escapeHtml(t('modal.provider.modelPickerSelectAll'))}</span>
                    </label>
                    <button type="button" class="btn btn-secondary provider-model-picker-clear">
                        ${escapeHtml(t('modal.provider.modelPickerClearAll'))}
                    </button>
                </div>
                <div class="provider-model-picker-summary"></div>
                <div class="provider-model-picker-list"></div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary provider-model-picker-cancel">
                    ${escapeHtml(t('common.cancel'))}
                </button>
                <button type="button" class="btn btn-primary provider-model-picker-confirm">
                    ${escapeHtml(t('common.confirm'))}
                </button>
            </div>
        </div>
    `;

    const searchInput = overlay.querySelector('.provider-model-picker-search');
    const listContainer = overlay.querySelector('.provider-model-picker-list');
    const summary = overlay.querySelector('.provider-model-picker-summary');
    const selectAllInput = overlay.querySelector('.provider-model-picker-select-all-input');
    const clearButton = overlay.querySelector('.provider-model-picker-clear');
    const cancelButton = overlay.querySelector('.provider-model-picker-cancel');
    const confirmButton = overlay.querySelector('.provider-model-picker-confirm');
    const closeButton = overlay.querySelector('.modal-close');

    const getVisibleModels = () => {
        const keyword = searchInput.value.trim().toLowerCase();
        if (!keyword) {
            return allModels;
        }

        return allModels.filter(model => model.toLowerCase().includes(keyword));
    };

    const updateSelectAllState = () => {
        const visibleModels = getVisibleModels();
        if (visibleModels.length === 0) {
            selectAllInput.checked = false;
            selectAllInput.indeterminate = false;
            selectAllInput.disabled = true;
            return;
        }

        selectAllInput.disabled = false;
        const checkedCount = visibleModels.filter(model => selectedModels.has(model)).length;
        selectAllInput.checked = checkedCount === visibleModels.length;
        selectAllInput.indeterminate = checkedCount > 0 && checkedCount < visibleModels.length;
    };

    const updateSummary = () => {
        summary.textContent = t('modal.provider.modelPickerSelected', { count: selectedModels.size });
    };

    const renderList = () => {
        const visibleModels = getVisibleModels();

        if (visibleModels.length === 0) {
            listContainer.innerHTML = `
                <div class="provider-model-picker-empty">
                    ${escapeHtml(allModels.length === 0 ? t('modal.provider.detectModelsNoResults') : t('modal.provider.supportedModelsEmpty'))}
                </div>
            `;
            updateSelectAllState();
            updateSummary();
            return;
        }

        listContainer.innerHTML = visibleModels.map(model => `
            <label class="provider-model-picker-item">
                <input type="checkbox"
                       value="${escapeHtml(model)}"
                       ${selectedModels.has(model) ? 'checked' : ''}>
                <span>${escapeHtml(model)}</span>
            </label>
        `).join('');

        listContainer.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    selectedModels.add(checkbox.value);
                } else {
                    selectedModels.delete(checkbox.value);
                }
                updateSelectAllState();
                updateSummary();
            });
        });

        updateSelectAllState();
        updateSummary();
    };

    const handleClose = () => closeSupportedModelsPicker(overlay);

    overlay.escapeHandler = event => {
        if (event.key === 'Escape') {
            handleClose();
        }
    };

    document.addEventListener('keydown', overlay.escapeHandler);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            handleClose();
        }
    });

    searchInput.addEventListener('input', renderList);
    selectAllInput.addEventListener('change', () => {
        const visibleModels = getVisibleModels();
        visibleModels.forEach(model => {
            if (selectAllInput.checked) {
                selectedModels.add(model);
            } else {
                selectedModels.delete(model);
            }
        });
        renderList();
    });
    clearButton.addEventListener('click', () => {
        selectedModels.clear();
        renderList();
    });
    cancelButton.addEventListener('click', handleClose);
    closeButton.addEventListener('click', handleClose);
    confirmButton.addEventListener('click', () => {
        setSupportedModelsSelection(uuid, Array.from(selectedModels));
        handleClose();
    });

    document.body.appendChild(overlay);
    renderList();
    searchInput.focus();
}

async function openSupportedModelsPicker(providerType, uuid, event) {
    event.stopPropagation();

    if (!usesManagedModelList(providerType)) {
        return;
    }

    const providerDetail = event.target.closest('.provider-item-detail, .provider-item-card');
    if (!providerDetail) {
        return;
    }

    const detectButton = providerDetail.querySelector('.detect-models-btn');
    const originalHtml = detectButton?.innerHTML;
    const draftProviderConfig = collectDraftProviderConfig(providerDetail, providerType, uuid);

    try {
        if (detectButton) {
            detectButton.disabled = true;
            detectButton.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(t('common.loading'))}`;
        }

        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/${uuid}/detect-models`,
            { providerConfig: draftProviderConfig }
        );

        showSupportedModelsPickerModal(
            providerType,
            uuid,
            response.models || [],
            draftProviderConfig.supportedModels || response.selectedModels || []
        );
    } catch (error) {
        console.error('Failed to detect provider models:', error);
        showToast(t('common.error'), t('modal.provider.detectModelsFailed') + ': ' + error.message, 'error');
    } finally {
        if (detectButton) {
            detectButton.innerHTML = originalHtml;
            detectButton.disabled = !providerDetail.classList.contains('editing');
        }
    }
}

async function performHealthCheckAll(providerType) {
    if (!confirm(t('modal.provider.healthCheckAllConfirm', { type: providerType }))) {
        return;
    }

    if (providerType === 'claude-kiro-oauth') {
        const targets = currentProviders.filter(provider => provider?.uuid && provider.isDisabled !== true);
        await performKiroHealthChecks(providerType, targets, {
            mode: 'all',
            emptyMessageKey: 'modal.provider.kiroConsole.health.noEnabled'
        });
        return;
    }

    try {
        showToast(t('common.info'), t('modal.provider.healthCheckAllRunning'), 'info');

        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/health-check-all`,
            {}
        );

        if (response.success) {
            const successCount = response.successCount || 0;
            const failCount = response.failCount || 0;
            const rateLimitCount = response.rateLimitCount || 0;
            const skippedCount = response.skippedCount || 0;
            const message = t('modal.provider.healthCheckAll.complete', {
                success: successCount,
                fail: failCount,
                rateLimited: rateLimitCount,
                skipped: skippedCount
            });

            showToast(t('common.info'), message, failCount > 0 ? 'warning' : 'success');
            await window.apiClient.post('/reload-config');
            await refreshProviderConfig(providerType);
        } else {
            showToast(t('common.error'), t('modal.provider.healthCheckAll.failed'), 'error');
        }
    } catch (error) {
        console.error('Full health check failed:', error);
        showToast(t('common.error'), t('modal.provider.healthCheckAll.failed') + ': ' + error.message, 'error');
    }
}

async function performHealthCheckAllIncludingDisabled(providerType) {
    if (providerType !== 'claude-kiro-oauth') {
        await performHealthCheckAll(providerType);
        return;
    }

    if (!confirm(t('modal.provider.healthCheckAllIncludingDisabledConfirm', { type: providerType }))) {
        return;
    }

    const targets = currentProviders.filter(provider => provider?.uuid);
    await performKiroHealthChecks(providerType, targets, {
        mode: 'all',
        includeDisabled: true,
        emptyMessageKey: 'modal.provider.kiroConsole.health.noAccounts'
    });
}

function formatProviderDateTime(value) {
    return value ? new Date(value).toLocaleString() : '-';
}

function formatProviderRelative(value) {
    if (!value) return '-';

    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) {
        return '-';
    }

    const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (diffSeconds < 60) return t('modal.provider.time.justNow');
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return t('modal.provider.time.minutesAgo', { count: diffMinutes });
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return t('modal.provider.time.hoursAgo', { count: diffHours });
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return t('modal.provider.time.daysAgo', { count: diffDays });
    return new Date(value).toLocaleDateString();
}

function getShortUuid(uuid = '') {
    if (!uuid) return '-';
    return uuid.length > 12 ? `${uuid.slice(0, 8)}...${uuid.slice(-4)}` : uuid;
}

function getKiroProviderStats(providers = []) {
    const total = providers.length;
    const healthy = providers.filter(provider => provider.isHealthy === true && provider.isDisabled !== true).length;
    const unhealthy = providers.filter(provider => provider.isHealthy !== true).length;
    const disabled = providers.filter(provider => provider.isDisabled === true).length;
    const needsRefresh = providers.filter(provider => provider.needsRefresh === true).length;
    const proxied = providers.filter(provider => provider.proxyId || provider.proxy_id || provider.proxy).length;
    return { total, healthy, unhealthy, disabled, needsRefresh, proxied };
}

function resetKiroUsageState() {
    kiroUsageByUuid = new Map();
    kiroUsageLoadedAt = null;
    kiroUsageLoading = false;
    kiroUsageRefreshingUuids = new Set();
    kiroUsageRefreshProgress = null;
    kiroUsageRefreshRunId++;
    resetKiroHealthCheckState();
}

function resetKiroHealthCheckState() {
    kiroHealthCheckingUuids = new Set();
    kiroHealthCheckProgress = null;
    kiroHealthCheckRunId++;
}

function getKiroUsageSummary(provider) {
    const usageEntry = kiroUsageByUuid.get(provider.uuid);
    if (kiroUsageRefreshingUuids.has(provider.uuid)) {
        const progressText = kiroUsageRefreshProgress
            ? t('modal.provider.kiroConsole.usage.progress', {
                completed: kiroUsageRefreshProgress.completed,
                total: kiroUsageRefreshProgress.total
            })
            : '';
        return {
            status: 'loading',
            label: t('modal.provider.kiroConsole.usage.refreshing'),
            detail: progressText,
            percent: 0
        };
    }

    if (kiroUsageLoading && !usageEntry) {
        return { status: 'loading', label: t('common.loading'), percent: 0 };
    }

    if (!usageEntry) {
        return { status: 'empty', label: t('modal.provider.kiroConsole.usage.notLoaded'), percent: 0 };
    }

    if (usageEntry.error) {
        return {
            status: 'error',
            label: t('common.error'),
            detail: usageEntry.error,
            percent: 0
        };
    }

    const usage = usageEntry.usage;
    const breakdown = Array.isArray(usage?.usageBreakdown) ? usage.usageBreakdown : [];
    if (!usageEntry.success || breakdown.length === 0) {
        return { status: 'empty', label: t('usage.noData'), percent: 0 };
    }

    let used = 0;
    let limit = 0;
    for (const item of breakdown) {
        used += Number(item.currentUsage) || 0;
        limit += Number(item.usageLimit) || 0;

        if (item.freeTrial && item.freeTrial.status === 'ACTIVE') {
            used += Number(item.freeTrial.currentUsage) || 0;
            limit += Number(item.freeTrial.usageLimit) || 0;
        }

        if (Array.isArray(item.bonuses)) {
            for (const bonus of item.bonuses) {
                if (bonus.status === 'ACTIVE') {
                    used += Number(bonus.currentUsage) || 0;
                    limit += Number(bonus.usageLimit) || 0;
                }
            }
        }
    }

    const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    const firstReset = breakdown.find(item => item.nextDateReset || item.resetTime);
    const resetAt = firstReset?.nextDateReset || firstReset?.resetTime || usage.nextDateReset || null;
    const plan = usage.subscription?.title || '';

    return {
        status: percent >= 90 ? 'danger' : (percent >= 70 ? 'warning' : 'normal'),
        label: `${formatKiroUsageNumber(used)} / ${formatKiroUsageNumber(limit)}`,
        detail: plan || (resetAt ? t('usage.card.resetAt', { time: formatProviderDateTime(resetAt) }) : ''),
        percent,
        used,
        limit,
        resetAt,
        plan
    };
}

function formatKiroUsageNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '-';
    if (Math.abs(number) >= 1000) return number.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (Number.isInteger(number)) return String(number);
    return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function getKiroUsageProviderName(provider = {}) {
    return provider.customName || provider.accountName || provider.name || provider.uuid || '-';
}

function getKiroUsageRefreshTargets(targetUuids = null) {
    const uuidList = Array.isArray(targetUuids) && targetUuids.length > 0
        ? targetUuids.map(uuid => String(uuid)).filter(Boolean)
        : [];

    if (uuidList.length > 0) {
        return uuidList
            .map(uuid => currentProviders.find(provider => provider.uuid === uuid) || { uuid })
            .filter(provider => provider?.uuid);
    }

    return currentProviders.filter(provider => provider?.uuid);
}

function getKiroHealthCheckProviderName(provider = {}) {
    return provider.customName || provider.accountName || provider.name || provider.uuid || '-';
}

function renderKiroProgressPanel(progress, keyPrefix) {
    if (!progress || !progress.total) return '';

    const percent = Math.max(0, Math.min(100, (progress.completed / progress.total) * 100));
    const label = t(`${keyPrefix}.progress`, {
        completed: progress.completed,
        total: progress.total
    });
    const current = progress.currentName
        ? t(`${keyPrefix}.current`, { name: progress.currentName })
        : '';

    return `
        <div class="kiro-progress-panel" role="status">
            <div class="kiro-progress-panel-top">
                <span><i class="fas fa-spinner fa-spin"></i>${escapeHtml(label)}</span>
                ${current ? `<small title="${escapeHtml(current)}">${escapeHtml(current)}</small>` : ''}
            </div>
            <div class="kiro-progress-panel-bar">
                <span style="width: ${percent}%"></span>
            </div>
        </div>
    `;
}

function renderKiroUsageRefreshProgress() {
    return renderKiroProgressPanel(kiroUsageRefreshProgress, 'modal.provider.kiroConsole.usage');
}

function renderKiroHealthCheckProgress() {
    return renderKiroProgressPanel(kiroHealthCheckProgress, 'modal.provider.kiroConsole.health');
}

function getKiroRecoveryTime(provider = {}) {
    if (provider.isHealthy || provider.isDisabled || !provider.scheduledRecoveryTime) {
        return null;
    }

    const timestamp = new Date(provider.scheduledRecoveryTime).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

function formatKiroRecoveryCountdown(recoveryTime) {
    if (!Number.isFinite(recoveryTime)) {
        return '';
    }

    const remainingMs = recoveryTime - Date.now();
    if (remainingMs <= 0) {
        return t('modal.provider.kiroConsole.recovery.checkingSoon');
    }

    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const timeText = minutes > 0
        ? `${minutes}:${String(seconds).padStart(2, '0')}`
        : `${seconds}s`;

    return t('modal.provider.kiroConsole.recovery.countdown', { time: timeText });
}

function updateKiroRecoveryCountdowns() {
    const nodes = document.querySelectorAll('.kiro-recovery-countdown[data-recovery-time]');
    nodes.forEach(node => {
        const recoveryTime = Number(node.dataset.recoveryTime);
        const label = node.querySelector('.kiro-status-label');
        if (label) {
            label.textContent = formatKiroRecoveryCountdown(recoveryTime);
        }
    });
}

function stopKiroRecoveryCountdownTimer() {
    if (kiroRecoveryCountdownTimer) {
        clearInterval(kiroRecoveryCountdownTimer);
        kiroRecoveryCountdownTimer = null;
    }
}

function syncKiroRecoveryCountdownTimer() {
    stopKiroRecoveryCountdownTimer();
    if (currentProviderType !== 'claude-kiro-oauth') {
        return;
    }

    const hasCountdown = currentProviders.some(provider => getKiroRecoveryTime(provider));
    if (!hasCountdown) {
        return;
    }

    updateKiroRecoveryCountdowns();
    kiroRecoveryCountdownTimer = setInterval(updateKiroRecoveryCountdowns, 1000);
}

function renderKiroUsageCell(provider) {
    const summary = getKiroUsageSummary(provider);
    if (summary.status === 'loading') {
        return `
            <div class="kiro-usage-cell loading">
                <div class="kiro-usage-loading-line">
                    <i class="fas fa-spinner fa-spin"></i>
                    <span>${escapeHtml(summary.label)}</span>
                </div>
                ${summary.detail ? `<small>${escapeHtml(summary.detail)}</small>` : ''}
            </div>
        `;
    }

    if (summary.status === 'error') {
        return `
            <div class="kiro-usage-cell error" title="${escapeHtml(summary.detail || '')}">
                <span>${escapeHtml(summary.label)}</span>
                ${summary.detail ? `<div class="kiro-usage-error-snippet">${escapeHtml(summary.detail)}</div>` : ''}
            </div>
        `;
    }

    if (summary.status === 'empty') {
        return `
            <div class="kiro-usage-cell ${summary.status}" title="${escapeHtml(summary.detail || '')}">
                <span>${escapeHtml(summary.label)}</span>
                ${summary.detail ? `<small>${escapeHtml(summary.detail)}</small>` : ''}
            </div>
        `;
    }

    const percentText = `${summary.percent.toFixed(summary.percent >= 10 ? 1 : 2)}%`;
    const detail = summary.detail || (summary.resetAt ? t('usage.card.resetAt', { time: formatProviderDateTime(summary.resetAt) }) : '');
    return `
        <div class="kiro-usage-cell ${summary.status}" title="${escapeHtml(detail)}">
            <div class="kiro-usage-top">
                <span>${escapeHtml(summary.label)}</span>
                <strong>${escapeHtml(percentText)}</strong>
            </div>
            <div class="kiro-usage-bar">
                <span style="width: ${Math.max(0, Math.min(100, summary.percent))}%"></span>
            </div>
            ${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
        </div>
    `;
}

function renderKiroActivityCell(provider, lastUsedText, lastUsedTitle, lastCheckText, lastCheckTitle, lastHealthCheckModel) {
    const checkTitle = lastHealthCheckModel && lastHealthCheckModel !== '-'
        ? `${lastCheckTitle} / ${lastHealthCheckModel}`
        : lastCheckTitle;
    return `
        <div class="kiro-activity-cell">
            <span title="${escapeHtml(t('modal.provider.kiroConsole.activity.requests'))}">
                <i class="fas fa-paper-plane"></i>
                ${provider.usageCount || 0}
            </span>
            <span class="${provider.errorCount > 0 ? 'has-error' : ''}" title="${escapeHtml(t('modal.provider.kiroConsole.activity.errors'))}">
                <i class="fas fa-exclamation-circle"></i>
                ${provider.errorCount || 0}
            </span>
            <span title="${escapeHtml(t('modal.provider.kiroConsole.activity.lastUsed'))}: ${escapeHtml(lastUsedTitle)}">
                <i class="fas fa-clock"></i>
                ${escapeHtml(lastUsedText)}
            </span>
            <span title="${escapeHtml(t('modal.provider.kiroConsole.activity.lastCheck'))}: ${escapeHtml(checkTitle)}">
                <i class="fas fa-stethoscope"></i>
                ${escapeHtml(lastCheckText)}
            </span>
        </div>
    `;
}

function cleanSelectedProviderUuids() {
    const availableUuids = new Set(currentProviders.map(provider => provider.uuid));
    selectedProviderUuids = new Set(
        Array.from(selectedProviderUuids).filter(uuid => availableUuids.has(uuid))
    );
}

function getKiroSelectedProviders() {
    cleanSelectedProviderUuids();
    return currentProviders.filter(provider => selectedProviderUuids.has(provider.uuid));
}

function getKiroProviderBadges(provider) {
    const badges = [];
    const recoveryTime = getKiroRecoveryTime(provider);
    if (kiroHealthCheckingUuids.has(provider.uuid)) {
        badges.push({
            className: 'checking',
            icon: 'fas fa-spinner fa-spin',
            label: t('modal.provider.kiroConsole.health.checking')
        });
    }

    if (provider.isDisabled) {
        badges.push({
            className: 'disabled',
            icon: 'fas fa-ban',
            label: t('modal.provider.status.disabled')
        });
    } else if (provider.isHealthy) {
        badges.push({
            className: 'healthy',
            icon: 'fas fa-check-circle',
            label: t('modal.provider.status.healthy')
        });
    } else {
        badges.push({
            className: 'unhealthy',
            icon: 'fas fa-exclamation-triangle',
            label: t('modal.provider.status.unhealthy')
        });
    }

    if (recoveryTime) {
        badges.push({
            className: 'cooldown',
            icon: 'fas fa-hourglass-half',
            label: formatKiroRecoveryCountdown(recoveryTime),
            recoveryTime
        });
    }

    if (provider.needsRefresh) {
        badges.push({
            className: 'refresh',
            icon: 'fas fa-sync-alt',
            label: t('providers.status.needsRefresh')
        });
    }

    return badges.map(badge => `
        <span class="kiro-status-badge ${badge.className}${badge.recoveryTime ? ' kiro-recovery-countdown' : ''}"${badge.recoveryTime ? ` data-recovery-time="${badge.recoveryTime}"` : ''}>
            <i class="${badge.icon}"></i>
            <span class="kiro-status-label">${escapeHtml(badge.label)}</span>
        </span>
    `).join('');
}

function renderKiroStatsGrid(providers = []) {
    const stats = getKiroProviderStats(providers);
    return `
        <div class="kiro-console-stats">
            <div class="kiro-stat-card">
                <span class="kiro-stat-label">${escapeHtml(t('modal.provider.kiroConsole.stats.total'))}</span>
                <strong>${stats.total}</strong>
            </div>
            <div class="kiro-stat-card healthy">
                <span class="kiro-stat-label">${escapeHtml(t('modal.provider.kiroConsole.stats.healthy'))}</span>
                <strong>${stats.healthy}</strong>
            </div>
            <div class="kiro-stat-card warning">
                <span class="kiro-stat-label">${escapeHtml(t('modal.provider.kiroConsole.stats.unhealthy'))}</span>
                <strong>${stats.unhealthy}</strong>
            </div>
            <div class="kiro-stat-card muted">
                <span class="kiro-stat-label">${escapeHtml(t('modal.provider.kiroConsole.stats.disabled'))}</span>
                <strong>${stats.disabled}</strong>
            </div>
            <div class="kiro-stat-card accent">
                <span class="kiro-stat-label">${escapeHtml(t('modal.provider.kiroConsole.stats.proxied'))}</span>
                <strong>${stats.proxied}</strong>
            </div>
            <div class="kiro-stat-card refresh">
                <span class="kiro-stat-label">${escapeHtml(t('modal.provider.kiroConsole.stats.needsRefresh'))}</span>
                <strong>${stats.needsRefresh}</strong>
            </div>
        </div>
    `;
}

function renderKiroConsoleActions(providerType) {
    return `
        <div class="kiro-console-action-section">
            <div class="kiro-action-group">
                <span class="kiro-action-group-label">${escapeHtml(t('modal.provider.actions.account'))}</span>
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.showKiroBatchImportFromProviderConsole('${providerType}')`,
                    icon: 'fas fa-file-import',
                    labelKey: 'modal.provider.kiroConsole.importRt'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.showKiroAwsImportFromProviderConsole('${providerType}')`,
                    icon: 'fas fa-cloud-upload-alt',
                    labelKey: 'modal.provider.kiroConsole.importAws'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.showAddProviderForm('${providerType}')`,
                    icon: 'fas fa-plus',
                    labelKey: 'modal.provider.add'
                })}
            </div>
            <div class="kiro-action-group">
                <span class="kiro-action-group-label">${escapeHtml(t('modal.provider.actions.health'))}</span>
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.performHealthCheck('${providerType}')`,
                    icon: 'fas fa-stethoscope',
                    labelKey: 'modal.provider.healthCheck'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.performHealthCheckAll('${providerType}')`,
                    icon: 'fas fa-heartbeat',
                    labelKey: 'modal.provider.healthCheckAll',
                    titleKey: 'modal.provider.healthCheckAllTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.performHealthCheckAllIncludingDisabled('${providerType}')`,
                    icon: 'fas fa-universal-access',
                    labelKey: 'modal.provider.healthCheckAllIncludingDisabled',
                    titleKey: 'modal.provider.healthCheckAllIncludingDisabledTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.resetAllProvidersHealth('${providerType}')`,
                    icon: 'fas fa-heart',
                    labelKey: 'modal.provider.resetHealth',
                    titleKey: 'modal.provider.resetHealthTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.refreshUnhealthyUuids('${providerType}')`,
                    icon: 'fas fa-sync-alt',
                    labelKey: 'modal.provider.refreshUnhealthyUuidsBtn'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.refreshKiroUsage(false)`,
                    icon: 'fas fa-chart-line',
                    labelKey: 'modal.provider.kiroConsole.refreshUsage',
                    titleKey: 'modal.provider.kiroConsole.refreshUsageTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.refreshKiroUsage(true)`,
                    icon: 'fas fa-cloud-download-alt',
                    labelKey: 'modal.provider.kiroConsole.forceRefreshUsage',
                    titleKey: 'modal.provider.kiroConsole.forceRefreshUsageTitle'
                })}
            </div>
            <div class="kiro-action-group">
                <span class="kiro-action-group-label">${escapeHtml(t('modal.provider.actions.proxyName'))}</span>
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.autoAssignProviderProxies('${providerType}')`,
                    icon: 'fas fa-random',
                    labelKey: 'proxies.autoAssign',
                    titleKey: 'proxies.autoAssignTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.updateKiroStableNames('${providerType}')`,
                    icon: 'fas fa-signature',
                    labelKey: 'modal.provider.updateKiroNames',
                    titleKey: 'modal.provider.updateKiroNamesTitle'
                })}
            </div>
            <div class="kiro-action-group">
                <span class="kiro-action-group-label">${escapeHtml(t('modal.provider.actions.exportCleanup'))}</span>
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.exportKiroRefreshTokens('${providerType}', false)`,
                    icon: 'fas fa-download',
                    labelKey: 'modal.provider.exportRtAll',
                    titleKey: 'modal.provider.exportRtAllTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.exportKiroRefreshTokens('${providerType}', true)`,
                    icon: 'fas fa-file-medical-alt',
                    labelKey: 'modal.provider.exportRtHealthy',
                    titleKey: 'modal.provider.exportRtHealthyTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-danger',
                    onClick: `window.deleteUnhealthyProviders('${providerType}')`,
                    icon: 'fas fa-trash-alt',
                    labelKey: 'modal.provider.deleteUnhealthyBtn'
                })}
            </div>
        </div>
    `;
}

function renderKiroBulkActionsBar() {
    const selectedCount = selectedProviderUuids.size;
    const disabled = selectedCount === 0 ? 'disabled' : '';
    return `
        <div class="kiro-bulk-actions ${selectedCount > 0 ? 'active' : ''}" id="kiroBulkActions">
            <div class="kiro-bulk-summary">
                <i class="fas fa-check-square"></i>
                <span>${escapeHtml(t('modal.provider.kiroConsole.selected', { count: selectedCount }))}</span>
            </div>
            <div class="kiro-bulk-buttons">
                <button class="btn btn-info provider-action-text-btn" onclick="window.performSelectedKiroHealthCheck()" ${disabled}>
                    <i class="fas fa-stethoscope"></i>
                    <span>${escapeHtml(t('modal.provider.kiroConsole.selectedHealthCheck'))}</span>
                </button>
                <button class="btn btn-info provider-action-text-btn" onclick="window.resetSelectedKiroProvidersHealth()" ${disabled}>
                    <i class="fas fa-heart"></i>
                    <span>${escapeHtml(t('modal.provider.kiroConsole.selectedResetHealth'))}</span>
                </button>
                <button class="btn btn-info provider-action-text-btn" onclick="window.refreshSelectedKiroUsage()" ${disabled}>
                    <i class="fas fa-chart-line"></i>
                    <span>${escapeHtml(t('modal.provider.kiroConsole.selectedRefreshUsage'))}</span>
                </button>
                <button class="btn btn-info provider-action-text-btn" onclick="window.setSelectedKiroProvidersDisabled(false)" ${disabled}>
                    <i class="fas fa-play"></i>
                    <span>${escapeHtml(t('modal.provider.kiroConsole.selectedEnable'))}</span>
                </button>
                <button class="btn btn-info provider-action-text-btn" onclick="window.setSelectedKiroProvidersDisabled(true)" ${disabled}>
                    <i class="fas fa-ban"></i>
                    <span>${escapeHtml(t('modal.provider.kiroConsole.selectedDisable'))}</span>
                </button>
                <button class="btn btn-danger provider-action-text-btn" onclick="window.deleteSelectedKiroProviders()" ${disabled}>
                    <i class="fas fa-trash"></i>
                    <span>${escapeHtml(t('modal.provider.kiroConsole.selectedDelete'))}</span>
                </button>
                <button class="btn btn-secondary provider-action-text-btn" onclick="window.clearKiroProviderSelection()" ${disabled}>
                    <i class="fas fa-times"></i>
                    <span>${escapeHtml(t('modal.provider.kiroConsole.clearSelection'))}</span>
                </button>
            </div>
        </div>
    `;
}

function renderKiroTableHeader(providers = []) {
    const allChecked = providers.length > 0 && providers.every(provider => selectedProviderUuids.has(provider.uuid));
    const someChecked = providers.some(provider => selectedProviderUuids.has(provider.uuid));
    return `
        <div class="kiro-table-row kiro-table-header">
            <div class="kiro-cell kiro-cell-select">
                <input type="checkbox"
                       class="kiro-select-all"
                       ${allChecked ? 'checked' : ''}
                       ${someChecked && !allChecked ? 'data-indeterminate="true"' : ''}
                       onchange="window.toggleKiroProviderSelectAll(this.checked)">
            </div>
            <div class="kiro-cell">${escapeHtml(t('modal.provider.kiroConsole.columns.account'))}</div>
            <div class="kiro-cell">${escapeHtml(t('modal.provider.kiroConsole.columns.status'))}</div>
            <div class="kiro-cell">${escapeHtml(t('modal.provider.kiroConsole.columns.proxy'))}</div>
            <div class="kiro-cell">${escapeHtml(t('modal.provider.kiroConsole.columns.usage'))}</div>
            <div class="kiro-cell">${escapeHtml(t('modal.provider.kiroConsole.columns.activity'))}</div>
            <div class="kiro-cell">${escapeHtml(t('modal.provider.kiroConsole.columns.actions'))}</div>
        </div>
    `;
}

function renderKiroProviderRow(provider) {
    const isHealthy = provider.isHealthy;
    const isDisabled = provider.isDisabled || false;
    const healthClass = isHealthy ? 'healthy' : 'unhealthy';
    const disabledClass = isDisabled ? 'disabled' : '';
    const displayName = provider.customName || provider.accountName || provider.uuid;
    const shortUuid = getShortUuid(provider.uuid);
    const lastUsedText = formatProviderRelative(provider.lastUsed);
    const lastUsedTitle = formatProviderDateTime(provider.lastUsed);
    const lastCheckText = formatProviderRelative(provider.lastHealthCheckTime);
    const lastCheckTitle = formatProviderDateTime(provider.lastHealthCheckTime);
    const lastHealthCheckModel = provider.lastHealthCheckModel || '-';
    const toggleButtonText = isDisabled ? t('modal.provider.enabled') : t('modal.provider.disabled');
    const toggleButtonIcon = isDisabled ? 'fas fa-play' : 'fas fa-ban';
    const toggleButtonClass = isDisabled ? 'btn-success' : 'btn-warning';
    const selected = selectedProviderUuids.has(provider.uuid);
    const safeUuid = escapeHtml(provider.uuid);
    const isCheckingHealth = kiroHealthCheckingUuids.has(provider.uuid);
    const restoreButton = !isHealthy
        ? `
                    <button class="btn-small btn-info" onclick="window.resetSingleKiroProviderHealth('${safeUuid}', event)" title="${escapeHtml(t('modal.provider.resetSingleHealthTitle'))}">
                        <i class="fas fa-heart"></i>
                    </button>
        `
        : '';

    return `
        <div class="provider-item-detail kiro-table-item ${healthClass} ${disabledClass} ${selected ? 'selected' : ''}" data-uuid="${safeUuid}">
            <div class="kiro-table-row kiro-account-row" onclick="window.toggleProviderDetails('${safeUuid}')">
                <div class="kiro-cell kiro-cell-select" onclick="event.stopPropagation()">
                    <input type="checkbox"
                           class="kiro-row-checkbox"
                           value="${safeUuid}"
                           ${selected ? 'checked' : ''}
                           onchange="window.toggleKiroProviderSelection('${safeUuid}', this.checked)">
                </div>
                <div class="kiro-cell kiro-account-cell">
                    <div class="kiro-account-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                    <div class="kiro-account-subline" title="${safeUuid}">
                        <code>${escapeHtml(shortUuid)}</code>
                        ${provider.accountFingerprint ? `<span>${escapeHtml(provider.accountFingerprint)}</span>` : ''}
                    </div>
                </div>
                <div class="kiro-cell kiro-status-cell">
                    ${getKiroProviderBadges(provider)}
                    ${provider.lastErrorMessage ? `<div class="kiro-error-snippet" title="${escapeHtml(provider.lastErrorMessage)}">${escapeHtml(provider.lastErrorMessage)}</div>` : ''}
                </div>
                <div class="kiro-cell kiro-proxy-cell">
                    ${renderProviderProxySummary(provider)}
                </div>
                <div class="kiro-cell">
                    ${renderKiroUsageCell(provider)}
                </div>
                <div class="kiro-cell">
                    ${renderKiroActivityCell(provider, lastUsedText, lastUsedTitle, lastCheckText, lastCheckTitle, lastHealthCheckModel)}
                </div>
                <div class="kiro-cell kiro-actions-cell provider-actions-group" onclick="event.stopPropagation()">
                    <button class="btn-small ${toggleButtonClass}" onclick="window.toggleProviderStatus('${safeUuid}', event)" title="${escapeHtml(toggleButtonText)}">
                        <i class="${toggleButtonIcon}"></i>
                    </button>
                    <button class="btn-small btn-edit" onclick="window.editProvider('${safeUuid}', event)" title="${escapeHtml(t('modal.provider.edit'))}">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn-small btn-info btn-provider-health-check" onclick="window.performSingleHealthCheck('${safeUuid}', event)" title="${escapeHtml(t('modal.provider.healthCheckCurrentTitle'))}">
                        <i class="fas ${isCheckingHealth ? 'fa-spinner fa-spin' : 'fa-stethoscope'}"></i>
                    </button>
                    ${restoreButton}
                    <button class="btn-small btn-info" onclick="window.refreshSingleKiroUsage('${safeUuid}', event)" title="${escapeHtml(t('modal.provider.kiroConsole.forceRefreshUsageTitle'))}">
                        <i class="fas fa-chart-line"></i>
                    </button>
                    <button class="btn-small btn-refresh-uuid" onclick="window.refreshProviderUuid('${safeUuid}', event)" title="${escapeHtml(t('modal.provider.refreshUuid'))}">
                        <i class="fas fa-sync-alt"></i>
                    </button>
                    <button class="btn-small btn-delete" onclick="window.deleteProvider('${safeUuid}', event)" title="${escapeHtml(t('modal.provider.delete'))}">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="provider-item-content kiro-detail-panel" id="content-${safeUuid}">
                ${renderProviderConfig(provider)}
            </div>
        </div>
    `;
}

function renderKiroProviderTable(providers) {
    return `
        ${renderKiroUsageRefreshProgress()}
        ${renderKiroHealthCheckProgress()}
        <div class="kiro-provider-table">
            ${renderKiroTableHeader(providers)}
            <div class="kiro-table-body">
                ${providers.map(provider => renderKiroProviderRow(provider)).join('')}
            </div>
        </div>
    `;
}

function updateKiroSelectionUi() {
    if (currentProviderType !== 'claude-kiro-oauth') {
        return;
    }

    cleanSelectedProviderUuids();
    const container = document.getElementById('kiroBulkActionsContainer');
    if (container) {
        container.innerHTML = renderKiroBulkActionsBar();
    }

    const visibleRows = Array.from(document.querySelectorAll('.kiro-table-item[data-uuid]'));
    visibleRows.forEach(row => {
        const uuid = row.dataset.uuid;
        const selected = selectedProviderUuids.has(uuid);
        row.classList.toggle('selected', selected);
        const checkbox = row.querySelector('.kiro-row-checkbox');
        if (checkbox) {
            checkbox.checked = selected;
        }
    });

    const selectAll = document.querySelector('.kiro-select-all');
    if (selectAll) {
        const visibleUuids = visibleRows.map(row => row.dataset.uuid).filter(Boolean);
        const checkedCount = visibleUuids.filter(uuid => selectedProviderUuids.has(uuid)).length;
        selectAll.checked = visibleUuids.length > 0 && checkedCount === visibleUuids.length;
        selectAll.indeterminate = checkedCount > 0 && checkedCount < visibleUuids.length;
    }
}

function toggleKiroProviderSelection(uuid, checked) {
    if (checked) {
        selectedProviderUuids.add(uuid);
    } else {
        selectedProviderUuids.delete(uuid);
    }
    updateKiroSelectionUi();
}

function toggleKiroProviderSelectAll(checked) {
    const visibleRows = Array.from(document.querySelectorAll('.kiro-table-item[data-uuid]'));
    visibleRows.forEach(row => {
        const uuid = row.dataset.uuid;
        if (!uuid) return;
        if (checked) {
            selectedProviderUuids.add(uuid);
        } else {
            selectedProviderUuids.delete(uuid);
        }
    });
    updateKiroSelectionUi();
}

function clearKiroProviderSelection() {
    selectedProviderUuids.clear();
    updateKiroSelectionUi();
}

function showKiroBatchImportFromProviderConsole() {
    if (typeof window.showKiroBatchImportModal === 'function') {
        window.showKiroBatchImportModal();
        return;
    }
    showToast(t('common.error'), t('modal.provider.kiroConsole.importUnavailable'), 'error');
}

function showKiroAwsImportFromProviderConsole() {
    if (typeof window.showKiroAwsImportModal === 'function') {
        window.showKiroAwsImportModal();
        return;
    }
    showToast(t('common.error'), t('modal.provider.kiroConsole.importUnavailable'), 'error');
}

function applyKiroUsageData(data) {
    const nextMap = new Map();
    const instances = Array.isArray(data?.instances) ? data.instances : [];
    instances.forEach(instance => {
        if (instance?.uuid) {
            nextMap.set(instance.uuid, instance);
        }
    });
    kiroUsageByUuid = nextMap;
    kiroUsageLoadedAt = data?.timestamp || data?.serverTime || new Date().toISOString();
}

function rerenderKiroProviderTable() {
    if (currentProviderType !== 'claude-kiro-oauth') return;
    const providerList = document.getElementById('providerList');
    if (providerList) {
        providerList.innerHTML = renderProviderListPaginated(getFilteredProviders(), currentPage);
    }
    updateKiroSelectionUi();
    syncKiroRecoveryCountdownTimer();
}

async function refreshKiroUsage(forceRefresh = false, targetUuids = null) {
    if (currentProviderType !== 'claude-kiro-oauth') return;

    const endpoint = '/usage/claude-kiro-oauth';
    try {
        if (forceRefresh) {
            const targets = getKiroUsageRefreshTargets(targetUuids);
            if (targets.length === 0) return;

            const runId = ++kiroUsageRefreshRunId;
            let successCount = 0;
            let failCount = 0;
            kiroUsageRefreshingUuids = new Set(targets.map(provider => provider.uuid));
            kiroUsageRefreshProgress = {
                completed: 0,
                total: targets.length,
                currentName: ''
            };
            rerenderKiroProviderTable();

            for (const provider of targets) {
                if (runId !== kiroUsageRefreshRunId) return;
                const providerName = getKiroUsageProviderName(provider);
                kiroUsageRefreshProgress = {
                    ...kiroUsageRefreshProgress,
                    currentName: providerName
                };
                rerenderKiroProviderTable();

                try {
                    const data = await window.apiClient.get(endpoint, {
                        refresh: 'true',
                        uuids: provider.uuid
                    });
                    const instance = Array.isArray(data?.instances)
                        ? data.instances.find(item => item.uuid === provider.uuid)
                        : null;

                    if (instance) {
                        kiroUsageByUuid.set(provider.uuid, instance);
                        if (instance.success) {
                            successCount++;
                        } else {
                            failCount++;
                        }
                    } else {
                        failCount++;
                        kiroUsageByUuid.set(provider.uuid, {
                            uuid: provider.uuid,
                            name: providerName,
                            success: false,
                            usage: null,
                            error: t('modal.provider.kiroConsole.usage.missingResult')
                        });
                    }
                    kiroUsageLoadedAt = data?.timestamp || data?.serverTime || new Date().toISOString();
                } catch (error) {
                    failCount++;
                    kiroUsageByUuid.set(provider.uuid, {
                        uuid: provider.uuid,
                        name: providerName,
                        success: false,
                        usage: null,
                        error: error.message
                    });
                } finally {
                    kiroUsageRefreshingUuids.delete(provider.uuid);
                    kiroUsageRefreshProgress = {
                        ...kiroUsageRefreshProgress,
                        completed: kiroUsageRefreshProgress.completed + 1
                    };
                    rerenderKiroProviderTable();
                }
            }

            kiroUsageRefreshProgress = null;
            rerenderKiroProviderTable();
            showToast(
                failCount > 0 ? t('common.warning') : t('common.success'),
                t('modal.provider.kiroConsole.usage.refreshDone', { success: successCount, fail: failCount }),
                failCount > 0 ? 'warning' : 'success'
            );
            return;
        }

        kiroUsageLoading = true;
        rerenderKiroProviderTable();

        const uuidFilter = Array.isArray(targetUuids) && targetUuids.length > 0
            ? new Set(targetUuids)
            : null;
        const params = { cacheOnly: 'true' };
        if (uuidFilter) {
            params.uuids = Array.from(uuidFilter).join(',');
        }
        const data = await window.apiClient.get(endpoint, params);

        if (uuidFilter) {
            const instances = Array.isArray(data?.instances) ? data.instances : [];
            instances
                .filter(instance => uuidFilter.has(instance.uuid))
                .forEach(instance => kiroUsageByUuid.set(instance.uuid, instance));
            kiroUsageLoadedAt = data?.timestamp || data?.serverTime || new Date().toISOString();
        } else {
            applyKiroUsageData(data);
        }

    } catch (error) {
        console.error('Failed to refresh Kiro usage:', error);
        showToast(t('common.error'), t('common.refresh.failed') + ': ' + error.message, 'error');
    } finally {
        kiroUsageLoading = false;
        rerenderKiroProviderTable();
    }
}

async function refreshSelectedKiroUsage() {
    const selected = getKiroSelectedProviders();
    if (selected.length === 0) {
        showToast(t('common.info'), t('modal.provider.kiroConsole.noSelection'), 'info');
        return;
    }
    await refreshKiroUsage(true, selected.map(provider => provider.uuid));
}

async function refreshSingleKiroUsage(uuid, event) {
    if (event) event.stopPropagation();
    await refreshKiroUsage(true, [uuid]);
}

async function performKiroHealthChecks(providerType, targets, options = {}) {
    if (providerType !== 'claude-kiro-oauth') return null;

    const providers = Array.isArray(targets) ? targets.filter(provider => provider?.uuid) : [];
    if (providers.length === 0) {
        showToast(
            t('common.info'),
            options.emptyMessageKey ? t(options.emptyMessageKey) : t('modal.provider.kiroConsole.noSelection'),
            'info'
        );
        return null;
    }

    const runId = ++kiroHealthCheckRunId;
    let successCount = 0;
    let failCount = 0;
    let rateLimitCount = 0;
    let skippedCount = 0;

    kiroHealthCheckingUuids = new Set(providers.map(provider => provider.uuid));
    kiroHealthCheckProgress = {
        completed: 0,
        total: providers.length,
        currentName: ''
    };
    rerenderKiroProviderTable();

    for (const provider of providers) {
        if (runId !== kiroHealthCheckRunId) return null;

        const providerName = getKiroHealthCheckProviderName(provider);
        kiroHealthCheckProgress = {
            ...kiroHealthCheckProgress,
            currentName: providerName
        };
        rerenderKiroProviderTable();

        try {
            if (provider.isDisabled && options.includeDisabled !== true) {
                skippedCount++;
                continue;
            }

            const response = await window.apiClient.post(
                `/providers/${encodeURIComponent(providerType)}/${provider.uuid}/health-check`,
                {}
            );

            if (response.success && response.healthy) {
                successCount++;
            } else {
                failCount++;
                if (response.isRateLimitError) {
                    rateLimitCount++;
                }
            }
        } catch (error) {
            console.error('Kiro health check failed:', provider.uuid, error);
            failCount++;
        } finally {
            kiroHealthCheckingUuids.delete(provider.uuid);
            kiroHealthCheckProgress = {
                ...kiroHealthCheckProgress,
                completed: kiroHealthCheckProgress.completed + 1
            };
            rerenderKiroProviderTable();
        }
    }

    kiroHealthCheckProgress = null;
    rerenderKiroProviderTable();

    await window.apiClient.post('/reload-config');
    await refreshProviderConfig(providerType);

    const messageKey = options.mode === 'all'
        ? 'modal.provider.healthCheckAll.complete'
        : 'modal.provider.kiroConsole.selectedHealthCheckDone';
    const message = options.mode === 'all'
        ? t(messageKey, { success: successCount, fail: failCount, rateLimited: rateLimitCount, skipped: skippedCount })
        : t(messageKey, { success: successCount, fail: failCount });

    showToast(
        failCount > 0 ? t('common.warning') : t('common.success'),
        message,
        failCount > 0 ? 'warning' : 'success'
    );

    return { successCount, failCount, rateLimitCount, skippedCount };
}

async function performSelectedKiroHealthCheck() {
    const selected = getKiroSelectedProviders();
    if (selected.length === 0) {
        showToast(t('common.info'), t('modal.provider.kiroConsole.noSelection'), 'info');
        return;
    }

    if (!confirm(t('modal.provider.kiroConsole.selectedHealthCheckConfirm', { count: selected.length }))) {
        return;
    }

    showToast(t('common.info'), t('modal.provider.kiroConsole.selectedHealthChecking', { count: selected.length }), 'info');
    await performKiroHealthChecks(currentProviderType, selected, { mode: 'selected' });
}

async function resetKiroProvidersHealth(providers, options = {}) {
    const targets = Array.isArray(providers) ? providers.filter(provider => provider?.uuid) : [];
    if (targets.length === 0) {
        showToast(t('common.info'), t('modal.provider.kiroConsole.noSelection'), 'info');
        return;
    }

    if (options.confirmKey && !confirm(t(options.confirmKey, { count: targets.length }))) {
        return;
    }

    let successCount = 0;
    let failCount = 0;
    for (const provider of targets) {
        try {
            const response = await window.apiClient.post(
                `/providers/${encodeURIComponent(currentProviderType)}/${provider.uuid}/reset-health`,
                {}
            );
            if (response.success) {
                successCount++;
            } else {
                failCount++;
            }
        } catch (error) {
            console.error('Selected Kiro reset health failed:', provider.uuid, error);
            failCount++;
        }
    }

    await window.apiClient.post('/reload-config');
    await refreshProviderConfig(currentProviderType);
    showToast(
        failCount > 0 ? t('common.warning') : t('common.success'),
        t('modal.provider.kiroConsole.selectedResetHealthDone', { success: successCount, fail: failCount }),
        failCount > 0 ? 'warning' : 'success'
    );
}

async function resetSelectedKiroProvidersHealth() {
    const selected = getKiroSelectedProviders();
    if (selected.length === 0) {
        showToast(t('common.info'), t('modal.provider.kiroConsole.noSelection'), 'info');
        return;
    }
    await resetKiroProvidersHealth(selected, {
        confirmKey: 'modal.provider.kiroConsole.selectedResetHealthConfirm'
    });
}

async function resetSingleKiroProviderHealth(uuid, event) {
    if (event) event.stopPropagation();
    const provider = currentProviders.find(item => item.uuid === uuid);
    if (!provider) {
        showToast(t('common.error'), t('modal.provider.resetHealth.failed'), 'error');
        return;
    }
    await resetKiroProvidersHealth([provider]);
}

async function setSelectedKiroProvidersDisabled(disabled) {
    const selected = getKiroSelectedProviders();
    if (selected.length === 0) {
        showToast(t('common.info'), t('modal.provider.kiroConsole.noSelection'), 'info');
        return;
    }

    const confirmKey = disabled
        ? 'modal.provider.kiroConsole.selectedDisableConfirm'
        : 'modal.provider.kiroConsole.selectedEnableConfirm';
    if (!confirm(t(confirmKey, { count: selected.length }))) {
        return;
    }

    let successCount = 0;
    let failCount = 0;
    for (const provider of selected) {
        if ((provider.isDisabled === true) === disabled) {
            successCount++;
            continue;
        }
        try {
            const action = disabled ? 'disable' : 'enable';
            await window.apiClient.post(
                `/providers/${encodeURIComponent(currentProviderType)}/${provider.uuid}/${action}`,
                { action }
            );
            successCount++;
        } catch (error) {
            console.error('Selected Kiro status update failed:', provider.uuid, error);
            failCount++;
        }
    }

    await window.apiClient.post('/reload-config');
    await refreshProviderConfig(currentProviderType);
    showToast(
        failCount > 0 ? t('common.warning') : t('common.success'),
        t('modal.provider.kiroConsole.selectedStatusDone', { success: successCount, fail: failCount }),
        failCount > 0 ? 'warning' : 'success'
    );
}

async function deleteSelectedKiroProviders() {
    const selected = getKiroSelectedProviders();
    if (selected.length === 0) {
        showToast(t('common.info'), t('modal.provider.kiroConsole.noSelection'), 'info');
        return;
    }

    if (!confirm(t('modal.provider.kiroConsole.selectedDeleteConfirm', { count: selected.length }))) {
        return;
    }

    let successCount = 0;
    let failCount = 0;
    for (const provider of selected) {
        try {
            await window.apiClient.delete(`/providers/${encodeURIComponent(currentProviderType)}/${provider.uuid}`);
            successCount++;
            selectedProviderUuids.delete(provider.uuid);
        } catch (error) {
            console.error('Selected Kiro delete failed:', provider.uuid, error);
            failCount++;
        }
    }

    await window.apiClient.post('/reload-config');
    await refreshProviderConfig(currentProviderType);
    showToast(
        failCount > 0 ? t('common.warning') : t('common.success'),
        t('modal.provider.kiroConsole.selectedDeleteDone', { success: successCount, fail: failCount }),
        failCount > 0 ? 'warning' : 'success'
    );
}

function getDownloadFilename(response, fallbackName) {
    const disposition = response.headers.get('Content-Disposition') || '';
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) {
        return decodeURIComponent(utf8Match[1].replace(/"/g, ''));
    }

    const match = disposition.match(/filename="?([^"]+)"?/i);
    return match ? match[1] : fallbackName;
}

async function downloadResponseBlob(response, fallbackName) {
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = getDownloadFilename(response, fallbackName);
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
}

async function exportKiroRefreshTokens(providerType, healthyOnly = false) {
    try {
        const params = new URLSearchParams({
            healthyOnly: healthyOnly ? 'true' : 'false',
            format: 'txt'
        });
        const response = await fetch(`/api/providers/${encodeURIComponent(providerType)}/export-refresh-tokens?${params.toString()}`, {
            method: 'GET',
            headers: window.apiClient ? window.apiClient.getAuthHeaders() : {}
        });

        if (!response.ok) {
            let message = `HTTP ${response.status}`;
            try {
                const errorData = await response.json();
                message = errorData.error?.message || message;
            } catch {}
            throw new Error(message);
        }

        const tokenCount = Number(response.headers.get('X-Token-Count') || 0);
        await downloadResponseBlob(response, healthyOnly ? 'kiro-refresh-tokens-healthy.txt' : 'kiro-refresh-tokens-all.txt');

        const successKey = tokenCount > 0 ? 'modal.provider.exportRt.success' : 'modal.provider.exportRt.noTokens';
        showToast(t('common.success'), t(successKey, { count: tokenCount }), 'success');
    } catch (error) {
        console.error('Export Kiro refresh tokens failed:', error);
        showToast(t('common.error'), t('modal.provider.exportRt.failed') + ': ' + error.message, 'error');
    }
}

async function updateKiroStableNames(providerType) {
    if (!confirm(t('modal.provider.updateKiroNamesConfirm', { type: providerType }))) {
        return;
    }

    try {
        const result = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/update-stable-names`,
            { force: true }
        );
        await window.apiClient.post('/reload-config');
        await refreshProviderConfig(providerType);
        showToast(t('common.success'), t('modal.provider.updateKiroNames.success', result), 'success');
    } catch (error) {
        console.error('Update Kiro stable names failed:', error);
        showToast(t('common.error'), t('modal.provider.updateKiroNames.failed') + ': ' + error.message, 'error');
    }
}

async function autoAssignProviderProxies(providerType) {
    if (!confirm(t('proxies.autoAssignConfirm', { type: providerType }))) {
        return;
    }

    try {
        const result = await window.apiClient.post('/proxies/auto-assign', {
            providerTypes: [providerType]
        });
        await window.apiClient.post('/reload-config');
        cachedProxyOptions = [];
        await loadProxyOptions(true);
        await refreshProviderConfig(providerType);
        showToast(t('common.success'), t('proxies.autoAssignResult', result), 'success');
    } catch (error) {
        console.error('Auto-assign provider proxies failed:', error);
        showToast(t('common.error'), error.message, 'error');
    }
}

function renderProviderActionButton({ className = 'btn-info', onClick, icon, labelKey, titleKey = null }) {
    const title = titleKey ? ` title="${escapeHtml(t(titleKey))}"` : '';
    return `
        <button class="btn ${className} provider-action-text-btn" onclick="${onClick}"${title}>
            <i class="${icon}"></i>
            <span data-i18n="${labelKey}">${escapeHtml(t(labelKey))}</span>
        </button>
    `;
}

function renderProviderActionRow(labelKey, buttonsHtml) {
    return `
        <div class="provider-action-row">
            <span class="provider-action-row-label" data-i18n="${labelKey}">${escapeHtml(t(labelKey))}</span>
            <div class="provider-action-row-buttons">
                ${buttonsHtml}
            </div>
        </div>
    `;
}

function renderDefaultProviderSummaryActions(providerType) {
    return `
        <div class="provider-summary-actions">
            ${renderProviderActionButton({
                className: 'btn-success',
                onClick: `window.showAddProviderForm('${providerType}')`,
                icon: 'fas fa-plus',
                labelKey: 'modal.provider.add'
            })}
            ${renderProviderActionButton({
                className: 'btn-warning',
                onClick: `window.resetAllProvidersHealth('${providerType}')`,
                icon: 'fas fa-heartbeat',
                labelKey: 'modal.provider.resetHealth'
            })}
            ${renderProviderActionButton({
                className: 'btn-info',
                onClick: `window.performHealthCheck('${providerType}')`,
                icon: 'fas fa-stethoscope',
                labelKey: 'modal.provider.healthCheck'
            })}
            ${renderProviderActionButton({
                className: 'btn-secondary',
                onClick: `window.refreshUnhealthyUuids('${providerType}')`,
                icon: 'fas fa-sync-alt',
                labelKey: 'modal.provider.refreshUnhealthyUuidsBtn'
            })}
            ${renderProviderActionButton({
                className: 'btn-danger',
                onClick: `window.deleteUnhealthyProviders('${providerType}')`,
                icon: 'fas fa-trash-alt',
                labelKey: 'modal.provider.deleteUnhealthyBtn'
            })}
        </div>
    `;
}

function renderKiroProviderSummaryActions(providerType) {
    return `
        <div class="provider-summary-actions provider-summary-actions-grouped">
            ${renderProviderActionRow('modal.provider.actions.account', `
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.showAddProviderForm('${providerType}')`,
                    icon: 'fas fa-plus',
                    labelKey: 'modal.provider.add'
                })}
            `)}
            ${renderProviderActionRow('modal.provider.actions.proxyName', `
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.autoAssignProviderProxies('${providerType}')`,
                    icon: 'fas fa-random',
                    labelKey: 'proxies.autoAssign',
                    titleKey: 'proxies.autoAssignTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.updateKiroStableNames('${providerType}')`,
                    icon: 'fas fa-signature',
                    labelKey: 'modal.provider.updateKiroNames',
                    titleKey: 'modal.provider.updateKiroNamesTitle'
                })}
            `)}
            ${renderProviderActionRow('modal.provider.actions.health', `
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.resetAllProvidersHealth('${providerType}')`,
                    icon: 'fas fa-heartbeat',
                    labelKey: 'modal.provider.resetHealth'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.performHealthCheck('${providerType}')`,
                    icon: 'fas fa-stethoscope',
                    labelKey: 'modal.provider.healthCheck'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.performHealthCheckAll('${providerType}')`,
                    icon: 'fas fa-heartbeat',
                    labelKey: 'modal.provider.healthCheckAll',
                    titleKey: 'modal.provider.healthCheckAllTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.performHealthCheckAllIncludingDisabled('${providerType}')`,
                    icon: 'fas fa-universal-access',
                    labelKey: 'modal.provider.healthCheckAllIncludingDisabled',
                    titleKey: 'modal.provider.healthCheckAllIncludingDisabledTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.refreshUnhealthyUuids('${providerType}')`,
                    icon: 'fas fa-sync-alt',
                    labelKey: 'modal.provider.refreshUnhealthyUuidsBtn'
                })}
            `)}
            ${renderProviderActionRow('modal.provider.actions.exportCleanup', `
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.exportKiroRefreshTokens('${providerType}', false)`,
                    icon: 'fas fa-download',
                    labelKey: 'modal.provider.exportRtAll',
                    titleKey: 'modal.provider.exportRtAllTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-info',
                    onClick: `window.exportKiroRefreshTokens('${providerType}', true)`,
                    icon: 'fas fa-file-medical-alt',
                    labelKey: 'modal.provider.exportRtHealthy',
                    titleKey: 'modal.provider.exportRtHealthyTitle'
                })}
                ${renderProviderActionButton({
                    className: 'btn-danger',
                    onClick: `window.deleteUnhealthyProviders('${providerType}')`,
                    icon: 'fas fa-trash-alt',
                    labelKey: 'modal.provider.deleteUnhealthyBtn'
                })}
            `)}
        </div>
    `;
}

/**
 * 显示提供商管理模态框
 * @param {Object} data - 提供商数据
 * @param {string} initialSearchTerm - 初始搜索词
 */
function showProviderManagerModal(data, initialSearchTerm = '') {
    const { providerType, providers, totalCount, healthyCount } = data;
    const isKiroProvider = providerType === 'claude-kiro-oauth';
    stopKiroRecoveryCountdownTimer();
    
    // 保存当前数据用于分页
    currentProviders = providers;
    currentProviderType = providerType;
    currentPage = 1;
    nodeSearchTerm = initialSearchTerm;
    cachedModels = [];
    if (isKiroProvider) {
        selectedProviderUuids.clear();
        resetKiroUsageState();
    }
    loadProxyOptions(true).then(() => {
        if (document.querySelector(`.provider-modal[data-provider-type="${providerType}"]`)) {
            window.goToProviderPage(currentPage);
        }
    });
    
    // 移除已存在的模态框
    const existingModal = document.querySelector('.provider-modal');
    if (existingModal) {
        // 清理事件监听器
        if (existingModal.cleanup) {
            existingModal.cleanup();
        }
        existingModal.remove();
    }
    
    cleanSelectedProviderUuids();
    const totalPages = Math.ceil(providers.length / PROVIDERS_PER_PAGE);
    
    // 创建模态框
    const modal = document.createElement('div');
    modal.className = 'provider-modal';
    modal.setAttribute('data-provider-type', providerType);
    modal.innerHTML = `
        <div class="provider-modal-content ${isKiroProvider ? 'kiro-console-modal' : ''}">
            <div class="provider-modal-header">
                <h3 data-i18n="modal.provider.manage" data-i18n-params='{"type":"${providerType}"}'><i class="fas fa-cogs"></i> 管理 ${providerType} 提供商配置</h3>
                <button class="modal-close" onclick="window.closeProviderModal(this)">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="provider-modal-body">
                <div class="provider-summary ${isKiroProvider ? 'kiro-summary' : ''}">
                    <div class="provider-summary-item">
                        <span class="label" data-i18n="modal.provider.totalAccounts">总账户数:</span>
                        <span class="value">${totalCount}</span>
                    </div>
                    <div class="provider-summary-item">
                        <span class="label" data-i18n="modal.provider.healthyAccounts">健康账户:</span>
                        <span class="value">${healthyCount}</span>
                    </div>
                    ${isKiroProvider ? '' : renderDefaultProviderSummaryActions(providerType)}
                </div>

                ${isKiroProvider ? `
                    <div class="kiro-console-summary">
                        ${renderKiroStatsGrid(providers)}
                        ${renderKiroConsoleActions(providerType)}
                    </div>
                    <div id="kiroBulkActionsContainer">${renderKiroBulkActionsBar()}</div>
                ` : ''}

                <div class="provider-nodes-toolbar" style="margin-bottom: 15px; display: flex; gap: 10px; align-items: center;">
                    <div class="search-input-wrapper" style="position: relative; flex: 1;">
                        <i class="fas fa-search" style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-tertiary);"></i>
                        <input type="text" id="nodeSearchInput" 
                               value="${escapeHtml(nodeSearchTerm)}"
                               placeholder="${t('modal.provider.searchNodesPlaceholder') || '搜索节点名称、UUID 或配置内容...'}" 
                               style="width: 100%; padding: 10px 12px 10px 35px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary);">
                    </div>
                    <div class="view-mode-toggle" style="display: flex; background: var(--bg-secondary); padding: 4px; border-radius: 8px; border: 1px solid var(--border-color);">
                        <button class="view-mode-btn ${currentViewMode === 'list' ? 'active' : ''}" data-mode="list" title="${t('common.view.list') || '列表视图'}" style="border: none; background: ${currentViewMode === 'list' ? 'var(--primary-color)' : 'transparent'}; color: ${currentViewMode === 'list' ? '#fff' : 'var(--text-secondary)'}; padding: 6px 10px; border-radius: 6px; cursor: pointer; transition: all 0.2s;">
                            <i class="fas fa-list"></i>
                        </button>
                        <button class="view-mode-btn ${currentViewMode === 'card' ? 'active' : ''}" data-mode="card" title="${t('common.view.card') || '卡片视图'}" style="border: none; background: ${currentViewMode === 'card' ? 'var(--primary-color)' : 'transparent'}; color: ${currentViewMode === 'card' ? '#fff' : 'var(--text-secondary)'}; padding: 6px 10px; border-radius: 6px; cursor: pointer; transition: all 0.2s;">
                            <i class="fas fa-th-large"></i>
                        </button>
                    </div>
                </div>
                
                <div id="paginationTop"></div>
                <div class="provider-list ${isKiroProvider ? 'kiro-provider-list' : ''}" id="providerList"></div>
                <div id="paginationBottom"></div>
            </div>
        </div>
    `;
    
    // 添加到页面
    document.body.appendChild(modal);
    
    // 添加模态框事件监听
    addModalEventListeners(modal);
    
    // 初始渲染
    window.goToProviderPage(1);
    if (isKiroProvider) {
        refreshKiroUsage(false);
        syncKiroRecoveryCountdownTimer();
    }
}

/**
 * 渲染分页控件
 * @param {number} currentPage - 当前页码
 * @param {number} totalPages - 总页数
 * @param {number} totalItems - 总条目数
 * @param {string} position - 位置标识 (top/bottom)
 * @returns {string} HTML字符串
 */
function renderPagination(page, totalPages, totalItems, position = 'top') {
    if (totalPages <= 1 || currentViewMode === 'card' || currentProviderType === 'claude-kiro-oauth') {
        return `<div class="pagination-container" data-position="${position}"></div>`;
    }
    
    const startItem = (page - 1) * PROVIDERS_PER_PAGE + 1;
    const endItem = Math.min(page * PROVIDERS_PER_PAGE, totalItems);
    
    let pageButtons = '';
    const maxVisiblePages = 5;
    let startPage = Math.max(1, page - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    
    if (endPage - startPage + 1 < maxVisiblePages) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }
    
    if (startPage > 1) {
        pageButtons += `<button class="page-btn" onclick="window.goToProviderPage(1)">1</button>`;
        if (startPage > 2) {
            pageButtons += `<span class="page-ellipsis">...</span>`;
        }
    }
    
    for (let i = startPage; i <= endPage; i++) {
        pageButtons += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="window.goToProviderPage(${i})">${i}</button>`;
    }
    
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            pageButtons += `<span class="page-ellipsis">...</span>`;
        }
        pageButtons += `<button class="page-btn" onclick="window.goToProviderPage(${totalPages})">${totalPages}</button>`;
    }
    
    return `
        <div class="pagination-container ${position}" data-position="${position}">
            <div class="pagination-info">
                <span data-i18n="pagination.showing" data-i18n-params='{"start":"${startItem}","end":"${endItem}","total":"${totalItems}"}'>显示 ${startItem}-${endItem} / 共 ${totalItems} 条</span>
            </div>
            <div class="pagination-controls">
                <button class="page-btn nav-btn" onclick="window.goToProviderPage(${page - 1})" ${page <= 1 ? 'disabled' : ''}>
                    <i class="fas fa-chevron-left"></i>
                </button>
                ${pageButtons}
                <button class="page-btn nav-btn" onclick="window.goToProviderPage(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>
                    <i class="fas fa-chevron-right"></i>
                </button>
            </div>
            <div class="pagination-jump">
                <span data-i18n="pagination.jumpTo">跳转到</span>
                <input type="number" min="1" max="${totalPages}" value="${page}"
                       onkeypress="if(event.key==='Enter')window.goToProviderPage(parseInt(this.value))"
                       class="page-jump-input">
                <span data-i18n="pagination.page">页</span>
            </div>
        </div>
    `;
}

/**
 * 获取过滤后的提供商列表
 */
function getFilteredProviders() {
    if (!nodeSearchTerm) return currentProviders;
    const term = nodeSearchTerm.toLowerCase().trim();
    return currentProviders.filter(p => {
        // 搜索字段：自定义名称、UUID、API Key、Base URL、OAuth 路径等
        const searchFields = [
            p.customName,
            p.uuid,
            p.OPENAI_API_KEY,
            p.OPENAI_BASE_URL,
            p.CLAUDE_API_KEY,
            p.CLAUDE_BASE_URL,
            p.GEMINI_OAUTH_CREDS_FILE_PATH,
            p.KIRO_OAUTH_CREDS_FILE_PATH,
            p.QWEN_OAUTH_CREDS_FILE_PATH,
            p.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH,
            p.IFLOW_OAUTH_CREDS_FILE_PATH,
            p.CODEX_OAUTH_CREDS_FILE_PATH,
            p.GROK_COOKIE_TOKEN,
            p.FORWARD_API_KEY,
            p.checkModelName
        ];
        
        return searchFields.some(field => 
            field && String(field).toLowerCase().includes(term)
        );
    });
}

/**
 * 跳转到指定页
 * @param {number} page - 目标页码
 */
function goToProviderPage(page) {
    const filteredProviders = getFilteredProviders();
    const totalPages = Math.ceil(filteredProviders.length / PROVIDERS_PER_PAGE);
    cleanSelectedProviderUuids();
    
    // 验证页码范围
    if (page < 1) page = 1;
    if (page > totalPages && totalPages > 0) page = totalPages;
    if (totalPages === 0) page = 1;
    
    currentPage = page;
    
    // 更新提供商列表
    const providerList = document.getElementById('providerList');
    if (providerList) {
        providerList.innerHTML = renderProviderListPaginated(filteredProviders, page);
    }

    updateKiroSelectionUi();
    
    // 更新分页控件
    const paginationTop = document.getElementById('paginationTop');
    const paginationBottom = document.getElementById('paginationBottom');
    
    if (paginationTop) {
        paginationTop.innerHTML = totalPages > 1 ? renderPagination(page, totalPages, filteredProviders.length) : '';
    }
    if (paginationBottom) {
        paginationBottom.innerHTML = totalPages > 1 ? renderPagination(page, totalPages, filteredProviders.length, 'bottom') : '';
    }
    
    // 滚动到顶部
    const modalBody = document.querySelector('.provider-modal-body');
    if (modalBody) {
        modalBody.scrollTop = 0;
    }
    
    // 为当前页的提供商加载模型列表
    const startIndex = (page - 1) * PROVIDERS_PER_PAGE;
    const endIndex = Math.min(startIndex + PROVIDERS_PER_PAGE, filteredProviders.length);
    const pageProviders = filteredProviders.slice(startIndex, endIndex);
    
    // 如果已缓存模型列表，直接使用
    if (currentProviderType === 'claude-kiro-oauth') {
        syncKiroRecoveryCountdownTimer();
        return;
    }

    if (!usesManagedModelList(currentProviderType) && cachedModels.length > 0) {
        pageProviders.forEach(provider => {
            renderNotSupportedModelsSelector(provider.uuid, cachedModels, provider.notSupportedModels || []);
        });
    } else if (!usesManagedModelList(currentProviderType)) {
        loadModelsForProviderType(currentProviderType, pageProviders);
    }
}

/**
 * 渲染分页后的提供商列表
 * @param {Array} providers - 提供商数组
 * @param {number} page - 当前页码
 * @returns {string} HTML字符串
 */
function renderProviderListPaginated(providers, page) {
    if (providers.length === 0) {
        return `
            <div class="no-providers">
                <i class="fas fa-search" style="font-size: 2rem; opacity: 0.3; display: block; margin-bottom: 1rem;"></i>
                <p>${t('common.noResults') || '没有找到匹配的节点'}</p>
            </div>
        `;
    }

    // 如果是卡片模式，显示所有节点，不分页
    if (currentProviderType === 'claude-kiro-oauth' || currentViewMode === 'card') {
        return renderProviderList(providers);
    }

    const startIndex = (page - 1) * PROVIDERS_PER_PAGE;
    const endIndex = Math.min(startIndex + PROVIDERS_PER_PAGE, providers.length);
    const pageProviders = providers.slice(startIndex, endIndex);
    
    return renderProviderList(pageProviders);
}

/**
 * 为提供商类型加载模型列表（优化：只调用一次API，并缓存结果）
 * @param {string} providerType - 提供商类型
 * @param {Array} providers - 提供商列表
 */
async function loadModelsForProviderType(providerType, providers) {
    try {
        if (usesManagedModelList(providerType)) {
            return;
        }

        // 如果已有缓存，直接使用
        if (cachedModels.length > 0) {
            providers.forEach(provider => {
                renderNotSupportedModelsSelector(provider.uuid, cachedModels, provider.notSupportedModels || []);
            });
            return;
        }
        
        // 只调用一次API获取模型列表
        const response = await window.apiClient.get(`/provider-models/${encodeURIComponent(providerType)}`);
        const models = response.models || [];
        
        // 缓存模型列表
        cachedModels = models;
        
        // 为每个提供商渲染模型选择器
        providers.forEach(provider => {
            renderNotSupportedModelsSelector(provider.uuid, models, provider.notSupportedModels || []);
        });
    } catch (error) {
        console.error('Failed to load models for provider type:', error);
        // 如果加载失败，为每个提供商显示错误信息
        providers.forEach(provider => {
            const container = document.querySelector(`.not-supported-models-container[data-uuid="${provider.uuid}"]`);
            if (container) {
                container.innerHTML = `<div class="error-message">${t('common.error')}: 加载模型列表失败</div>`;
            }
        });
    }
}

/**
 * 为模态框添加事件监听器
 * @param {HTMLElement} modal - 模态框元素
 */
function addModalEventListeners(modal) {
    // ESC键关闭模态框
    const handleEscKey = (event) => {
        if (event.key === 'Escape') {
            modal.cleanup?.();
            modal.remove();
        }
    };
    
    // 点击背景关闭模态框
    const handleBackgroundClick = (event) => {
        if (event.target === modal) {
            // 检查是否有正在编辑的节点
            const editingProvider = modal.querySelector('.provider-item-detail.editing, .provider-item-card.editing');
            if (editingProvider) {
                // showToast(t('common.warning'), '请先保存或取消编辑操作', 'warning');
                return;
            }
            // 检查是否有正在新增的表单
            const addForm = modal.querySelector('.add-provider-form');
            if (addForm) {
                // showToast(t('common.warning'), '请先保存或取消添加操作', 'warning');
                return;
            }
            modal.cleanup?.();
            modal.remove();
        }
    };
    
    // 防止模态框内容区域点击时关闭模态框
    const modalContent = modal.querySelector('.provider-modal-content');
    const handleContentClick = (event) => {
        event.stopPropagation();
    };
    
    // 密码切换按钮事件处理
    const handlePasswordToggleClick = (event) => {
        const button = event.target.closest('.password-toggle');
        if (button) {
            event.preventDefault();
            event.stopPropagation();
            handleProviderPasswordToggle(button);
        }
    };
    
    // 上传按钮事件处理
    const handleUploadButtonClick = (event) => {
        const button = event.target.closest('.upload-btn');
        if (button) {
            event.preventDefault();
            event.stopPropagation();
            const targetInputId = button.getAttribute('data-target');
            const providerType = modal.getAttribute('data-provider-type');
            if (targetInputId && window.fileUploadHandler) {
                window.fileUploadHandler.handleFileUpload(button, targetInputId, providerType);
            }
        }
    };

    // 节点搜索事件处理
    const searchInput = modal.querySelector('#nodeSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            nodeSearchTerm = e.target.value;
            window.goToProviderPage(1); // 搜索时重置回第一页
        });
    }

    // 视图模式切换事件处理
    const viewModeBtns = modal.querySelectorAll('.view-mode-btn');
    viewModeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (mode === currentViewMode) return;

            currentViewMode = mode;
            localStorage.setItem('providerViewMode', mode);

            // 更新按钮状态
            viewModeBtns.forEach(b => {
                const isActive = b.dataset.mode === mode;
                b.classList.toggle('active', isActive);
                b.style.background = isActive ? 'var(--primary-color)' : 'transparent';
                b.style.color = isActive ? '#fff' : 'var(--text-secondary)';
            });

            // 重新渲染当前页
            window.goToProviderPage(currentPage);
        });
    });
    
    // 添加事件监听器
    document.addEventListener('keydown', handleEscKey);
    modal.addEventListener('click', handleBackgroundClick);
    if (modalContent) {
        modalContent.addEventListener('click', handleContentClick);
        modalContent.addEventListener('click', handlePasswordToggleClick);
        modalContent.addEventListener('click', handleUploadButtonClick);
    }
    
    // 清理函数，在模态框关闭时调用
    modal.cleanup = () => {
        document.removeEventListener('keydown', handleEscKey);
        modal.removeEventListener('click', handleBackgroundClick);
        if (modalContent) {
            modalContent.removeEventListener('click', handleContentClick);
            modalContent.removeEventListener('click', handlePasswordToggleClick);
            modalContent.removeEventListener('click', handleUploadButtonClick);
        }
        stopKiroRecoveryCountdownTimer();
    };
}

/**
 * 关闭模态框并清理事件监听器
 * @param {HTMLElement} button - 关闭按钮
 */
function closeProviderModal(button) {
    const modal = button.closest('.provider-modal');
    if (modal) {
        if (modal.cleanup) {
            modal.cleanup();
        }
        modal.remove();
    }
}

/**
 * 渲染提供商列表（详细模式）
 * @param {Array} providers - 提供商数组
 * @returns {string} HTML字符串
 */
function renderProviderDetailList(providers) {
    return providers.map(provider => {
        const isHealthy = provider.isHealthy;
        const isDisabled = provider.isDisabled || false;
        const lastUsed = provider.lastUsed ? new Date(provider.lastUsed).toLocaleString() : t('modal.provider.neverUsed');
        const lastHealthCheckTime = provider.lastHealthCheckTime ? new Date(provider.lastHealthCheckTime).toLocaleString() : t('modal.provider.neverChecked');
        const lastHealthCheckModel = provider.lastHealthCheckModel || '-';
        const healthClass = isHealthy ? 'healthy' : 'unhealthy';
        const disabledClass = isDisabled ? 'disabled' : '';
        const healthIcon = isHealthy ? 'fas fa-check-circle text-success' : 'fas fa-exclamation-triangle text-warning';
        const healthText = isHealthy ? t('modal.provider.status.healthy') : t('modal.provider.status.unhealthy');
        const disabledText = isDisabled ? t('modal.provider.status.disabled') : t('modal.provider.status.enabled');
        const disabledIcon = isDisabled ? 'fas fa-ban text-muted' : 'fas fa-play text-success';
        const toggleButtonText = isDisabled ? t('modal.provider.enabled') : t('modal.provider.disabled');
        const toggleButtonIcon = isDisabled ? 'fas fa-play' : 'fas fa-ban';
        const toggleButtonClass = isDisabled ? 'btn-success' : 'btn-warning';
        const needsRefresh = !!provider.needsRefresh;
        
        // 构建错误信息显示
        let errorInfoHtml = '';
        if (!isHealthy && provider.lastErrorMessage) {
            const escapedErrorMsg = provider.lastErrorMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            errorInfoHtml = `
                <div class="provider-error-info">
                    <i class="fas fa-exclamation-circle text-danger"></i>
                    <span class="error-label" data-i18n="modal.provider.lastError">最后错误:</span>
                    <span class="error-message" title="${escapedErrorMsg}">${escapedErrorMsg}</span>
                </div>
            `;
        }
        
        return `
            <div class="provider-item-detail ${healthClass} ${disabledClass}" data-uuid="${provider.uuid}">
                <div class="provider-item-header" onclick="window.toggleProviderDetails('${provider.uuid}')">
                    <div class="provider-info">
                        <div class="provider-name">
                            ${provider.customName || provider.uuid}
                            ${needsRefresh ? `<span class="badge badge-warning" style="font-size: 10px; margin-left: 8px; vertical-align: middle;"><i class="fas fa-sync-alt fa-spin"></i> <span data-i18n="providers.status.needsRefresh">${t('providers.status.needsRefresh')}</span></span>` : ''}
                        </div>
                        <div class="provider-meta">
                            <span class="health-status">
                                <i class="${healthIcon}"></i>
                                <span data-i18n="modal.provider.healthCheckLabel">健康状态</span>: <span data-i18n="${isHealthy ? 'modal.provider.status.healthy' : 'modal.provider.status.unhealthy'}">${healthText}</span>
                            </span> |
                            <span class="disabled-status">
                                <i class="${disabledIcon}"></i>
                                <span data-i18n="upload.detail.status">状态</span>: <span data-i18n="${isDisabled ? 'modal.provider.status.disabled' : 'modal.provider.status.enabled'}">${disabledText}</span>
                            </span> |
                            <span data-i18n="modal.provider.usageCount">使用次数</span>: ${provider.usageCount || 0} |
                            <span data-i18n="modal.provider.errorCount">失败次数</span>: ${provider.errorCount || 0} |
                            <span data-i18n="modal.provider.lastUsed">最后使用</span>: ${lastUsed}
                        </div>
                        <div class="provider-health-meta">
                            <span class="health-check-time">
                                <i class="fas fa-clock"></i>
                                <span data-i18n="modal.provider.lastCheck">最后检测</span>: ${lastHealthCheckTime}
                            </span> |
                            <span class="health-check-model">
                                <i class="fas fa-cube"></i>
                                <span data-i18n="modal.provider.checkModel">检测模型</span>: ${lastHealthCheckModel}
                            </span>
                        </div>
                        <div class="provider-proxy-meta">
                            ${renderProviderProxySummary(provider)}
                        </div>
                        ${errorInfoHtml}
                    </div>
                    <div class="provider-actions-group">
                        <button class="btn-small ${toggleButtonClass}" onclick="window.toggleProviderStatus('${provider.uuid}', event)" title="${toggleButtonText}此提供商">
                            <i class="${toggleButtonIcon}"></i> ${toggleButtonText}
                        </button>
                        <button class="btn-small btn-edit" onclick="window.editProvider('${provider.uuid}', event)">
                            <i class="fas fa-edit"></i> <span data-i18n="modal.provider.edit">编辑</span>
                        </button>
                        <button class="btn-small btn-info btn-provider-health-check" onclick="window.performSingleHealthCheck('${provider.uuid}', event)" title="${t('modal.provider.healthCheckCurrentTitle')}">
                            <i class="fas fa-stethoscope"></i> <span data-i18n="modal.provider.healthCheck">${t('modal.provider.healthCheck')}</span>
                        </button>
                        <button class="btn-small btn-delete" onclick="window.deleteProvider('${provider.uuid}', event)">
                            <i class="fas fa-trash"></i> <span data-i18n="modal.provider.delete">删除</span>
                        </button>
                        <button class="btn-small btn-refresh-uuid" onclick="window.refreshProviderUuid('${provider.uuid}', event)" title="${t('modal.provider.refreshUuid')}">
                            <i class="fas fa-sync-alt"></i>
                        </button>
                    </div>
                </div>
                <div class="provider-item-content" id="content-${provider.uuid}">
                    <div class="">
                        ${renderProviderConfig(provider)}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * 渲染提供商列表（卡片模式）
 * @param {Array} providers - 提供商数组
 * @returns {string} HTML字符串
 */
function renderProviderCardList(providers) {
    let html = '<div class="provider-cards-grid">';
    html += providers.map(provider => {
        const isHealthy = provider.isHealthy;
        const isDisabled = provider.isDisabled || false;
        const healthClass = isHealthy ? 'healthy' : 'unhealthy';
        const disabledClass = isDisabled ? 'disabled' : '';
        const displayName = provider.customName || provider.uuid;
        const needsRefresh = !!provider.needsRefresh;
        const toggleButtonText = isDisabled ? t('modal.provider.enabled') : t('modal.provider.disabled');
        const toggleButtonIcon = isDisabled ? 'fas fa-play' : 'fas fa-ban';
        const toggleButtonClass = isDisabled ? 'btn-success' : 'btn-warning';

        return `
            <div class="provider-item-card ${healthClass} ${disabledClass}" data-uuid="${provider.uuid}">
                <div class="card-header">
                    <div class="card-status-dot"></div>
                    <div class="card-name" title="${displayName}">${displayName}</div>
                    ${needsRefresh ? '<i class="fas fa-sync-alt fa-spin card-refresh-icon"></i>' : ''}
                </div>
                <div class="card-body">
                    <div class="card-stat" title="${t('modal.provider.usageCount')}: ${provider.usageCount || 0}">
                        <i class="fas fa-paper-plane"></i>
                        <span>${provider.usageCount || 0}</span>
                    </div>
                    <div class="card-stat" title="${t('modal.provider.errorCount')}: ${provider.errorCount || 0}">
                        <i class="fas fa-exclamation-circle"></i>
                        <span>${provider.errorCount || 0}</span>
                    </div>
                </div>
                <div class="card-proxy-summary">
                    ${renderProviderProxySummary(provider)}
                </div>
                <div class="card-actions" onclick="event.stopPropagation()">
                    <button class="card-action-btn ${toggleButtonClass}" onclick="window.toggleProviderStatus('${provider.uuid}', event)" title="${toggleButtonText}">
                        <i class="${toggleButtonIcon}"></i>
                    </button>
                    <button class="card-action-btn btn-delete" onclick="window.deleteProvider('${provider.uuid}', event)" title="${t('modal.provider.delete')}">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
                <div class="provider-item-content" id="content-${provider.uuid}">
                    ${renderProviderConfig(provider)}
                </div>
            </div>
        `;
    }).join('');
    html += '</div>';
    return html;
}

/**
 * 渲染提供商列表
 * @param {Array} providers - 提供商数组
 * @returns {string} HTML字符串
 */
function renderProviderList(providers) {
    if (currentProviderType === 'claude-kiro-oauth') {
        return renderKiroProviderTable(providers);
    }

    if (currentViewMode === 'card') {
        return renderProviderCardList(providers);
    } else {
        return renderProviderDetailList(providers);
    }
}

/**
 * 渲染提供商配置
 * @param {Object} provider - 提供商对象
 * @returns {string} HTML字符串
 */
function renderProviderConfig(provider) {
    // 获取该提供商类型的所有字段定义（从 utils.js）
    const fieldConfigs = getProviderTypeFields(currentProviderType);
    
    // 获取字段显示顺序
    const fieldOrder = getFieldOrder(provider);
    
    // 先渲染基础配置字段（customName、checkModelName 和 checkHealth）
    let html = '<div class="form-grid">';
    const baseFields = ['customName', 'checkModelName', 'checkHealth', 'concurrencyLimit', 'queueLimit'];
    
    baseFields.forEach(fieldKey => {
        const displayLabel = getFieldLabel(fieldKey);
        const value = provider[fieldKey];
        const displayValue = (value !== undefined && value !== null) ? value : '';
        
        // 查找字段定义以获取 placeholder
        const fieldDef = fieldConfigs.find(f => f.id === fieldKey) || fieldConfigs.find(f => f.id.toUpperCase() === fieldKey.toUpperCase()) || {};
        const placeholder = fieldDef.placeholder || (fieldKey === 'customName' ? '节点自定义名称' : (fieldKey === 'checkModelName' ? '例如: gpt-3.5-turbo' : (fieldKey === 'concurrencyLimit' ? '最大并发, 默认0不限制' : (fieldKey === 'queueLimit' ? '最大队列, 默认0不限制' : ''))));
        
        // 如果是 customName 字段，使用普通文本输入框
        if (fieldKey === 'customName') {
            html += `
                <div class="config-item">
                    <label>${displayLabel}</label>
                    <input type="text"
                           value="${displayValue}"
                           readonly
                           data-config-key="${fieldKey}"
                           data-config-value="${(value !== undefined && value !== null) ? value : ''}"
                           placeholder="${placeholder}">
                </div>
            `;
        } else if (fieldKey === 'checkHealth') {
            // 如果没有值，默认为 false
            const actualValue = value !== undefined ? value : false;
            const isEnabled = actualValue === true || actualValue === 'true';
            html += `
                <div class="config-item">
                    <label>${displayLabel}</label>
                    <select class="form-control"
                            data-config-key="${fieldKey}"
                            data-config-value="${actualValue}"
                            disabled>
                        <option value="true" ${isEnabled ? 'selected' : ''} data-i18n="modal.provider.enabled">启用</option>
                        <option value="false" ${!isEnabled ? 'selected' : ''} data-i18n="modal.provider.disabled">禁用</option>
                    </select>
                </div>
            `;
        } else {
            // checkModelName 字段始终显示
            html += `
                <div class="config-item">
                    <label>${displayLabel}</label>
                    <input type="text"
                           value="${displayValue}"
                           readonly
                           data-config-key="${fieldKey}"
                           data-config-value="${(value !== undefined && value !== null) ? value : ''}"
                           placeholder="${placeholder}">
                </div>
            `;
        }
    });
    html += '</div>';
    
    // 渲染其他配置字段，每行2列
    const otherFields = fieldOrder.filter(key => !baseFields.includes(key));
    
    for (let i = 0; i < otherFields.length; i += 2) {
        html += '<div class="form-grid">';
        
        const field1Key = otherFields[i];
        const field1Label = getFieldLabel(field1Key);
        const field1Value = provider[field1Key];
        const field1IsPassword = field1Key.toLowerCase().includes('key') || field1Key.toLowerCase().includes('password');
        const field1IsOAuthFilePath = field1Key.includes('OAUTH_CREDS_FILE_PATH');
        const field1DisplayValue = field1IsPassword && field1Value ? '••••••••' : ((field1Value !== undefined && field1Value !== null) ? field1Value : '');
        const field1Def = fieldConfigs.find(f => f.id === field1Key) || fieldConfigs.find(f => f.id.toUpperCase() === field1Key.toUpperCase()) || {};
        
        if (field1IsPassword) {
            html += `
                <div class="config-item">
                    <label>${field1Label}</label>
                    <div class="password-input-wrapper">
                        <input type="password"
                               value="${field1DisplayValue}"
                               readonly
                               data-config-key="${field1Key}"
                               data-config-value="${(field1Value !== undefined && field1Value !== null) ? field1Value : ''}"
                               placeholder="${field1Def.placeholder || ''}">
                       <button type="button" class="password-toggle" data-target="${field1Key}">
                            <i class="fas fa-eye"></i>
                        </button>
                    </div>
                </div>
            `;
        } else if (field1IsOAuthFilePath) {
            // OAuth凭据文件路径字段，添加上传按钮
            const field1IsKiro = field1Key.includes('KIRO');
            html += `
                <div class="config-item">
                    <label>${field1Label}</label>
                    <div class="file-input-group">
                        <input type="text"
                               id="edit-${provider.uuid}-${field1Key}"
                               value="${(field1Value !== undefined && field1Value !== null) ? field1Value : ''}"
                               readonly
                               data-config-key="${field1Key}"
                               data-config-value="${(field1Value !== undefined && field1Value !== null) ? field1Value : ''}"
                               placeholder="${field1Def.placeholder || ''}">
                       <button type="button" class="btn btn-outline upload-btn" data-target="edit-${provider.uuid}-${field1Key}" aria-label="上传文件" disabled>
                            <i class="fas fa-upload"></i>
                        </button>
                    </div>
                    ${field1IsKiro ? '<small class="form-text"><i class="fas fa-info-circle"></i> ' + t('modal.provider.kiroAuthHint') + '</small>' : ''}
                </div>
            `;
        } else {
            html += `
                <div class="config-item">
                    <label>${field1Label}</label>
                    <input type="text"
                           value="${field1DisplayValue}"
                           readonly
                           data-config-key="${field1Key}"
                           data-config-value="${(field1Value !== undefined && field1Value !== null) ? field1Value : ''}"
                           placeholder="${field1Def.placeholder || ''}">
                </div>
            `;
        }
        
        // 如果有第二个字段
        if (i + 1 < otherFields.length) {
            const field2Key = otherFields[i + 1];
            const field2Label = getFieldLabel(field2Key);
            const field2Value = provider[field2Key];
            const field2IsPassword = field2Key.toLowerCase().includes('key') || field2Key.toLowerCase().includes('password');
            const field2IsOAuthFilePath = field2Key.includes('OAUTH_CREDS_FILE_PATH');
            const field2DisplayValue = field2IsPassword && field2Value ? '••••••••' : ((field2Value !== undefined && field2Value !== null) ? field2Value : '');
            const field2Def = fieldConfigs.find(f => f.id === field2Key) || fieldConfigs.find(f => f.id.toUpperCase() === field2Key.toUpperCase()) || {};
            
            if (field2IsPassword) {
                html += `
                    <div class="config-item">
                        <label>${field2Label}</label>
                        <div class="password-input-wrapper">
                            <input type="password"
                                   value="${field2DisplayValue}"
                                   readonly
                                   data-config-key="${field2Key}"
                                   data-config-value="${(field2Value !== undefined && field2Value !== null) ? field2Value : ''}"
                                   placeholder="${field2Def.placeholder || ''}">
                            <button type="button" class="password-toggle" data-target="${field2Key}">
                                <i class="fas fa-eye"></i>
                            </button>
                        </div>
                    </div>
                `;
            } else if (field2IsOAuthFilePath) {
                // OAuth凭据文件路径字段，添加上传按钮
                const field2IsKiro = field2Key.includes('KIRO');
                html += `
                    <div class="config-item">
                        <label>${field2Label}</label>
                        <div class="file-input-group">
                            <input type="text"
                                   id="edit-${provider.uuid}-${field2Key}"
                                   value="${(field2Value !== undefined && field2Value !== null) ? field2Value : ''}"
                                   readonly
                                   data-config-key="${field2Key}"
                                   data-config-value="${(field2Value !== undefined && field2Value !== null) ? field2Value : ''}"
                                   placeholder="${field2Def.placeholder || ''}">
                            <button type="button" class="btn btn-outline upload-btn" data-target="edit-${provider.uuid}-${field2Key}" aria-label="上传文件" disabled>
                                <i class="fas fa-upload"></i>
                            </button>
                        </div>
                        ${field2IsKiro ? '<small class="form-text"><i class="fas fa-info-circle"></i> ' + t('modal.provider.kiroAuthHint') + '</small>' : ''}
                    </div>
                `;
            } else {
                html += `
                    <div class="config-item">
                        <label>${field2Label}</label>
                        <input type="text"
                               value="${field2DisplayValue}"
                               readonly
                               data-config-key="${field2Key}"
                               data-config-value="${(field2Value !== undefined && field2Value !== null) ? field2Value : ''}"
                               placeholder="${field2Def.placeholder || ''}">
                    </div>
                `;
            }
        }
        
        html += '</div>';
    }
    
    html += renderProxyBindingSection(provider);

    // 添加 notSupportedModels 配置区域
    if (usesManagedModelList(currentProviderType)) {
        html += '<div class="form-grid full-width">';
        html += renderSupportedModelsSection(provider);
        html += '</div>';
        return html;
    }

    html += '<div class="form-grid full-width">';
    html += `
        <div class="config-item not-supported-models-section">
            <label>
                <i class="fas fa-ban"></i> <span data-i18n="modal.provider.unsupportedModels">不支持的模型</span>
                <span class="help-text" data-i18n="modal.provider.unsupportedModelsHelp">选择此提供商不支持的模型，系统会自动排除这些模型</span>
            </label>
            <div class="not-supported-models-container" data-uuid="${provider.uuid}">
                <div class="models-loading">
                    <i class="fas fa-spinner fa-spin"></i> <span data-i18n="modal.provider.loadingModels">加载模型列表...</span>
                </div>
            </div>
        </div>
    `;
    html += '</div>';
    
    return html;
}

/**
 * 获取字段显示顺序
 * @param {Object} provider - 提供商对象
 * @returns {Array} 字段键数组
 */
/**
 * 获取字段显示顺序
 * @param {Object} provider - 提供商对象
 * @returns {Array} 字段名数组
 */
function getFieldOrder(provider) {
    const orderedFields = ['customName', 'checkModelName', 'checkHealth', 'concurrencyLimit', 'queueLimit'];
    
    // 需要排除的内部状态字段
    const excludedFields = [
        'isHealthy', 'lastUsed', 'usageCount', 'errorCount', 'lastErrorTime',
        'uuid', 'isDisabled', 'lastHealthCheckTime', 'lastHealthCheckModel', 'lastErrorMessage',
        'notSupportedModels', 'supportedModels', 'refreshCount', 'needsRefresh', '_lastSelectionSeq',
        'lastRefreshTime', 'lastSuccessTime', 'proxyId', 'proxy_id', 'proxy', 'autoAssignProxy',
        'auto_assign_proxy'
    ];
    
    // 尝试从当前模态框上下文中获取提供商类型
    let providerType = currentProviderType;
    
    // 如果没有上下文类型，尝试从对象字段推断（回退逻辑）
    if (!providerType) {
        if (provider.OPENAI_API_KEY && provider.OPENAI_BASE_URL) {
            providerType = 'openai-custom';
        } else if (provider.CLAUDE_API_KEY && provider.CLAUDE_BASE_URL) {
            providerType = 'claude-custom';
        } else if (provider.GEMINI_OAUTH_CREDS_FILE_PATH) {
            providerType = 'gemini-cli-oauth';
        } else if (provider.KIRO_OAUTH_CREDS_FILE_PATH) {
            providerType = 'claude-kiro-oauth';
        } else if (provider.QWEN_OAUTH_CREDS_FILE_PATH) {
            providerType = 'openai-qwen-oauth';
        } else if (provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH) {
            providerType = 'gemini-antigravity';
        } else if (provider.IFLOW_OAUTH_CREDS_FILE_PATH) {
            providerType = 'openai-iflow';
        } else if (provider.CODEX_OAUTH_CREDS_FILE_PATH) {
            providerType = 'openai-codex-oauth';
        } else if (provider.GROK_COOKIE_TOKEN) {
            providerType = 'grok-web';
        } else if (provider.FORWARD_API_KEY) {
            providerType = 'forward-api';
        }
    }

    // 直接从 utils.js 获取该类型的预定义字段列表（支持前缀匹配）
    const predefinedFields = providerType ? getProviderTypeFields(providerType) : [];
    const predefinedOrder = predefinedFields.map(f => f.id);
    
    // 获取当前对象中存在且不在预定义列表中的其他字段
    const otherFields = Object.keys(provider).filter(key =>
        !excludedFields.includes(key) &&
        !orderedFields.includes(key) &&
        !predefinedOrder.includes(key)
    );
    otherFields.sort();

    // 合并所有要显示的字段
    const allExpectedFields = [...orderedFields, ...predefinedOrder, ...otherFields];
    
    // 只有在字段确实存在于 provider 中，或者它是该提供商类型的预定义字段时才显示
    return allExpectedFields.filter(key =>
        Object.prototype.hasOwnProperty.call(provider, key) || predefinedOrder.includes(key)
    );
}

/**
 * 切换提供商详情显示
 * @param {string} uuid - 提供商UUID
 */
function toggleProviderDetails(uuid) {
    const content = document.getElementById(`content-${uuid}`);
    if (content) {
        content.classList.toggle('expanded');
    }
}

/**
 * 编辑提供商
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
function editProvider(uuid, event) {
    event.stopPropagation();
    
    const providerDetail = event.target.closest('.provider-item-detail, .provider-item-card');
    const configInputs = providerDetail.querySelectorAll('input[data-config-key]');
    const configSelects = providerDetail.querySelectorAll('select[data-config-key]');
    const content = providerDetail.querySelector(`#content-${uuid}`);
    
    // 如果还没有展开，则自动展开编辑框
    if (content && !content.classList.contains('expanded')) {
        toggleProviderDetails(uuid);
    }
    
    // 等待一小段时间让展开动画完成，然后切换输入框为可编辑状态
    setTimeout(() => {
        // 切换输入框为可编辑状态
    configInputs.forEach(input => {
        input.readOnly = false;
        if (input.type === 'checkbox') {
            input.disabled = false;
        }
        if (input.type === 'password') {
            const actualValue = input.dataset.configValue;
            input.value = actualValue;
            }
        });
        
        // 启用文件上传按钮
        const uploadButtons = providerDetail.querySelectorAll('.upload-btn');
        uploadButtons.forEach(button => {
            button.disabled = false;
        });
        
        // 启用下拉选择框
        configSelects.forEach(select => {
            select.disabled = false;
        });
        
        // 启用模型复选框
        const modelCheckboxes = providerDetail.querySelectorAll('.model-checkbox');
        modelCheckboxes.forEach(checkbox => {
            checkbox.disabled = false;
        });

        const detectModelsButton = providerDetail.querySelector('.detect-models-btn');
        if (detectModelsButton) {
            detectModelsButton.disabled = false;
        }
        
        // 添加编辑状态类
        providerDetail.classList.add('editing');
        
        // 替换编辑按钮为保存和取消按钮，不显示禁用/启用按钮
        const actionsGroup = providerDetail.querySelector('.provider-actions-group');
        
        actionsGroup.innerHTML = `
            <button class="btn-small btn-save" onclick="window.saveProvider('${uuid}', event)">
                <i class="fas fa-save"></i> <span data-i18n="modal.provider.save">保存</span>
            </button>
            <button class="btn-small btn-cancel" onclick="window.cancelEdit('${uuid}', event)">
                <i class="fas fa-times"></i> <span data-i18n="modal.provider.cancel">取消</span>
            </button>
        `;
    }, 100);
}

/**
 * 取消编辑
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
function cancelEdit(uuid, event) {
    event.stopPropagation();
    
    const providerDetail = event.target.closest('.provider-item-detail, .provider-item-card');
    const configInputs = providerDetail.querySelectorAll('input[data-config-key]');
    const configSelects = providerDetail.querySelectorAll('select[data-config-key]');
    
    // 恢复输入框为只读状态
    configInputs.forEach(input => {
        input.readOnly = true;
        const originalValue = input.dataset.configValue;
        // 恢复原始值
        if (input.type === 'checkbox') {
            input.checked = originalValue === 'true';
            input.disabled = true;
        } else if (input.type === 'password') {
            input.value = originalValue ? '••••••••' : '';
        } else {
            input.value = originalValue || '';
        }
    });
    
    // 禁用模型复选框
    const modelCheckboxes = providerDetail.querySelectorAll('.model-checkbox');
    modelCheckboxes.forEach(checkbox => {
        checkbox.disabled = true;
    });

    const detectModelsButton = providerDetail.querySelector('.detect-models-btn');
    if (detectModelsButton) {
        detectModelsButton.disabled = true;
    }

    if (usesManagedModelList(currentProviderType)) {
        resetSupportedModelsSelection(uuid);
    } else {
        const currentProviderData = currentProviders.find(provider => provider.uuid === uuid);
        if (currentProviderData) {
            renderNotSupportedModelsSelector(uuid, cachedModels, currentProviderData.notSupportedModels || []);
        }
    }
    
    // 移除编辑状态类
    providerDetail.classList.remove('editing');
    
    // 禁用文件上传按钮
    const uploadButtons = providerDetail.querySelectorAll('.upload-btn');
    uploadButtons.forEach(button => {
        button.disabled = true;
    });
    
    // 禁用下拉选择框
    configSelects.forEach(select => {
        select.disabled = true;
        // 恢复原始值
        const originalValue = select.dataset.configValue;
        select.value = originalValue || '';
    });
    
    // 恢复原来的按钮布局
    const actionsGroup = providerDetail.querySelector('.provider-actions-group');
    const currentProvider = providerDetail.closest('.provider-modal').querySelector(`[data-uuid="${uuid}"]`);
    const isCurrentlyDisabled = currentProvider.classList.contains('disabled');
    const toggleButtonText = isCurrentlyDisabled ? t('modal.provider.enabled') : t('modal.provider.disabled');
    const toggleButtonIcon = isCurrentlyDisabled ? 'fas fa-play' : 'fas fa-ban';
    const toggleButtonClass = isCurrentlyDisabled ? 'btn-success' : 'btn-warning';
    
    actionsGroup.innerHTML = `
        <button class="btn-small ${toggleButtonClass}" onclick="window.toggleProviderStatus('${uuid}', event)" title="${toggleButtonText}此提供商">
            <i class="${toggleButtonIcon}"></i> ${toggleButtonText}
        </button>
        <button class="btn-small btn-edit" onclick="window.editProvider('${uuid}', event)">
            <i class="fas fa-edit"></i> <span data-i18n="modal.provider.edit">${t('modal.provider.edit')}</span>
        </button>
        <button class="btn-small btn-info btn-provider-health-check" onclick="window.performSingleHealthCheck('${uuid}', event)" title="${t('modal.provider.healthCheckCurrentTitle')}">
            <i class="fas fa-stethoscope"></i> <span data-i18n="modal.provider.healthCheck">${t('modal.provider.healthCheck')}</span>
        </button>
        <button class="btn-small btn-delete" onclick="window.deleteProvider('${uuid}', event)">
            <i class="fas fa-trash"></i> <span data-i18n="modal.provider.delete">${t('modal.provider.delete')}</span>
        </button>
        <button class="btn-small btn-refresh-uuid" onclick="window.refreshProviderUuid('${uuid}', event)" title="${t('modal.provider.refreshUuid')}">
            <i class="fas fa-sync-alt"></i>
        </button>
    `;
}

/**
 * 保存提供商
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
async function saveProvider(uuid, event) {
    event.stopPropagation();
    
    const providerDetail = event.target.closest('.provider-item-detail, .provider-item-card');
    const providerType = providerDetail.closest('.provider-modal').getAttribute('data-provider-type');
    
    const providerConfig = collectDraftProviderConfig(providerDetail, providerType, uuid);
    
    
    
    // 收集不支持的模型列表
    
    try {
        await window.apiClient.put(`/providers/${encodeURIComponent(providerType)}/${uuid}`, { providerConfig });
        await window.apiClient.post('/reload-config');
        showToast(t('common.success'), t('modal.provider.save.success'), 'success');
        // 重新获取该提供商类型的最新配置
        await refreshProviderConfig(providerType);
    } catch (error) {
        console.error('Failed to update provider:', error);
        showToast(t('common.error'), t('modal.provider.save.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 删除提供商
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
async function deleteProvider(uuid, event) {
    event.stopPropagation();
    
    if (!confirm(t('modal.provider.deleteConfirm'))) {
        return;
    }
    
    const providerDetail = event.target.closest('.provider-item-detail, .provider-item-card');
    const providerType = providerDetail.closest('.provider-modal').getAttribute('data-provider-type');
    
    try {
        await window.apiClient.delete(`/providers/${encodeURIComponent(providerType)}/${uuid}`);
        await window.apiClient.post('/reload-config');
        showToast(t('common.success'), t('modal.provider.delete.success'), 'success');
        // 重新获取最新配置
        await refreshProviderConfig(providerType);
    } catch (error) {
        console.error('Failed to delete provider:', error);
        showToast(t('common.error'), t('modal.provider.delete.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 重新获取并刷新提供商配置
 * @param {string} providerType - 提供商类型
 */
async function refreshProviderConfig(providerType) {
    try {
        // 重新获取该提供商类型的最新数据
        const data = await window.apiClient.get(`/providers/${encodeURIComponent(providerType)}`);
        
        // 如果当前显示的是该提供商类型的模态框，则更新模态框
        const modal = document.querySelector('.provider-modal');
        if (modal && modal.getAttribute('data-provider-type') === providerType) {
            // 更新缓存的提供商数据
            currentProviders = data.providers;
            currentProviderType = providerType;
            cleanSelectedProviderUuids();

            if (providerType === 'claude-kiro-oauth') {
                const summary = modal.querySelector('.kiro-console-summary');
                if (summary) {
                    summary.innerHTML = `${renderKiroStatsGrid(data.providers)}${renderKiroConsoleActions(providerType)}`;
                }

                const providerList = modal.querySelector('.provider-list');
                if (providerList) {
                    providerList.innerHTML = renderProviderListPaginated(getFilteredProviders(), currentPage);
                }

                updateKiroSelectionUi();
                syncKiroRecoveryCountdownTimer();
                return;
            }
            
            // 更新统计信息
            const totalCountElement = modal.querySelector('.provider-summary-item .value');
            if (totalCountElement) {
                totalCountElement.textContent = data.totalCount;
            }
            
            const healthyCountElement = modal.querySelectorAll('.provider-summary-item .value')[1];
            if (healthyCountElement) {
                healthyCountElement.textContent = data.healthyCount;
            }
            
            const totalPages = Math.ceil(data.providers.length / PROVIDERS_PER_PAGE);
            
            // 确保当前页不超过总页数
            if (currentPage > totalPages) {
                currentPage = Math.max(1, totalPages);
            }
            
            // 重新渲染提供商列表（分页）
            const providerList = modal.querySelector('.provider-list');
            if (providerList) {
                providerList.innerHTML = renderProviderListPaginated(data.providers, currentPage);
            }
            
            // 更新分页控件
            const paginationContainers = modal.querySelectorAll('.pagination-container');
            if (totalPages > 1) {
                paginationContainers.forEach(container => {
                    const position = container.getAttribute('data-position');
                    container.outerHTML = renderPagination(currentPage, totalPages, data.providers.length, position);
                });
                
                // 如果之前没有分页控件，需要添加
                if (paginationContainers.length === 0) {
                    const modalBody = modal.querySelector('.provider-modal-body');
                    const providerListEl = modal.querySelector('.provider-list');
                    if (modalBody && providerListEl) {
                        providerListEl.insertAdjacentHTML('beforebegin', renderPagination(currentPage, totalPages, data.providers.length, 'top'));
                        providerListEl.insertAdjacentHTML('afterend', renderPagination(currentPage, totalPages, data.providers.length, 'bottom'));
                    }
                }
            } else {
                // 如果只有一页，移除分页控件
                paginationContainers.forEach(container => container.remove());
            }
            
            // 重新加载当前页的模型列表
            const startIndex = (currentPage - 1) * PROVIDERS_PER_PAGE;
            const endIndex = Math.min(startIndex + PROVIDERS_PER_PAGE, data.providers.length);
            const pageProviders = data.providers.slice(startIndex, endIndex);
            loadModelsForProviderType(providerType, pageProviders);
        }
        
        // 同时更新主界面的提供商统计数据
        if (typeof window.loadProviders === 'function') {
            await window.loadProviders();
        }
        
    } catch (error) {
        console.error('Failed to refresh provider config:', error);
    }
}

/**
 * 显示添加提供商表单
 * @param {string} providerType - 提供商类型
 */
async function showAddProviderForm(providerType) {
    const modal = document.querySelector('.provider-modal');
    const existingForm = modal.querySelector('.add-provider-form');
    
    if (existingForm) {
        existingForm.remove();
        return;
    }
    await loadProxyOptions(true);
    
    const form = document.createElement('div');
    form.className = 'add-provider-form';
    form.innerHTML = `
        <h4 data-i18n="modal.provider.addTitle"><i class="fas fa-plus"></i> 添加新提供商配置</h4>
        <div class="form-grid">
            <div class="form-group">
                <label><span data-i18n="modal.provider.customName">自定义名称</span> <span class="optional-mark" data-i18n="config.optional">(选填)</span></label>
                <input type="text" id="newCustomName" data-i18n="modal.provider.customName" placeholder="例如: 我的节点1">
            </div>
            <div class="form-group">
                <label><span data-i18n="modal.provider.checkModelName">检查模型名称</span> <span class="optional-mark" data-i18n="config.optional">(选填)</span></label>
                <input type="text" id="newCheckModelName" data-i18n="modal.provider.checkModelName" placeholder="例如: gpt-3.5-turbo">
            </div>
            <div class="form-group">
                <label data-i18n="modal.provider.healthCheckLabel">健康检查</label>
                <select id="newCheckHealth">
                    <option value="false" data-i18n="modal.provider.disabled">禁用</option>
                    <option value="true" data-i18n="modal.provider.enabled">启用</option>
                </select>
            </div>
            <div class="form-group">
                <label><span data-i18n="modal.provider.concurrencyLimit">并发限制</span> <span class="optional-mark" data-i18n="config.optional">(选填)</span></label>
                <input type="number" id="newConcurrencyLimit" placeholder="默认0不限制">
            </div>
            <div class="form-group">
                <label><span data-i18n="modal.provider.queueLimit">队列限制</span> <span class="optional-mark" data-i18n="config.optional">(选填)</span></label>
                <input type="number" id="newQueueLimit" placeholder="默认0不限制">
            </div>
            <div class="form-group">
                <label data-i18n="modal.provider.proxy">代理</label>
                <select id="newProxyId">
                    <option value="">${t('modal.provider.noProxy')}</option>
                    ${cachedProxyOptions.map(proxy => `<option value="${escapeHtml(proxy.id)}">${escapeHtml(proxy.name || proxy.id)}${proxy.assignedCount !== undefined ? ` (${proxy.assignedCount})` : ''}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label data-i18n="modal.provider.autoAssignProxy">自动分配代理</label>
                <select id="newAutoAssignProxy">
                    <option value="false">${t('modal.provider.disabled')}</option>
                    <option value="true">${t('modal.provider.enabled')}</option>
                </select>
            </div>
        </div>
        <div id="dynamicConfigFields">
            <!-- 动态配置字段将在这里显示 -->
        </div>
        <div class="form-actions" style="margin-top: 15px;">
            <button class="btn btn-success" onclick="window.addProvider('${providerType}')">
                <i class="fas fa-save"></i> <span data-i18n="modal.provider.save">保存</span>
            </button>
            <button class="btn btn-secondary" onclick="this.closest('.add-provider-form').remove()">
                <i class="fas fa-times"></i> <span data-i18n="modal.provider.cancel">取消</span>
            </button>
        </div>
    `;
    
    // 添加动态配置字段
    addDynamicConfigFields(form, providerType);
    
    // 为添加表单中的密码切换按钮绑定事件监听器
    bindAddFormPasswordToggleListeners(form);
    
    // 插入到提供商列表前面
    const providerList = modal.querySelector('.provider-list');
    providerList.parentNode.insertBefore(form, providerList);
}

/**
 * 添加动态配置字段
 * @param {HTMLElement} form - 表单元素
 * @param {string} providerType - 提供商类型
 */
function addDynamicConfigFields(form, providerType) {
    const configFields = form.querySelector('#dynamicConfigFields');
    
    // 获取该提供商类型的字段配置（已经在 utils.js 中包含了 URL 字段）
    const allFields = getProviderTypeFields(providerType);
    
    // 过滤掉已经在 form-grid 中硬编码显示的五个基础字段，避免重复
    const baseFields = ['customName', 'checkModelName', 'checkHealth', 'concurrencyLimit', 'queueLimit'];
    const filteredFields = allFields.filter(f => !baseFields.some(bf => f.id.toLowerCase().includes(bf.toLowerCase())));

    let fields = '';
    
    if (filteredFields.length > 0) {
        // 分组显示，每行两个字段
        for (let i = 0; i < filteredFields.length; i += 2) {
            fields += '<div class="form-grid">';
            
            const field1 = filteredFields[i];
            // 检查是否为密码类型字段
            const isPassword1 = field1.type === 'password';
            // 检查是否为OAuth凭据文件路径字段（兼容两种命名方式）
            const isOAuthFilePath1 = field1.id.includes('OAUTH_CREDS_FILE_PATH') || field1.id.includes('OauthCredsFilePath');
            
            if (isPassword1) {
                fields += `
                    <div class="form-group">
                        <label>${field1.label}</label>
                        <div class="password-input-wrapper">
                            <input type="password" id="new${field1.id}" placeholder="${field1.placeholder || ''}" value="${field1.value || ''}">
                            <button type="button" class="password-toggle" data-target="new${field1.id}">
                                <i class="fas fa-eye"></i>
                            </button>
                        </div>
                    </div>
                `;
            } else if (isOAuthFilePath1) {
                // OAuth凭据文件路径字段，添加上传按钮
                const isKiroField = field1.id.includes('KIRO');
    fields += `
        <div class="form-group">
            <label>${field1.label}</label>
            <div class="file-input-group">
                <input type="text" id="new${field1.id}" class="form-control" placeholder="${field1.placeholder || ''}" value="${field1.value || ''}">
                <button type="button" class="btn btn-outline upload-btn" data-target="new${field1.id}" aria-label="上传文件">
                    <i class="fas fa-upload"></i>
                </button>
            </div>
            ${isKiroField ? '<small class="form-text"><i class="fas fa-info-circle"></i> ' + t('modal.provider.kiroAuthHint') + '</small>' : ''}
        </div>
    `;
            } else {
                fields += `
                    <div class="form-group">
                        <label>${field1.label}</label>
                        <input type="${field1.type}" id="new${field1.id}" placeholder="${field1.placeholder || ''}" value="${field1.value || ''}">
                    </div>
                `;
            }
            
            const field2 = filteredFields[i + 1];
            if (field2) {
                // 检查是否为密码类型字段
                const isPassword2 = field2.type === 'password';
                // 检查是否为OAuth凭据文件路径字段（兼容两种命名方式）
                const isOAuthFilePath2 = field2.id.includes('OAUTH_CREDS_FILE_PATH') || field2.id.includes('OauthCredsFilePath');
                
                if (isPassword2) {
                    fields += `
                        <div class="form-group">
                            <label>${field2.label}</label>
                            <div class="password-input-wrapper">
                                <input type="password" id="new${field2.id}" placeholder="${field2.placeholder || ''}" value="${field2.value || ''}">
                                <button type="button" class="password-toggle" data-target="new${field2.id}">
                                    <i class="fas fa-eye"></i>
                                </button>
                            </div>
                        </div>
                    `;
                } else if (isOAuthFilePath2) {
                    // OAuth凭据文件路径字段，添加上传按钮
                    const isKiroField = field2.id.includes('KIRO');
    fields += `
        <div class="form-group">
            <label>${field2.label}</label>
            <div class="file-input-group">
                <input type="text" id="new${field2.id}" class="form-control" placeholder="${field2.placeholder || ''}" value="${field2.value || ''}">
                <button type="button" class="btn btn-outline upload-btn" data-target="new${field2.id}" aria-label="上传文件">
                    <i class="fas fa-upload"></i>
                </button>
            </div>
            ${isKiroField ? '<small class="form-text"><i class="fas fa-info-circle"></i> ' + t('modal.provider.kiroAuthHint') + '</small>' : ''}
        </div>
    `;
                } else {
                    fields += `
                        <div class="form-group">
                            <label>${field2.label}</label>
                            <input type="${field2.type}" id="new${field2.id}" placeholder="${field2.placeholder || ''}" value="${field2.value || ''}">
                        </div>
                    `;
                }
            }
            
            fields += '</div>';
        }
    } else {
        fields = `<p data-i18n="modal.provider.noProviderType">${t('modal.provider.noProviderType')}</p>`;
    }
    
    configFields.innerHTML = fields;
}

/**
 * 为添加新提供商表单中的密码切换按钮绑定事件监听器
 * @param {HTMLElement} form - 表单元素
 */
function bindAddFormPasswordToggleListeners(form) {
    const passwordToggles = form.querySelectorAll('.password-toggle');
    passwordToggles.forEach(button => {
        button.addEventListener('click', function() {
            const targetId = this.getAttribute('data-target');
            const input = document.getElementById(targetId);
            const icon = this.querySelector('i');
            
            if (!input || !icon) return;
            
            if (input.type === 'password') {
                input.type = 'text';
                icon.className = 'fas fa-eye-slash';
            } else {
                input.type = 'password';
                icon.className = 'fas fa-eye';
            }
        });
    });
}

/**
 * 添加新提供商
 * @param {string} providerType - 提供商类型
 */
async function addProvider(providerType) {
    const customName = document.getElementById('newCustomName')?.value;
    const checkModelName = document.getElementById('newCheckModelName')?.value;
    const checkHealth = document.getElementById('newCheckHealth')?.value === 'true';
    const concurrencyLimit = parseInt(document.getElementById('newConcurrencyLimit')?.value || '0');
    const queueLimit = parseInt(document.getElementById('newQueueLimit')?.value || '0');
    const proxyId = document.getElementById('newProxyId')?.value || null;
    const autoAssignProxy = document.getElementById('newAutoAssignProxy')?.value === 'true';
    
    const providerConfig = {
        customName: customName || '', // 允许为空
        checkModelName: checkModelName || '', // 允许为空
        checkHealth,
        concurrencyLimit,
        queueLimit,
        proxyId,
        autoAssignProxy
    };
    
    // 根据提供商类型动态收集配置字段（自动匹配 utils.js 中的定义）
    const allFields = getProviderTypeFields(providerType);
    allFields.forEach(field => {
        const element = document.getElementById(`new${field.id}`);
        if (element) {
            providerConfig[field.id] = element.value || '';
        }
    });
    
    try {
        await window.apiClient.post('/providers', {
            providerType,
            providerConfig
        });
        await window.apiClient.post('/reload-config');
        showToast(t('common.success'), t('modal.provider.add.success'), 'success');
        // 移除添加表单
        const form = document.querySelector('.add-provider-form');
        if (form) {
            form.remove();
        }
        // 重新获取最新配置数据
        await refreshProviderConfig(providerType);
    } catch (error) {
        console.error('Failed to add provider:', error);
        showToast(t('common.error'), t('modal.provider.add.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 切换提供商禁用/启用状态
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
async function toggleProviderStatus(uuid, event) {
    event.stopPropagation();
    
    const providerDetail = event.target.closest('.provider-item-detail, .provider-item-card');
    const providerType = providerDetail.closest('.provider-modal').getAttribute('data-provider-type');
    const currentProvider = providerDetail.closest('.provider-modal').querySelector(`[data-uuid="${uuid}"]`);
    
    // 获取当前提供商信息
    const isCurrentlyDisabled = currentProvider.classList.contains('disabled');
    const action = isCurrentlyDisabled ? 'enable' : 'disable';
    const confirmMessage = isCurrentlyDisabled ?
        t('modal.provider.enableConfirm') :
        t('modal.provider.disableConfirm');
    
    if (!confirm(confirmMessage)) {
        return;
    }
    
    try {
        await window.apiClient.post(`/providers/${encodeURIComponent(providerType)}/${uuid}/${action}`, { action });
        await window.apiClient.post('/reload-config');
        showToast(t('common.success'), t('common.success'), 'success');
        // 重新获取该提供商类型的最新配置
        await refreshProviderConfig(providerType);
    } catch (error) {
        console.error('Failed to toggle provider status:', error);
        showToast(t('common.error'), t('common.error') + ': ' + error.message, 'error');
    }
}

/**
 * 重置所有提供商的健康状态
 * @param {string} providerType - 提供商类型
 */
async function resetAllProvidersHealth(providerType) {
    if (!confirm(t('modal.provider.resetHealthConfirm', {type: providerType}))) {
        return;
    }
    
    try {
        showToast(t('common.info'), t('modal.provider.resetHealth') + '...', 'info');
        
        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/reset-health`,
            {}
        );
        
        if (response.success) {
            showToast(t('common.success'), t('modal.provider.resetHealth.success', { count: response.resetCount }), 'success');
            
            // 只有当确实有节点的健康状态被重置时，才重新加载配置以刷新适配器实例
            if (response.resetCount > 0) {
                console.log(`[UI] ${response.resetCount} node(s) health status reset, reloading configuration...`);
                await window.apiClient.post('/reload-config');
            }
            
            // 刷新提供商配置显示
            await refreshProviderConfig(providerType);
        } else {
            showToast(t('common.error'), t('modal.provider.resetHealth.failed'), 'error');
        }
    } catch (error) {
        console.error('重置健康状态失败:', error);
        showToast(t('common.error'), t('modal.provider.resetHealth.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 执行健康检测
 * @param {string} providerType - 提供商类型
 */
async function performHealthCheck(providerType) {
    if (!confirm(t('modal.provider.healthCheckConfirm', {type: providerType}))) {
        return;
    }

    if (providerType === 'claude-kiro-oauth') {
        const targets = currentProviders.filter(provider => provider?.uuid && provider.isHealthy !== true);
        await performKiroHealthChecks(providerType, targets, {
            mode: 'unhealthy',
            emptyMessageKey: 'modal.provider.kiroConsole.health.noUnhealthy'
        });
        return;
    }
    
    try {
        showToast(t('common.info'), t('modal.provider.healthCheck') + '...', 'info');
        
        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/health-check`,
            {}
        );
        
        if (response.success) {
            const { successCount, failCount, totalCount, results } = response;
            
            // 统计跳过的数量（checkHealth 未启用的）
            const skippedCount = results ? results.filter(r => r.success === null).length : 0;
            
            let message = `${t('modal.provider.healthCheck.complete', { success: successCount })}`;
            if (failCount > 0) message += t('modal.provider.healthCheck.abnormal', { fail: failCount });
            if (skippedCount > 0) message += t('modal.provider.healthCheck.skipped', { skipped: skippedCount });
            
            showToast(t('common.info'), message, failCount > 0 ? 'warning' : 'success');
            
            // 只有当有节点从不健康恢复为健康时，才需要重新加载配置以刷新适配器实例
            if (successCount > 0) {
                console.log(`[UI] ${successCount} node(s) recovered, reloading configuration...`);
                await window.apiClient.post('/reload-config');
            }
            
            // 无论如何都要刷新显示
            await refreshProviderConfig(providerType);
        } else {
            showToast(t('common.error'), t('modal.provider.healthCheck') + ' ' + t('common.error'), 'error');
        }
    } catch (error) {
        console.error('健康检测失败:', error);
        showToast(t('common.error'), t('modal.provider.healthCheck') + ' ' + t('common.error') + ': ' + error.message, 'error');
    }
}

/**
 * 刷新提供商UUID
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
async function performSingleHealthCheck(uuid, event) {
    event.stopPropagation();

    const button = event.currentTarget || event.target.closest('button');
    const providerDetail = event.target.closest('.provider-item-detail, .provider-item-card');
    const providerType = providerDetail?.closest('.provider-modal')?.getAttribute('data-provider-type');

    if (!providerDetail || !providerType) {
        showToast(t('common.error'), t('modal.provider.healthCheckSingleFailed', { message: t('common.error') }), 'error');
        return;
    }

    const originalHtml = button ? button.innerHTML : '';

    try {
        if (button) {
            button.disabled = true;
            button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> <span>${t('modal.provider.healthCheck')}</span>`;
        }

        showToast(t('common.info'), t('modal.provider.healthCheck') + '...', 'info');

        const isCurrentlyHealthy = providerDetail.classList.contains('healthy');

        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/${uuid}/health-check`,
            {}
        );

        if (!response.success) {
            showToast(t('common.error'), t('modal.provider.healthCheckSingleFailed', { message: t('common.error') }), 'error');
            return;
        }

        const message = response.healthy
            ? (response.modelName
                ? t('modal.provider.healthCheckSingleSuccessWithModel', { model: response.modelName })
                : t('modal.provider.healthCheckSingleSuccess'))
            : t('modal.provider.healthCheckSingleFailed', { message: response.message || t('common.error') });

        showToast(
            response.healthy ? t('common.success') : t('common.warning'),
            message,
            response.healthy ? 'success' : 'warning'
        );

        // 只有当健康状态确实发生变化时才重新加载配置
        if (isCurrentlyHealthy !== response.healthy) {
            console.log(`[UI] Provider ${uuid} health status changed (from ${isCurrentlyHealthy} to ${response.healthy}), reloading configuration...`);
            await window.apiClient.post('/reload-config');
        }
        
        await refreshProviderConfig(providerType);
    } catch (error) {
        console.error('Single provider health check failed:', error);
        showToast(
            t('common.error'),
            t('modal.provider.healthCheckSingleFailed', { message: error.message }),
            'error'
        );
    } finally {
        if (button && button.isConnected) {
            button.innerHTML = originalHtml;
            button.disabled = false;
        }
    }
}

async function refreshProviderUuid(uuid, event) {
    event.stopPropagation();
    
    if (!confirm(t('modal.provider.refreshUuidConfirm', { oldUuid: uuid }))) {
        return;
    }
    
    const providerDetail = event.target.closest('.provider-item-detail, .provider-item-card');
    const providerType = providerDetail.closest('.provider-modal').getAttribute('data-provider-type');
    
    try {
        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/${uuid}/refresh-uuid`,
            {}
        );
        
        if (response.success) {
            showToast(t('common.success'), t('modal.provider.refreshUuid.success', { oldUuid: response.oldUuid, newUuid: response.newUuid }), 'success');
            
            // 重新加载配置
            await window.apiClient.post('/reload-config');
            
            // 刷新提供商配置显示
            await refreshProviderConfig(providerType);
        } else {
            showToast(t('common.error'), t('modal.provider.refreshUuid.failed'), 'error');
        }
    } catch (error) {
        console.error('刷新uuid失败:', error);
        showToast(t('common.error'), t('modal.provider.refreshUuid.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 删除所有不健康的提供商节点
 * @param {string} providerType - 提供商类型
 */
async function deleteUnhealthyProviders(providerType) {
    // 先获取不健康节点数量
    const unhealthyCount = currentProviders.filter(p => !p.isHealthy).length;
    
    if (unhealthyCount === 0) {
        showToast(t('common.info'), t('modal.provider.deleteUnhealthy.noUnhealthy'), 'info');
        return;
    }
    
    if (!confirm(t('modal.provider.deleteUnhealthyConfirm', { type: providerType, count: unhealthyCount }))) {
        return;
    }
    
    try {
        showToast(t('common.info'), t('modal.provider.deleteUnhealthy.deleting'), 'info');
        
        const response = await window.apiClient.delete(
            `/providers/${encodeURIComponent(providerType)}/delete-unhealthy`
        );
        
        if (response.success) {
            showToast(
                t('common.success'),
                t('modal.provider.deleteUnhealthy.success', { count: response.deletedCount }),
                'success'
            );
            
            // 重新加载配置
            await window.apiClient.post('/reload-config');
            
            // 刷新提供商配置显示
            await refreshProviderConfig(providerType);
        } else {
            showToast(t('common.error'), t('modal.provider.deleteUnhealthy.failed'), 'error');
        }
    } catch (error) {
        console.error('删除不健康节点失败:', error);
        showToast(t('common.error'), t('modal.provider.deleteUnhealthy.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 批量刷新不健康节点的UUID
 * @param {string} providerType - 提供商类型
 */
async function refreshUnhealthyUuids(providerType) {
    // 先获取不健康节点数量
    const unhealthyCount = currentProviders.filter(p => !p.isHealthy).length;
    
    if (unhealthyCount === 0) {
        showToast(t('common.info'), t('modal.provider.refreshUnhealthyUuids.noUnhealthy'), 'info');
        return;
    }
    
    if (!confirm(t('modal.provider.refreshUnhealthyUuidsConfirm', { type: providerType, count: unhealthyCount }))) {
        return;
    }
    
    try {
        showToast(t('common.info'), t('modal.provider.refreshUnhealthyUuids.refreshing'), 'info');
        
        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/refresh-unhealthy-uuids`
        );
        
        if (response.success) {
            showToast(
                t('common.success'),
                t('modal.provider.refreshUnhealthyUuids.success', { count: response.refreshedCount }),
                'success'
            );
            
            // 重新加载配置
            await window.apiClient.post('/reload-config');
            
            // 刷新提供商配置显示
            await refreshProviderConfig(providerType);
        } else {
            showToast(t('common.error'), t('modal.provider.refreshUnhealthyUuids.failed'), 'error');
        }
    } catch (error) {
        console.error('刷新不健康节点UUID失败:', error);
        showToast(t('common.error'), t('modal.provider.refreshUnhealthyUuids.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 渲染不支持的模型选择器（不调用API，直接使用传入的模型列表）
 * @param {string} uuid - 提供商UUID
 * @param {Array} models - 模型列表
 * @param {Array} notSupportedModels - 当前不支持的模型列表
 */
function renderNotSupportedModelsSelector(uuid, models, notSupportedModels = []) {
    const container = document.querySelector(`.not-supported-models-container[data-uuid="${uuid}"]`);
    if (!container) return;
    
    if (models.length === 0) {
        container.innerHTML = `<div class="no-models" data-i18n="modal.provider.noModels">${t('modal.provider.noModels')}</div>`;
        return;
    }
    
    // 渲染模型复选框列表
    let html = '<div class="models-checkbox-grid">';
    models.forEach(model => {
        const isChecked = notSupportedModels.includes(model);
        html += `
            <label class="model-checkbox-label">
                <input type="checkbox"
                       class="model-checkbox"
                       value="${model}"
                       data-uuid="${uuid}"
                       ${isChecked ? 'checked' : ''}
                       disabled>
                <span class="model-name">${model}</span>
            </label>
        `;
    });
    html += '</div>';
    
    container.innerHTML = html;
}

// 导出所有函数，并挂载到window对象供HTML调用
export {
    showProviderManagerModal,
    closeProviderModal,
    toggleProviderDetails,
    editProvider,
    cancelEdit,
    saveProvider,
    deleteProvider,
    refreshProviderConfig,
    showAddProviderForm,
    addProvider,
    toggleProviderStatus,
    resetAllProvidersHealth,
    performHealthCheck,
    performHealthCheckAll,
    performHealthCheckAllIncludingDisabled,
    exportKiroRefreshTokens,
    updateKiroStableNames,
    autoAssignProviderProxies,
    showKiroBatchImportFromProviderConsole,
    showKiroAwsImportFromProviderConsole,
    toggleKiroProviderSelection,
    toggleKiroProviderSelectAll,
    clearKiroProviderSelection,
    refreshKiroUsage,
    refreshSelectedKiroUsage,
    refreshSingleKiroUsage,
    performSelectedKiroHealthCheck,
    resetSelectedKiroProvidersHealth,
    resetSingleKiroProviderHealth,
    setSelectedKiroProvidersDisabled,
    deleteSelectedKiroProviders,
    deleteUnhealthyProviders,
    refreshUnhealthyUuids,
    openSupportedModelsPicker,
    loadModelsForProviderType,
    renderNotSupportedModelsSelector,
    goToProviderPage,
    performSingleHealthCheck,
    refreshProviderUuid
};

// 将函数挂载到window对象
window.closeProviderModal = closeProviderModal;
window.toggleProviderDetails = toggleProviderDetails;
window.editProvider = editProvider;
window.cancelEdit = cancelEdit;
window.saveProvider = saveProvider;
window.deleteProvider = deleteProvider;
window.showAddProviderForm = showAddProviderForm;
window.addProvider = addProvider;
window.toggleProviderStatus = toggleProviderStatus;
window.resetAllProvidersHealth = resetAllProvidersHealth;
window.performHealthCheck = performHealthCheck;
window.performHealthCheckAll = performHealthCheckAll;
window.performHealthCheckAllIncludingDisabled = performHealthCheckAllIncludingDisabled;
window.exportKiroRefreshTokens = exportKiroRefreshTokens;
window.updateKiroStableNames = updateKiroStableNames;
window.autoAssignProviderProxies = autoAssignProviderProxies;
window.showKiroBatchImportFromProviderConsole = showKiroBatchImportFromProviderConsole;
window.showKiroAwsImportFromProviderConsole = showKiroAwsImportFromProviderConsole;
window.toggleKiroProviderSelection = toggleKiroProviderSelection;
window.toggleKiroProviderSelectAll = toggleKiroProviderSelectAll;
window.clearKiroProviderSelection = clearKiroProviderSelection;
window.refreshKiroUsage = refreshKiroUsage;
window.refreshSelectedKiroUsage = refreshSelectedKiroUsage;
window.refreshSingleKiroUsage = refreshSingleKiroUsage;
window.performSelectedKiroHealthCheck = performSelectedKiroHealthCheck;
window.resetSelectedKiroProvidersHealth = resetSelectedKiroProvidersHealth;
window.resetSingleKiroProviderHealth = resetSingleKiroProviderHealth;
window.setSelectedKiroProvidersDisabled = setSelectedKiroProvidersDisabled;
window.deleteSelectedKiroProviders = deleteSelectedKiroProviders;
window.performSingleHealthCheck = performSingleHealthCheck;
window.deleteUnhealthyProviders = deleteUnhealthyProviders;
window.refreshUnhealthyUuids = refreshUnhealthyUuids;
window.openSupportedModelsPicker = openSupportedModelsPicker;
window.goToProviderPage = goToProviderPage;
window.refreshProviderUuid = refreshProviderUuid;
