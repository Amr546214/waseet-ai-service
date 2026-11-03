import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildApp, authHeaders, TenantAuthService } from "../helpers/ai-fixtures.js";
import { env } from "../../src/core/config/env.js";
import { getTenantContext, tenantStorage } from "../../src/core/auth/tenant-context.js";
import { DurableStore } from "../../src/core/database/durable-store.js";

const app = buildApp();
app.post('/v1/test/identity', async () => getTenantContext());
before(async () => { await app.ready(); });
after(async () => { await app.close(); DurableStore.close(); });
const probe = (authorization?: string, payload: object = {}) => app.inject({ method:'POST', url:'/v1/test/identity', headers: authorization ? { authorization } : {}, payload });

for (const environment of ['dev', 'bank', 'prod'] as const) {
  test(`bare legacy credentials cannot select an admin actor in ${environment}`, async () => {
    const previous = env.WASEET_AI_ENVIRONMENT, legacy = process.env.WASEET_AI_LEGACY_DEV_TOKEN;
    env.WASEET_AI_ENVIRONMENT = environment;
    process.env.WASEET_AI_LEGACY_DEV_TOKEN = 'test-only-configured-legacy-token';
    try {
      for (const value of ['test-only-configured-legacy-token', 'arbitrary-static-token', env.WASEET_AI_CLIENT_SECRET]) {
        const response = await probe(`Bearer ${value}`, {actor:{userId:'claimed-admin',role:'admin'}});
        assert.equal(response.statusCode,401);
        assert.equal(response.json().error.code,'AUTH_INVALID');
        assert.ok(!response.body.includes(value));
      }
    } finally {
      env.WASEET_AI_ENVIRONMENT = previous;
      if (legacy === undefined) delete process.env.WASEET_AI_LEGACY_DEV_TOKEN; else process.env.WASEET_AI_LEGACY_DEV_TOKEN = legacy;
    }
  });
}
test('bootstrap exchange still issues a signed expiring actor-bound token; provider gains no write/admin scopes', async () => {
  const exchange = await app.inject({method:'POST',url:'/v1/auth/token',payload:{clientId:env.WASEET_AI_CLIENT_ID,clientSecret:env.WASEET_AI_CLIENT_SECRET,environment:'dev',actor:{userId:'real-provider',role:'provider'}}});
  assert.equal(exchange.statusCode,200);
  const issued = exchange.json(); assert.equal(issued.expiresIn,900); assert.equal(issued.token.split('.').length,3);
  const response = await probe(`Bearer ${issued.token}`); assert.equal(response.statusCode,200);
  assert.deepEqual(response.json().actor,{userId:'real-provider',role:'provider'});
  assert.deepEqual(response.json().scopes,['ai:read','ai:generate']);
  assert.equal((await probe(`Bearer ${issued.token}`,{actor:{userId:'other',role:'admin'}})).statusCode,403);
});
test('missing, empty, malformed, expired, wrong-tenant/environment and tampered tokens are refused', async () => {
  const authorization = authHeaders('signed-user','provider').authorization;
  const parts = authorization.slice(7).split('.');
  const sign = (patch: object) => {
    const claims = {...JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()),...patch};
    const body = parts[0]+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
    return 'Bearer '+body+'.'+createHmac('sha256',env.WASEET_AI_TOKEN_SIGNING_SECRET).update(body).digest('base64url');
  };
  for (const value of [undefined,'Bearer ','Bearer ..','Bearer a.b.c',sign({exp:0}),sign({environment:'bank'}),sign({clientId:'other'}),authorization.slice(0,-5)+'xxxxx']) assert.equal((await probe(value)).statusCode,401);
  assert.equal((await probe(authorization)).statusCode,200);
});
test('revoked signed tokens remain refused', async () => {
  const authorization=authHeaders('revoke-user','provider').authorization;
  const claims=JSON.parse(Buffer.from(authorization.slice(7).split('.')[1]!, 'base64url').toString());
  tenantStorage.run({clientId:env.WASEET_AI_CLIENT_ID,environment:'dev',actor:{userId:'revoke-user',role:'provider'},requestId:'test-revoke'},()=>TenantAuthService.revokeTokenId(claims.jti,Date.now()+60000));
  const response=await probe(authorization);assert.equal(response.statusCode,401);assert.equal(response.json().error.code,'AUTH_REVOKED');
});
test('production authentication contains no legacy-token environment switch or alternate bearer identity branch', () => {
  const source=readFileSync(new URL('../../src/core/auth/tenant-auth.service.ts',import.meta.url),'utf8');
  assert.ok(!source.includes('WASEET_AI_LEGACY_DEV_TOKEN'));
});
