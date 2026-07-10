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

/**
 * Initialize Hono app with environment bindings
 */
const app = new Hono<{ Bindings: Env }>();

function isDebugModeEnabled(value?: string): boolean {
  if (!value) return false;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * 内存日志存储（最多 200 条）
 */
const recentLogs: any[] = [];
const MAX_LOGS = 200;

/**
 * Scheduled event handler
 */
function scheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): void {
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

/**
 * 统一的日志函数
 * - 文本只显示首字符 + ***，保护隐私
 * - 其他信息（IP、语言、状态、耗时）完整记录
 * - 存入内存（最多 200 条），同时输出到控制台
 */
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
  // 文本脱敏：只显示第一个字符
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

  // 存入内存
  recentLogs.push(logEntry);
  if (recentLogs.length > MAX_LOGS) {
    recentLogs.shift();
  }

  // 输出到控制台（wrangler tail 可见）
  console.log(JSON.stringify(logEntry));

  // 可选外部 Webhook 转发
  const webhookUrl = env.LOG_WEBHOOK_URL as string | undefined;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(logEntry),
      });
    } catch {
      // 忽略
    }
  }
}

/**
 * 公共翻译处理函数（用于 /translate, /deepl, /google）
 */
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

/**
 * Sharkey 专用翻译处理函数
 */
async function handleSharkeyTranslation(c: any) {
  const startTime = Date.now();
  const env = c.env;
  const clientIP = getSecureClientIP(c.req.raw) || "unknown";

  let sourceLang = "unknown";
  let targetLang = "unknown";
  let status = 500;
  let errorMsg: string | undefined;
  let requestText = "";

  try {
    let params: any = {};
    const contentType = c.req.header("Content-Type") || "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const body = await c.req.parseBody();
      params = {
        text: body.text,
        source_lang: body.source_lang || body.source || body.from || "auto",
        target_lang: body.target_lang || body.target || body.to || "en",
      };
    } else {
      params = await c.req.json();
      if (params.text === undefined) {
        params.text = params.q || params.content || params.input;
      }
      if (params.source_lang === undefined) {
        params.source_lang = params.source || params.from || params.sourceLang || "auto";
      }
      if (params.target_lang === undefined) {
        params.target_lang = params.target || params.to || params.targetLang || "en";
      }
    }

    const text = params.text;
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

    const normalizeLangCode = (code: string): string => {
      if (!code || code.toLowerCase() === "auto") return code;
      const parts = code.split("-");
      return parts[0].toUpperCase();
    };

    const rawSource = params.source_lang || "auto";
    const rawTarget = params.target_lang || "en";
    const normalizedSource = normalizeLangCode(rawSource);
    const normalizedTarget = normalizeLangCode(rawTarget);

    const validSource = validateLanguageCode(normalizedSource);
    const validTarget = validateLanguageCode(normalizedTarget);
    if (!validSource || !validTarget) {
      status = 400;
      errorMsg = "Invalid language codes";
      await logRequest(env, {
        method: "POST",
        path: "/deepl-sharkey",
        ip: clientIP,
        sourceLang: normalizedSource || "auto",
        targetLang: normalizedTarget || "en",
        status,
        responseTime: Date.now() - startTime,
        error: errorMsg,
        text: requestText,
      });
      return c.json({ error: errorMsg }, 400);
    }

    const normalizedSourceLang = normalizeLanguageCode(validSource);
    const normalizedTargetLang = normalizeLanguageCode(validTarget);

    sourceLang = normalizedSourceLang;
    targetLang = normalizedTargetLang;

    const cacheKey = generateCacheKey(
      sanitizedText,
      normalizedSourceLang,
      normalizedTargetLang,
      "deepl-sharkey"
    );
    const cached = await getCachedTranslation(cacheKey, env);
    if (cached) {
      status = 200;
      await logRequest(env, {
        method: "POST",
        path: "/deepl-sharkey",
        ip: clientIP,
        sourceLang: cached.source_lang || normalizedSourceLang,
        targetLang: cached.target_lang || normalizedTargetLang,
        status: 200,
        responseTime: Date.now() - startTime,
        text: requestText,
      });
      return c.json(
        {
          translations: [
            {
              detected_source_language: cached.source_lang || normalizedSourceLang.toUpperCase(),
              text: cached.data,
            },
          ],
        },
        200
      );
    }

    const result = await query(
      {
        text: sanitizedText,
        source_lang: normalizedSourceLang,
        target_lang: normalizedTargetLang,
      },
      { env, clientIP }
    );

    if (result.code === 200 && result.data) {
      await setCachedTranslation(
        cacheKey,
        {
          data: result.data,
          timestamp: Date.now(),
          source_lang: result.source_lang || normalizedSourceLang.toUpperCase(),
          target_lang: result.target_lang || normalizedTargetLang.toUpperCase(),
          id: result.id,
        },
        env
      );
    }

    if (result.code === 200) {
      status = 200;
      await logRequest(env, {
        method: "POST",
        path: "/deepl-sharkey",
        ip: clientIP,
        sourceLang: result.source_lang || normalizedSourceLang,
        targetLang: result.target_lang || normalizedTargetLang,
        status: 200,
        responseTime: Date.now() - startTime,
        text: requestText,
      });
      return c.json(
        {
          translations: [
            {
              detected_source_language: result.source_lang || normalizedSourceLang.toUpperCase(),
              text: result.data,
            },
          ],
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
        sourceLang: normalizedSourceLang,
        targetLang: normalizedTargetLang,
        status,
        responseTime: Date.now() - startTime,
        error: errorMsg,
        text: requestText,
      });
      return c.json({ error: errorMsg }, status);
    }
  } catch (error) {
    const elapsed = Date.now() - startTime;
    errorMsg = error instanceof Error ? error.message : String(error);
    status = 500;
    await logRequest(env, {
      method: "POST",
      path: "/deepl-sharkey",
      ip: clientIP,
      sourceLang: sourceLang || "unknown",
      targetLang: targetLang || "unknown",
      status,
      responseTime: elapsed,
      error: errorMsg,
      text: requestText,
    });
    return c.json({ error: errorMsg }, 500);
  }
}

/**
 * API Route Definitions
 */
app
  .options("*", (c) => handleCORSPreflight(c))

  .get("/translate", (c) => c.text("Please use POST method :)"))
  .get("/deepl", (c) => c.text("Please use POST method :)"))
  .get("/google", (c) => c.text("Please use POST method :)"))

  /**
   * Debug endpoint
   */
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
            method_format: requestBody.includes('"method" : "')
              ? "spaced"
              : "normal",
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

  /**
   * Main translation endpoints
   */
  .post("/translate", async (c) => {
    return handleTranslation(c, "deepl");
  })

  .post("/deepl", async (c) => {
    return handleTranslation(c, "deepl");
  })

  .post("/google", async (c) => {
    return handleTranslation(c, "google");
  })

  /**
   * Sharkey 专用端点
   */
  .post("/deepl-sharkey", async (c) => {
    return handleSharkeyTranslation(c);
  })

  /**
   * 日志查看端点
   * 访问 https://deeplx.x9n2.qzz.io/log 即可看到最近的日志
   * 返回 JSON 格式，包含请求时间、IP、语言、状态、耗时、文本预览（仅首字符）
   */
  .get("/log", (c) => {
    return c.json({
      total: recentLogs.length,
      logs: recentLogs.slice().reverse(), // 最新的在前
    });
  })

  /**
   * Catch-all – redirect to GitHub
   */
  .all("*", (c) => c.redirect("https://github.com/xixu-me/DeepLX"));
