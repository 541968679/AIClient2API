import {
    assignProxyToProviderConfig,
    countProxyAssignments,
    isRedactedProxyUrl,
    parseProxyLine,
    parseSubscriptionContent,
    pickProxyFromPool
} from '../src/utils/proxy-registry.js';

describe('proxy-registry', () => {
    test('parses direct proxy URLs with auth', () => {
        const proxy = parseProxyLine('socks5://user:p%40ss@127.0.0.1:1080');
        expect(proxy.protocol).toBe('socks5');
        expect(proxy.host).toBe('127.0.0.1');
        expect(proxy.port).toBe(1080);
        expect(proxy.username).toBe('user');
        expect(proxy.password).toBe('p@ss');
    });

    test('rejects direct proxy URL without explicit port', () => {
        expect(() => parseProxyLine('http://127.0.0.1')).toThrow('Proxy port is required');
    });

    test('detects redacted proxy URL placeholders', () => {
        expect(isRedactedProxyUrl('http://******:******@127.0.0.1:7890/')).toBe(true);
        expect(isRedactedProxyUrl('http://user:pass@127.0.0.1:7890/')).toBe(false);
    });

    test('parses socks5h proxy URLs for import', () => {
        const proxy = parseProxyLine('socks5h://127.0.0.1:1080');
        expect(proxy.protocol).toBe('socks5h');
        expect(proxy.host).toBe('127.0.0.1');
        expect(proxy.port).toBe(1080);
    });

    test('counts provider proxy assignments excluding disabled nodes', () => {
        const counts = countProxyAssignments({
            'gemini-cli-oauth': [
                { uuid: 'a', proxyId: 'p1' },
                { uuid: 'b', proxyId: 'p1', isDisabled: true },
                { uuid: 'c', proxyId: 'p2' }
            ]
        });
        expect(counts).toEqual({ p1: 1, p2: 1 });
    });

    test('picks least used enabled pool proxy', () => {
        const proxies = [
            { id: 'p1', name: 'p1', protocol: 'http', host: '127.0.0.1', port: 1001, enabled: true, poolEnabled: true },
            { id: 'p2', name: 'p2', protocol: 'http', host: '127.0.0.1', port: 1002, enabled: true, poolEnabled: true }
        ];
        const picked = pickProxyFromPool(proxies, { p1: 5, p2: 1 });
        expect(picked.id).toBe('p2');
    });

    test('assigns selected proxy and increments local count', () => {
        const provider = { uuid: 'node1' };
        const counts = { p1: 0 };
        const selected = assignProxyToProviderConfig(provider, [
            { id: 'p1', name: 'p1', protocol: 'http', host: '127.0.0.1', port: 7890, enabled: true, poolEnabled: true }
        ], counts);
        expect(selected.id).toBe('p1');
        expect(provider.proxyId).toBe('p1');
        expect(counts.p1).toBe(1);
    });

    test('parses base64 subscription content into local http endpoints', () => {
        const raw = 'vless://uuid@example.com:443?security=tls&type=ws&host=example.com&path=%2F#CDN-US-1';
        const content = Buffer.from(raw).toString('base64');
        const proxies = parseSubscriptionContent(content, { keyword: 'US', startPort: 11001, localHost: 'a2-proxy' });
        expect(proxies).toHaveLength(1);
        expect(proxies[0].name).toBe('CDN-US-1');
        expect(proxies[0].localUrl).toBe('http://a2-proxy:11001');
        expect(proxies[0].upstreamType).toBe('vless');
    });
});
