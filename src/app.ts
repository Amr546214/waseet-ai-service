import Fastify, { type FastifyInstance } from "fastify";
import { TenantAuthService } from "./core/auth/tenant-auth.service.js";
import { tenantStorage, assertPrivileged } from "./core/auth/tenant-context.js";
import { clientProjectRoutes } from "./features/client-projects/routes.js";
import { assessmentRoutes } from "./features/assessments/routes.js";
import { proposalRoutes } from "./features/proposals/routes.js";
import { providerRoutes } from "./features/providers/routes.js";
import { marketplaceRoutes } from "./features/marketplace/routes.js";
import { identityRoutes } from "./features/identity/routes.js";
import { disputeRoutes } from "./features/disputes/routes.js";
import { businessModelRoutes } from "./features/business-models/routes.js";
import { avatarRoutes } from "./features/avatar/routes.js";
import { helpRoutes } from "./features/help/routes.js";
import { dataIngestionRoutes } from "./features/data-ingestion/routes.js";
import { ttsRoutes } from "./features/tts/routes.js";
import { beboRoutes } from "./features/bebo/routes.js";
import { runtimeRoutes } from "./runtime/routes.js";
import { legacyAdapterRoutes } from "./bridge/legacy-adapter.js";
import { env } from "./core/config/env.js";
import { z } from "zod";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: false,
  });

  // Health check
  app.get("/health", async () => {
    return {
      status: "healthy",
      service: "waseet-ai-service",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
    };
  });

  // Backend-only exchange; the bootstrap credential itself is never an access token.
  app.post("/v1/auth/token", async (request) => TenantAuthService.issue(request.body));
  app.get("/ready", async (_request, reply) => {
    const authReady = env.WASEET_AI_CLIENT_SECRET.length >= 32 && (env.WASEET_AI_TOKEN_SIGNING_SECRET || env.WASEET_AI_CLIENT_SECRET).length >= 32;
    const storageReady = process.env.WASEET_AI_DISTRIBUTED !== "true" && process.env.WASEET_AI_DISTRIBUTED_REPLICAS !== "true" && (!process.env.K_SERVICE || process.env.WASEET_AI_DURABLE_VOLUME === "true");
    return reply.status(authReady && storageReady ? 200 : 503).send({ ready: authReady && storageReady, authentication: authReady ? "configured" : "configuration_required", storage: storageReady ? "sqlite_persistent_volume_required" : "shared_storage_required" });
  });

  // Enable CORS for frontend clients (e.g. playground dashboard)
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const allowed = env.WASEET_AI_ALLOWED_ORIGINS.split(",").map(item => item.trim()).filter(Boolean);
    if (origin && !allowed.includes(origin)) return reply.status(403).send({ success: false, error: { code: "ORIGIN_BLOCKED", message: "Origin is not approved." } });
    if (origin) { reply.raw.setHeader("Access-Control-Allow-Origin", origin); reply.header("Access-Control-Allow-Origin", origin); reply.header("Vary", "Origin"); }
    reply.raw.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    reply.raw.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    if (request.method === "OPTIONS") {
      reply.raw.statusCode = 204;
      reply.raw.end();
      return;
    }
  });

  // Propagate authenticated tenant identity across asynchronous tool/model/storage calls.
  app.addHook("preHandler", (request, reply, done) => {
    if (request.method === "OPTIONS" || request.url === "/health" || request.url === "/ready" || request.url === "/v1/auth/token" || (request.routeOptions.config as {beboPublic?:boolean}).beboPublic === true) {
      done(); return;
    }
    void TenantAuthService.authenticate(request, reply).then(context => {
      if (!context) return;
      const cancellation = new AbortController();
      const abort = () => { if (!reply.raw.writableEnded) cancellation.abort(Object.assign(new Error("Request disconnected."), { code: "CANCELLED", statusCode: 499 })); };
      request.raw.once("aborted", abort); reply.raw.once("close", abort);
      reply.raw.once("finish", () => { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", abort); });
      context.signal = cancellation.signal;
      tenantStorage.run(context, () => {
        try {
          if (request.url.startsWith("/v1/data/") || request.url.startsWith("/v1/knowledge/") && request.routeOptions.url !== "/v1/knowledge/search") assertPrivileged();
          done();
        } catch (error) { done(error as Error); }
      });
    }).catch(error => done(error));
  });

  // Custom Error Handler for Zod Validation
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues,
        },
      });
    }
    const err = error as { statusCode?: number; code?: string; message?: string };
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    return reply.status(statusCode).send({
      success: false,
      error: {
        code: err.code ?? "INTERNAL_ERROR",
        message: statusCode >= 500 && !err.code ? "An unexpected error occurred" : err.message ?? "An unexpected error occurred",
      },
    });
  });

  // Register Feature Slices
  app.register(clientProjectRoutes);
  app.register(assessmentRoutes);
  app.register(proposalRoutes);
  app.register(providerRoutes);
  app.register(marketplaceRoutes);
  app.register(disputeRoutes);
  app.register(identityRoutes);
  app.register(businessModelRoutes);
  app.register(avatarRoutes);
  app.register(helpRoutes);
  app.register(dataIngestionRoutes);
  app.register(ttsRoutes);
  app.register(beboRoutes);
  app.register(runtimeRoutes);
  app.register(legacyAdapterRoutes);

  return app;
}
