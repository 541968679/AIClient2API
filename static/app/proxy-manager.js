import { showToast, escapeHtml } from './utils.js';
import { t } from './i18n.js';

let proxies = [];
let searchTerm = '';
let initialized = false;

function proxyUrl(proxy) {
    return proxy.url || proxy.localUrl || `${proxy.protocol}://${proxy.host}:${proxy.port || ''}`;
}

function formatCheck(proxy) {
    if (proxy.latencyMs || proxy.exitIp) {
        return `
            <div class="proxy-check-cell">
                <div>${proxy.latencyMs ? `${proxy.latencyMs}ms` : '-'}</div>
                <small>${escapeHtml(proxy.exitIp || '')}</small>
            </div>
        `;
    }
    if (proxy.lastError) {
        return `<div class="proxy-check-cell"><small title="${escapeHtml(proxy.lastError)}">${escapeHtml(proxy.lastError)}</small></div>`;
    }
    return '<span class="muted">-</span>';
}

function filteredProxies() {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return proxies;
    return proxies.filter(proxy => [
        proxy.name,
        proxy.protocol,
        proxy.host,
        proxy.localUrl,
        proxy.upstreamType,
        proxy.exitIp,
        ...(proxy.tags || [])
    ].some(value => value && String(value).toLowerCase().includes(term)));
}

function updateSummary() {
    const total = proxies.length;
    const pool = proxies.filter(proxy => proxy.poolEnabled && proxy.enabled).length;
    const assigned = proxies.reduce((sum, proxy) => sum + (proxy.assignedCount || 0), 0);
    const subscription = proxies.filter(proxy => proxy.sourceType === 'subscription').length;
    const summaryValues = {
        proxiesTotalCount: total,
        proxiesPoolCount: pool,
        proxiesAssignedCount: assigned,
        proxiesSubscriptionCount: subscription
    };
    Object.entries(summaryValues).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value;
        }
    });
}

function renderTable() {
    const tbody = document.getElementById('proxiesTableBody');
    if (!tbody) return;
    const rows = filteredProxies();
    updateSummary();

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="proxies-empty">${escapeHtml(t('common.noResults'))}</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(proxy => {
        const address = proxyUrl(proxy);
        const source = proxy.sourceType === 'subscription'
            ? `${proxy.upstreamType || 'subscription'} -> ${proxy.localUrl || ''}`
            : (proxy.host && proxy.port ? `${proxy.host}:${proxy.port}` : address);
        return `
            <tr>
                <td>
                    <div class="proxy-name-cell">
                        <strong>${escapeHtml(proxy.name || proxy.id)}</strong>
                        <small>${escapeHtml(proxy.id)}</small>
                    </div>
                </td>
                <td>
                    <span class="proxy-badge pool">${escapeHtml((proxy.protocol || '').toUpperCase())}</span>
                </td>
                <td>
                    <div class="proxy-address-cell">
                        <code title="${escapeHtml(address)}">${escapeHtml(address)}</code>
                        <small>${escapeHtml(source)}</small>
                    </div>
                </td>
                <td>
                    <span class="proxy-badge ${proxy.enabled ? 'active' : 'inactive'}">
                        ${proxy.enabled ? escapeHtml(t('proxies.enabled')) : escapeHtml(t('proxies.disabled'))}
                    </span>
                    ${proxy.poolEnabled ? `<span class="proxy-badge pool">${escapeHtml(t('proxies.inPool'))}</span>` : ''}
                </td>
                <td>${proxy.assignedCount || 0}</td>
                <td>${formatCheck(proxy)}</td>
                <td>
                    <div class="proxy-row-actions">
                        <button data-action="test" data-id="${proxy.id}" title="${escapeHtml(t('proxies.test'))}">
                            <i class="fas fa-stethoscope"></i>
                        </button>
                        <button data-action="edit" data-id="${proxy.id}" title="${escapeHtml(t('common.edit'))}">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="danger" data-action="delete" data-id="${proxy.id}" title="${escapeHtml(t('common.delete'))}">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function loadProxies() {
    try {
        const data = await window.apiClient.get('/proxies');
        proxies = data.proxies || [];
        renderTable();
    } catch (error) {
        console.error('Failed to load proxies:', error);
        showToast(t('common.error'), error.message, 'error');
    }
}

function closeModal(modal) {
    modal.remove();
}

function readFileAsText(file) {
    if (typeof file.text === 'function') {
        return file.text();
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsText(file);
    });
}

function parseMaybeJsonImport(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
        return null;
    }
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return null;
    }
    return JSON.parse(trimmed);
}

function showProxyForm(proxy = null) {
    const isEdit = !!proxy;
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 620px;">
            <div class="modal-header">
                <h3><i class="fas fa-route"></i> ${escapeHtml(isEdit ? t('proxies.edit') : t('proxies.add'))}</h3>
                <button class="modal-close" type="button">&times;</button>
            </div>
            <div class="modal-body">
                <div class="proxy-form-grid">
                    <label class="full">
                        ${escapeHtml(t('proxies.url'))}
                        <input id="proxyFormUrl" value="${escapeHtml(proxy ? proxyUrl(proxy) : '')}" placeholder="http://user:pass@127.0.0.1:7890">
                    </label>
                    <label>
                        ${escapeHtml(t('proxies.name'))}
                        <input id="proxyFormName" value="${escapeHtml(proxy?.name || '')}">
                    </label>
                    <label>
                        ${escapeHtml(t('proxies.poolEnabled'))}
                        <select id="proxyFormPool">
                            <option value="true" ${proxy?.poolEnabled !== false ? 'selected' : ''}>${escapeHtml(t('proxies.inPool'))}</option>
                            <option value="false" ${proxy?.poolEnabled === false ? 'selected' : ''}>${escapeHtml(t('proxies.outPool'))}</option>
                        </select>
                    </label>
                    <label>
                        ${escapeHtml(t('proxies.status'))}
                        <select id="proxyFormEnabled">
                            <option value="true" ${proxy?.enabled !== false ? 'selected' : ''}>${escapeHtml(t('proxies.enabled'))}</option>
                            <option value="false" ${proxy?.enabled === false ? 'selected' : ''}>${escapeHtml(t('proxies.disabled'))}</option>
                        </select>
                    </label>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary modal-cancel" type="button">${escapeHtml(t('common.cancel'))}</button>
                <button class="btn btn-primary modal-submit" type="button">${escapeHtml(t('common.save'))}</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('.modal-close').onclick = () => closeModal(modal);
    modal.querySelector('.modal-cancel').onclick = () => closeModal(modal);
    modal.querySelector('.modal-submit').onclick = async () => {
        const payload = {
            url: modal.querySelector('#proxyFormUrl').value.trim(),
            name: modal.querySelector('#proxyFormName').value.trim(),
            poolEnabled: modal.querySelector('#proxyFormPool').value === 'true',
            enabled: modal.querySelector('#proxyFormEnabled').value === 'true'
        };
        try {
            if (isEdit) {
                await window.apiClient.put(`/proxies/${encodeURIComponent(proxy.id)}`, payload);
            } else {
                await window.apiClient.post('/proxies', payload);
            }
            closeModal(modal);
            await loadProxies();
            showToast(t('common.success'), t('proxies.saved'), 'success');
        } catch (error) {
            showToast(t('common.error'), error.message, 'error');
        }
    };
}

function showImportModal(kind = 'direct') {
    const isSubscription = kind === 'subscription';
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 720px;">
            <div class="modal-header">
                <h3><i class="fas fa-file-import"></i> ${escapeHtml(isSubscription ? t('proxies.importSubscription') : t('proxies.import'))}</h3>
                <button class="modal-close" type="button">&times;</button>
            </div>
            <div class="modal-body">
                ${isSubscription ? `
                    <div class="proxy-form-grid">
                        <label>
                            ${escapeHtml(t('proxies.keyword'))}
                            <input id="proxyImportKeyword" value="US" placeholder="US">
                        </label>
                        <label>
                            ${escapeHtml(t('proxies.startPort'))}
                            <input id="proxyImportStartPort" type="number" value="11001">
                        </label>
                    </div>
                ` : ''}
                ${!isSubscription ? `
                    <label class="proxy-import-file">
                        <span>${escapeHtml(t('proxies.importJsonFile'))}</span>
                        <input id="proxyImportFile" type="file" accept="application/json,.json">
                    </label>
                    <p class="proxy-import-hint">${escapeHtml(t('proxies.importJsonHint'))}</p>
                ` : ''}
                <textarea class="proxy-modal-textarea" id="proxyImportText" placeholder="${escapeHtml(isSubscription ? t('proxies.subscriptionPlaceholder') : t('proxies.importPlaceholder'))}"></textarea>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary modal-cancel" type="button">${escapeHtml(t('common.cancel'))}</button>
                <button class="btn btn-primary modal-submit" type="button">${escapeHtml(t('proxies.import'))}</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('.modal-close').onclick = () => closeModal(modal);
    modal.querySelector('.modal-cancel').onclick = () => closeModal(modal);
    modal.querySelector('#proxyImportFile')?.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            modal.querySelector('#proxyImportText').value = await readFileAsText(file);
        } catch (error) {
            showToast(t('common.error'), error.message, 'error');
        }
    });
    modal.querySelector('.modal-submit').onclick = async () => {
        const text = modal.querySelector('#proxyImportText').value.trim();
        if (!text) {
            showToast(t('common.warning'), t('proxies.emptyImport'), 'warning');
            return;
        }
        try {
            let payload;
            if (isSubscription) {
                payload = {
                    [text.startsWith('http://') || text.startsWith('https://') ? 'subscriptionUrl' : 'content']: text,
                    keyword: modal.querySelector('#proxyImportKeyword')?.value.trim() || '',
                    startPort: parseInt(modal.querySelector('#proxyImportStartPort')?.value || '11001', 10)
                };
            } else {
                const jsonPayload = parseMaybeJsonImport(text);
                payload = jsonPayload === null ? { text } : { data: jsonPayload };
            }
            const endpoint = isSubscription ? '/proxies/import-subscription' : '/proxies/import';
            const result = await window.apiClient.post(endpoint, payload);
            closeModal(modal);
            await loadProxies();
            showToast(t('common.success'), t('proxies.importResult', result), 'success');
        } catch (error) {
            showToast(t('common.error'), error.message, 'error');
        }
    };
}

async function handleRowAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const proxy = proxies.find(item => item.id === button.dataset.id);
    if (!proxy) return;

    if (button.dataset.action === 'edit') {
        showProxyForm(proxy);
        return;
    }

    if (button.dataset.action === 'delete') {
        if (!confirm(t('proxies.deleteConfirm'))) return;
        try {
            await window.apiClient.delete(`/proxies/${encodeURIComponent(proxy.id)}?force=true`);
            await loadProxies();
            showToast(t('common.success'), t('proxies.deleted'), 'success');
        } catch (error) {
            showToast(t('common.error'), error.message, 'error');
        }
        return;
    }

    if (button.dataset.action === 'test') {
        button.disabled = true;
        try {
            const result = await window.apiClient.post(`/proxies/${encodeURIComponent(proxy.id)}/test`);
            await loadProxies();
            const message = result.success
                ? `${t('proxies.testOk')} ${result.latencyMs || '-'}ms ${result.exitIp || ''}`
                : `${t('proxies.testFailed')}: ${result.error || ''}`;
            showToast(result.success ? t('common.success') : t('common.warning'), message, result.success ? 'success' : 'warning');
        } catch (error) {
            showToast(t('common.error'), error.message, 'error');
        } finally {
            button.disabled = false;
        }
    }
}

async function showSingBoxConfig() {
    try {
        const result = await window.apiClient.get('/proxies/sing-box-config');
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 820px;">
                <div class="modal-header">
                    <h3><i class="fas fa-code"></i> ${escapeHtml(t('proxies.singBox'))}</h3>
                    <button class="modal-close" type="button">&times;</button>
                </div>
                <div class="modal-body">
                    <textarea class="proxy-modal-textarea" readonly style="min-height: 420px;">${escapeHtml(JSON.stringify(result.config, null, 2))}</textarea>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary modal-cancel" type="button">${escapeHtml(t('common.close'))}</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('.modal-close').onclick = () => closeModal(modal);
        modal.querySelector('.modal-cancel').onclick = () => closeModal(modal);
    } catch (error) {
        showToast(t('common.error'), error.message, 'error');
    }
}

function bindEvents() {
    document.getElementById('refreshProxiesBtn')?.addEventListener('click', loadProxies);
    document.getElementById('addProxyBtn')?.addEventListener('click', () => showProxyForm());
    document.getElementById('importProxiesBtn')?.addEventListener('click', () => showImportModal('direct'));
    document.getElementById('importSubscriptionBtn')?.addEventListener('click', () => showImportModal('subscription'));
    document.getElementById('generateSingBoxBtn')?.addEventListener('click', showSingBoxConfig);
    document.getElementById('proxySearchInput')?.addEventListener('input', event => {
        searchTerm = event.target.value;
        renderTable();
    });
    document.getElementById('proxiesTableBody')?.addEventListener('click', handleRowAction);
}

export function initProxyManager() {
    if (initialized) return;
    initialized = true;
    bindEvents();
}

export async function loadProxiesPageData() {
    initProxyManager();
    await loadProxies();
}
