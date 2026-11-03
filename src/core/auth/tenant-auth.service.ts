import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { DurableStore } from "../database/durable-store.js";
import { featureError } from "../security/model-output.js";
import { tenantStorage, type TenantContext } from "./tenant-context.js";
export type { AuthenticatedActor, TenantContext } from "./tenant-context.js";

const actorSchema = z.object({ userId: z.string().trim().min(1).max(200), role: z.enum(["client", "provider", "marketer", "admin", "system"]) }).strict();
const claimsSchema = z.object({
  clientId: z.string().min(1), environment: z.enum(["dev", "bank", "prod"]), actor: actorSchema,
  scopes: z.array(z.string()), iat: z.number().int(), exp: z.number().int(), jti: z.string().uuid(), aud: z.literal("waseet-ai"),
});
export const TokenExchangeSchema = z.object({
  clientId: z.string().min(1).max(200), clientSecret: z.string().min(1).max(1000),
  environment: z.enum(["dev", "bank", "prod"]).default("dev"), actor: actorSchema,
}).strict();

export class TenantAuthService {
  private static compare(a: string, b: string): boolean {
    const first = Buffer.from(a), second = Buffer.from(b);
    return first.length === second.length && timingSafeEqual(first, second);
  }
  private static signingSecret(): string {
    const secret = env.WASEET_AI_TOKEN_SIGNING_SECRET || env.WASEET_AI_CLIENT_SECRET;
    if (secret.length < 32 || env.WASEET_AI_CLIENT_SECRET.length < 32) throw featureError("AUTH_NOT_CONFIGURED", "Service authentication has not been securely configured.");
    return secret;
  }
  public static issue(body: unknown): { success: true; token: string; tokenType: "Bearer"; expiresIn: number; environment: string } {
    const input = TokenExchangeSchema.parse(body);
    const secret = this.signingSecret();
    if (input.environment !== env.WASEET_AI_ENVIRONMENT || input.clientId !== env.WASEET_AI_CLIENT_ID || !this.compare(input.clientSecret, env.WASEET_AI_CLIENT_SECRET)) {
      throw featureError("AUTH_INVALID", "Invalid client credential or environment.", 401);
    }
    const now = Math.floor(Date.now() / 1000), expiresIn = 900;
    const scopes = ["ai:read", "ai:generate"];
    if ((input.actor.role === "system" && input.actor.userId !== "service-reader") || input.actor.role === "admin") scopes.push("data:write", "knowledge:write", "assessment:admin");
    const claims = { clientId: input.clientId, environment: input.environment, actor: input.actor, scopes, iat: now, exp: now + expiresIn, jti: randomUUID(), aud: "waseet-ai" };
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const content = `${header}.${payload}`;
    const signature = createHmac("sha256", secret).update(content).digest("base64url");
    return { success: true, token: `${content}.${signature}`, tokenType: "Bearer", expiresIn, environment: input.environment };
  }
  public static async authenticate(request: FastifyRequest, reply: FastifyReply): Promise<TenantContext | void> {
    const requestId = typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"].slice(0, 200) : `req-${randomUUID()}`;
    try {
      const secret = this.signingSecret();
      const auth = request.headers.authorization;
      if (!auth?.startsWith("Bearer ")) throw featureError("AUTH_REQUIRED", "An expiring Bearer token is required.", 401);
      const rawToken = auth.slice(7).trim();
      const parts = rawToken.split(".");
      // Only signed, expiring service tokens are accepted. Bootstrap secrets and
      // legacy bearer credentials must never become an alternate identity path.
      if (parts.length !== 3 || parts.some(part => !part || part.length > 8000)) throw featureError("AUTH_INVALID", "Invalid access token.", 401);
      const [header, payload, signature] = parts as [string, string, string];
      const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
      if (!this.compare(signature, expected)) throw featureError("AUTH_INVALID", "Invalid access token.", 401);
      z.object({ alg: z.literal("HS256"), typ: z.literal("JWT") }).strict().parse(JSON.parse(Buffer.from(header, "base64url").toString()));
      const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
      const now = Math.floor(Date.now() / 1000);
      if (claims.exp <= now || claims.iat > now + 30 || claims.exp - claims.iat > 900 || claims.environment !== env.WASEET_AI_ENVIRONMENT || claims.clientId !== env.WASEET_AI_CLIENT_ID) throw featureError("AUTH_EXPIRED", "Token expired or belongs to another environment.", 401);
      const claimedClient = request.headers["x-client-id"];
      if (claimedClient && claimedClient !== claims.clientId) throw featureError("AUTH_INVALID", "Client identity mismatch.", 401);
      const bodyActor = (request.body as { actor?: unknown } | undefined)?.actor;
      if (bodyActor) {
        const actor = actorSchema.parse(bodyActor);
        if (actor.userId !== claims.actor.userId || actor.role !== claims.actor.role) throw featureError("ACTOR_MISMATCH", "Request actor does not match the authenticated actor.", 403);
      }
      const context: TenantContext = { clientId: claims.clientId, environment: claims.environment, actor: claims.actor, scopes: claims.scopes, requestId };
      const revoked = tenantStorage.run(context, () => DurableStore.get<{ expiresAt: number }>("revoked-token", claims.jti));
      if (revoked && revoked.expiresAt > Date.now()) throw featureError("AUTH_REVOKED", "Access token has been revoked.", 401);
      (request as FastifyRequest & { tenantContext: TenantContext }).tenantContext = context;
      return context;
    } catch (error) {
      const known = error as { statusCode?: number; code?: string; message?: string };
      return void reply.status(known.statusCode ?? 401).send({ success: false, requestId, error: { code: known.code ?? "AUTH_INVALID", message: known.code ? known.message : "Invalid access token.", retryable: false } });
    }
  }
  public static revokeTokenId(id: string, expiresAt: number): void { DurableStore.put("revoked-token", id, { expiresAt }); }
}
