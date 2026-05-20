import { normalizeKiroTokenResponse } from '../src/utils/kiro-token-response.js';

describe('normalizeKiroTokenResponse', () => {
    test('accepts snake_case refresh responses and falls back to the previous refresh token', () => {
        expect(normalizeKiroTokenResponse({
            access_token: 'access-snake',
            refresh_token: 'refresh-snake',
            expires_in: '1200',
            profile_arn: 'profile-snake'
        }, 'previous-refresh')).toEqual({
            accessToken: 'access-snake',
            refreshToken: 'refresh-snake',
            expiresIn: 1200,
            profileArn: 'profile-snake'
        });

        expect(normalizeKiroTokenResponse({
            accessToken: 'access-camel'
        }, 'previous-refresh').refreshToken).toBe('previous-refresh');
    });
});
