/**
 * DeepLX
 */
import { Hono } from "hono";
import {
  clearMemoryCache,
  generateCacheKey,
  getCachedTranslation,
  query,
  setCachedTranslation,
} from "./lib";
import { PAYLOAD_LIMITS } from "./lib/config";
import { createErrorResponse } from "./lib/errorHandler";
import { normalizeLanguageCode } from "./lib/query";
import {
  getSecureClientIP,
  handleCORSPreflight,
  validateLanguageCode,
} from "./lib/security";
import { translateWithGoogle } from "./lib/services/googleTranslate";
import { createStandardResponse } from "./lib/types";

const app = new Hono<{ Bindings: Env }>();

function isDebugModeEnabled(value?: string): boolean {
  if (!value) return false;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

const recentLogs: any[] = [];
const MAX_LOGS = 200;

function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(handleScheduled(event, env));
}

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  clearMemoryCache();
}

const worker = {
  fetch: app.fetch,
  scheduled,
};

export default worker;

async function logRequest(
  env: Env,
  context: {
    method: string;
    path: string;
    ip: string;
    sourceLang: string;
    targetLang: string;
    status: number;
    responseTime: number;
    error?: string;
    text?: string;
  }
) {
  let textPreview = null;
  if (context.text && typeof context.text === "string" && context.text.length > 0) {
    textPreview = context.text.substring(0, 1) + "***";
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    method: context.method,
    path: context.path,
    client_ip: context.ip || null,
    source_lang: context.sourceLang,
    target_lang: context.targetLang,
    status: context.status,
    response_time_ms: context.responseTime,
    error: context.error || null,
    text_preview: textPreview,
  };

  recentLogs.push(logEntry);
  if (recentLogs.length > MAX_LOGS) {
    recentLogs.shift();
  }

  console.log(JSON.stringify(logEntry));

  const webhookUrl = env.LOG_WEBHOOK_URL as string | undefined;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(logEntry),
      });
    } catch {
      // ignore
    }
  }
}

async function handleTranslation(c: any, provider: "deepl" | "google") {
  const env = c.env;
  const clientIP = getSecureClientIP(c.req.raw) || "unknown";

  try {
    let params;
    try {
      params = await c.req.json();
    } catch {
      return c.json(createStandardResponse(400, null), 400);
    }

    if (!params || typeof params !== "object") {
      return c.json(createStandardResponse(400, null), 400);
    }

    if (!params.text || typeof params.text !== "string") {
      return c.json(createStandardResponse(400, null), 400);
    }

    if (!params.text.trim()) {
      return c.json(createStandardResponse(400, null), 400);
    }

    let sanitizedText = params.text;
    if (sanitizedText.length > PAYLOAD_LIMITS.MAX_TEXT_LENGTH) {
      sanitizedText = sanitizedText.slice(0, PAYLOAD_LIMITS.MAX_TEXT_LENGTH);
    }

    if (!sanitizedText) {
      return c.json(createStandardResponse(400, null), 400);
    }

    const sourceLang = params.source_lang
      ? validateLanguageCode(params.source_lang)
      : "auto";
    const targetLang = params.target_lang
      ? validateLanguageCode(params.target_lang)
      : "en";

    if (!sourceLang || !targetLang) {
      return c.json(createStandardResponse(400, null), 400);
    }

    const normalizedSourceLang = normalizeLanguageCode(sourceLang);
    const normalizedTargetLang = normalizeLanguageCode(targetLang);

    const cacheKey = generateCacheKey(
      sanitizedText,
      normalizedSourceLang,
      normalizedTargetLang,
      provider
    );

    const cached = await getCachedTranslation(cacheKey, env);
    if (cached) {
      return c.json(
        createStandardResponse(
          200,
          cached.data,
          cached.id || Math.floor(Math.random() * 10000000000),
          cached.source_lang,
          cached.target_lang
        )
      );
    }

    const validatedParams = {
      text: sanitizedText,
      source_lang: normalizedSourceLang,
      target_lang: normalizedTargetLang,
    };

    let result;
    if (provider === "google") {
      result = await translateWithGoogle(validatedParams, { env, clientIP });
    } else {
      result = await query(validatedParams, { env, clientIP });
    }

    if (result.code === 200 && result.data) {
      await setCachedTranslation(
        cacheKey,
        {
          data: result.data,
          timestamp: Date.now(),
          source_lang: result.source_lang || validatedParams.source_lang.toUpperCase(),
          target_lang: result.target_lang || validatedParams.target_lang.toUpperCase(),
          id: result.id,
        },
        env
      );
    }

    return c.json(result, result.code as any);
  } catch (error) {
    const errorResponse = createErrorResponse(error, {
      endpoint: `/${provider}`,
      clientIP,
    });
    return c.json(errorResponse.response, errorResponse.httpStatus as any);
  }
}

// ============================================================
// Sharkey 专用处理函数（使用 URLSearchParams 手动解析）
// ============================================================
async function handleSharkeyTranslation(c: any) {
  const startTime = Date.now();
  const env = c.env;
  const clientIP = getSecureClientIP(c.req.raw) || "unknown";

  let requestSourceLang = "unknown";
  let requestTargetLang = "unknown";
  let status = 500;
  let errorMsg: string | undefined;
  let requestText = "";

  try {
    // 1. 获取原始请求体
    const rawBody = await c.req.text();

    // 可选：打印调试信息（可注释掉）
    console.log("=== RAW REQUEST BODY ===");
    console.log(rawBody);
    console.log("=== RAW HEADERS ===");
    const headers: Record<string, string> = {};
    for (const [key, value] of c.req.raw.headers.entries()) {
      headers[key] = value;
    }
    console.log(JSON.stringify(headers, null, 2));
    console.log("=== END RAW REQUEST ===");

    // 2. 手动解析 URL-encoded 请求体
    const params: Record<string, string> = {};
    if (rawBody) {
      const searchParams = new URLSearchParams(rawBody);
      for (const [key, value] of searchParams.entries()) {
        params[key] = value;
      }
    }

    // 3. 提取参数（兼容多种字段名）
    const text = params.text || params.q || params.content || params.input;
    const sourceLang =
      params.source_lang || params.source || params.from || params.sourceLang || "auto";
    const targetLang =
      params.target_lang || params.target || params.to || params.targetLang || "en";

    // 4. 验证文本
    if (!text || typeof text !== "string" || !text.trim()) {
      status = 400;
      errorMsg = "Missing or invalid text parameter";
      await logRequest(env, {
        method: "POST",
        path: "/deepl-sharkey",
        ip: clientIP,
        sourceLang: "auto",
        targetLang: "en",
        status,
        responseTime: Date.now() - startTime,
        error: errorMsg,
        text: text || "",
      });
      return c.json({ error: errorMsg }, 400);
    }

    const sanitizedText = text.slice(0, PAYLOAD_LIMITS.MAX_TEXT_LENGTH);
    requestText = sanitizedText;

    // 5. 处理语言代码
    function normalizeLangCode(code: string): string {
      if (!code) return "auto";
      const lower = code.toLowerCase();
      if (lower === "auto") return "auto";
      const parts = code.split("-");
      return parts[0].toUpperCase();
    }

    const normalizedSource = normalizeLangCode(sourceLang);
    const normalizedTarget = normalizeLangCode(targetLang);

    // 6. 验证语言代码（跳过 "auto"）
    const validSource =
      normalizedSource === "auto" ? "auto" : validateLanguageCode(normalizedSource);
    const validTarget =
      normalizedTarget === "auto" ? "auto" : validateLanguageCode(normalizedTarget);

    if (!validSource || !validTarget) {
      status = 400;
      errorMsg = `Invalid language codes: source=${validSource}, target=${validTarget}`;
      await logRequest(env, {
        method: "POST",
        path: "/deepl-sharkey",
        ip: clientIP,
        sourceLang: validSource || "auto",
        targetLang: validTarget || "en",
        status,
        responseTime: Date.now() - startTime,
        error: errorMsg,
        text: requestText,
      });
      return c.json({ error: errorMsg }, 400);
    }

    // 7. 最终归一化
    const finalSourceLang =
      validSource === "auto" ? "auto" : normalizeLanguageCode(validSource);
    const finalTargetLang =
      validTarget === "auto" ? "auto" : normalizeLanguageCode(validTarget);

    requestSourceLang = finalSourceLang;
    requestTargetLang = finalTargetLang;

    // 8. 缓存检查
    const cacheKey = generateCacheKey(
      sanitizedText,
      finalSourceLang,
      finalTargetLang,
      "deepl-sharkey"
    );

    const cached = await getCachedTranslation(cacheKey, env);
    if (cached) {
      status = 200;
      await logRequest(env, {
        method: "POST",
        path: "/deepl-sharkey",
        ip: clientIP,
        sourceLang: cached.source_lang || finalSourceLang,
        targetLang: cached.target_lang || finalTargetLang,
        status: 200,
        responseTime: Date.now() - startTime,
        text: requestText,
      });

      // ===== 修改点 1：缓存命中时返回 Sharkey Free Mode 格式 =====
      return c.json(
        {
          code: 200,
          data: cached.data,
          source_lang: cached.source_lang || finalSourceLang.toUpperCase(),
          target_lang: finalTargetLang.toUpperCase(),
          alternatives: [],
        },
        200
      );
    }

    // 9. 调用翻译核心
    const result = await query(
      {
        text: sanitizedText,
        source_lang: finalSourceLang,
        target_lang: finalTargetLang,
      },
      { env, clientIP }
    );

    // 10. 缓存结果
    if (result.code === 200 && result.data) {
      await setCachedTranslation(
        cacheKey,
        {
          data: result.data,
          timestamp: Date.now(),
          source_lang: result.source_lang || finalSourceLang.toUpperCase(),
          target_lang: result.target_lang || finalTargetLang.toUpperCase(),
          id: result.id,
        },
        env
      );
    }

    // 11. 返回响应
    if (result.code === 200) {
      status = 200;
      await logRequest(env, {
        method: "POST",
        path: "/deepl-sharkey",
        ip: clientIP,
        sourceLang: result.source_lang || finalSourceLang,
        targetLang: result.target_lang || finalTargetLang,
        status: 200,
        responseTime: Date.now() - startTime,
        text: requestText,
      });

      // ===== 修改点 2：实时翻译成功时返回 Sharkey Free Mode 格式 =====
      return c.json(
        {
          code: 200,
          data: result.data,
          source_lang: result.source_lang || finalSourceLang.toUpperCase(),
          target_lang: finalTargetLang.toUpperCase(),
          alternatives: result.alternatives || [],
        },
        200
      );
    } else {
      status = result.code || 500;
      errorMsg = result.data || "Translation failed";
      await logRequest(env, {
        method: "POST",
        path: "/deepl-sharkey",
        ip: clientIP,
        sourceLang: finalSourceLang,
        targetLang: finalTargetLang,
        status,
        responseTime: Date.now() - startTime,
        error: errorMsg,
        text: requestText,
      });
      return c.json({ error: errorMsg }, status);
    }
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const err = error as Error;
    errorMsg = err.message || String(error);

    console.error("=== EXCEPTION IN HANDLER ===");
    console.error(err.stack);
    console.error("Error object:", JSON.stringify(error, Object.getOwnPropertyNames(error)));
    console.error("=== END EXCEPTION ===");

    status = 500;
    await logRequest(env, {
      method: "POST",
      path: "/deepl-sharkey",
      ip: clientIP,
      sourceLang: requestSourceLang || "unknown",
      targetLang: requestTargetLang || "unknown",
      status,
      responseTime: elapsed,
      error: errorMsg,
      text: requestText,
    });
    return c.json({ error: errorMsg }, 500);
  }
}

// ============================================================
// 路由定义
// ============================================================
app
  .options("*", (c) => handleCORSPreflight(c))
  .get("/translate", (c) => c.text("Please use POST method :)"))
  .get("/deepl", (c) => c.text("Please use POST method :)"))
  .get("/google", (c) => c.text("Please use POST method :)"))
  .post("/debug", async (c) => {
    if (!isDebugModeEnabled(c.env.DEBUG_MODE)) {
      return c.json(createStandardResponse(404, null), 404);
    }
    const env = c.env;
    const clientIP = getSecureClientIP(c.req.raw) || "unknown";

    try {
      const params = await c.req.json().catch(() => ({}));
      const { buildRequestBody } = await import("./lib/query");

      if (!params.text || typeof params.text !== "string") {
        return c.json(createStandardResponse(400, "Missing text parameter"), 400);
      }

      const sanitizedText = params.text;
      if (!sanitizedText.trim()) {
        return c.json(createStandardResponse(400, "Invalid text parameter"), 400);
      }

      const sourceLang = params.source_lang
        ? validateLanguageCode(params.source_lang)
        : "auto";
      const targetLang = params.target_lang
        ? validateLanguageCode(params.target_lang)
        : "en";

      if (!sourceLang || !targetLang) {
        return c.json(createStandardResponse(400, "Invalid language codes"), 400);
      }

      const sanitizedParams = {
        text: sanitizedText,
        source_lang: sourceLang,
        target_lang: targetLang,
      };

      try {
        const requestBody = buildRequestBody(sanitizedParams);
        const parsedBody = JSON.parse(requestBody);

        const debugInfo = {
          status: "Request format is valid",
          client_ip: clientIP,
          generated_request: parsedBody,
          sanitized_params: sanitizedParams,
          validation: {
            text_length: sanitizedText.length,
            sanitized_text_length: sanitizedText.length,
            has_source_lang: !!sourceLang,
            has_target_lang: !!targetLang,
            request_id: parsedBody.id,
            timestamp: parsedBody.params?.timestamp,
            method_format: requestBody.includes('"method" : "') ? "spaced" : "normal",
            normalized_source_lang: sourceLang,
            normalized_target_lang: targetLang,
          },
        };

        return c.json(createStandardResponse(200, JSON.stringify(debugInfo)), 200);
      } catch (buildError) {
        const errorMessage =
          buildError instanceof Error ? buildError.message : "Request build failed";
        return c.json(createStandardResponse(400, errorMessage), 400);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return c.json(createStandardResponse(400, errorMessage), 400);
    }
  })
  .post("/translate", async (c) => handleTranslation(c, "deepl"))
  .post("/deepl", async (c) => handleTranslation(c, "deepl"))
  .post("/google", async (c) => handleTranslation(c, "google"))
  .post("/deepl-sharkey", async (c) => handleSharkeyTranslation(c))
  .get("/log", (c) => {
    return c.json({
      total: recentLogs.length,
      logs: recentLogs.slice().reverse(),
    });
  })
  .all("*", (c) => c.redirect("https://github.com/xixu-me/DeepLX"));
