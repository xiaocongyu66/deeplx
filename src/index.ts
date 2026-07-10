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
  if (!value) {
    return false;
  }

  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Scheduled event handler for periodic maintenance tasks
 * Executes every 5 minutes as configured in wrangler.jsonc
 * @param event The scheduled event object
 * @param env Environment bindings
 * @param ctx Execution context for background tasks
 */
function scheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): void {
  ctx.waitUntil(handleScheduled(event, env));
}

/**
 * Handle scheduled maintenance tasks
 * Performs cache cleanup and other periodic maintenance
 * @param event The scheduled event object
 * @param env Environment bindings
 */
async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  // Clear the in-memory cache every 5 minutes to prevent memory leaks
  clearMemoryCache();
}

/**
 * Worker export configuration
 * Defines the main fetch handler and scheduled event handler
 */
const worker = {
  fetch: app.fetch,
  scheduled,
};

export default worker;

/**
 * Common translation handler function
 * Processes translation requests for both DeepL and Google Translate
 * @param c - Hono context
 * @param provider - Translation provider ('deepl' or 'google')
 * @returns Translation response
 */
async function handleTranslation(c: any, provider: "deepl" | "google") {
  const env = c.env;
  const clientIP = getSecureClientIP(c.req.raw) || "unknown";

  try {
    // Parse request parameters with better error handling
    let params;
    try {
      params = await c.req.json();
    } catch (parseError) {
      return c.json(createStandardResponse(400, null), 400);
    }

    // Enhanced parameter validation with input sanitization
    if (!params || typeof params !== "object") {
      return c.json(createStandardResponse(400, null), 400);
    }

    if (!params.text || typeof params.text !== "string") {
      return c.json(createStandardResponse(400, null), 400);
    }

    if (!params.text.trim()) {
      return c.json(createStandardResponse(400, null), 400);
    }

    // Basic text validation
    let sanitizedText;
    try {
      sanitizedText = params.text;
      if (sanitizedText.length > PAYLOAD_LIMITS.MAX_TEXT_LENGTH) {
        sanitizedText = sanitizedText.slice(0, PAYLOAD_LIMITS.MAX_TEXT_LENGTH);
      }
    } catch (sanitizeError) {
      return c.json(createStandardResponse(400, null), 400);
    }

    // Validate text length
    if (!sanitizedText) {
      return c.json(createStandardResponse(400, null), 400);
    }

    // Validate and sanitize language parameters
    const sourceLang = params.source_lang
      ? validateLanguageCode(params.source_lang)
      : "auto";
    const targetLang = params.target_lang
      ? validateLanguageCode(params.target_lang)
      : "en";

    if (!sourceLang || !targetLang) {
      return c.json(createStandardResponse(400, null), 400);
    }

    // Check cache first for faster response
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

    // Prepare validated parameters for translation
    const validatedParams = {
      text: sanitizedText,
      source_lang: normalizedSourceLang,
      target_lang: normalizedTargetLang,
    };

    let result;

    // Choose translation provider
    if (provider === "google") {
      result = await translateWithGoogle(validatedParams, {
        env,
        clientIP,
      });
    } else {
      // Use DeepL as default
      result = await query(validatedParams, {
        env,
        clientIP,
      });
    }

    // Cache successful translations
    if (result.code === 200 && result.data) {
      await setCachedTranslation(
        cacheKey,
        {
          data: result.data,
          timestamp: Date.now(),
          source_lang:
            result.source_lang || validatedParams.source_lang.toUpperCase(),
          target_lang:
            result.target_lang || validatedParams.target_lang.toUpperCase(),
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
 * API Route Definitions
 * Defines all available endpoints and their handlers
 */
app
  // Add CORS preflight handling for all routes
  .options("*", (c) => handleCORSPreflight(c))

  .get("/translate", (c) => c.text("Please use POST method :)"))
  .get("/deepl", (c) => c.text("Please use POST method :)"))
  .get("/google", (c) => c.text("Please use POST method :)"))

  /**
   * Debug endpoint for request format validation and troubleshooting
   * SECURITY: This endpoint is disabled in production unless DEBUG_MODE is explicitly enabled
   * POST /debug
   */
  .post("/debug", async (c) => {
    // Check if debug mode is enabled via environment variable
    if (!isDebugModeEnabled(c.env.DEBUG_MODE)) {
      return c.json(createStandardResponse(404, null), 404);
    }

    const env = c.env;
    const clientIP = getSecureClientIP(c.req.raw) || "unknown";

    try {
      const params = await c.req.json().catch(() => ({}));

      // Import buildRequestBody from query module for debugging
      const { buildRequestBody } = await import("./lib/query");

      if (!params.text || typeof params.text !== "string") {
        return c.json(
          createStandardResponse(400, "Missing text parameter"),
          400
        );
      }

      // Basic text validation
      const sanitizedText = params.text;
      if (!sanitizedText.trim()) {
        return c.json(
          createStandardResponse(400, "Invalid text parameter"),
          400
        );
      }

      // Validate language codes
      const sourceLang = params.source_lang
        ? validateLanguageCode(params.source_lang)
        : "auto";
      const targetLang = params.target_lang
        ? validateLanguageCode(params.target_lang)
        : "en";

      if (!sourceLang || !targetLang) {
        return c.json(
          createStandardResponse(400, "Invalid language codes"),
          400
        );
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
          client_ip: clientIP, // Safe to show in debug mode
          generated_request: parsedBody,
          sanitized_params: sanitizedParams, // Show sanitized version
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

        return c.json(
          createStandardResponse(200, JSON.stringify(debugInfo)),
          200
        );
      } catch (buildError) {
        const errorMessage =
          buildError instanceof Error
            ? buildError.message
            : "Request build failed";
        return c.json(createStandardResponse(400, errorMessage), 400);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return c.json(createStandardResponse(400, errorMessage), 400);
    }
  })

  /**
   * Main translation endpoint with comprehensive features
   * Handles single text translation with rate limiting, caching, and error handling
   * POST /translate - Uses DeepL (legacy endpoint)
   */
  .post("/translate", async (c) => {
    return handleTranslation(c, "deepl");
  })

  /**
   * DeepL translation endpoint
   * POST /deepl - Uses DeepL translation service
   */
  .post("/deepl", async (c) => {
    return handleTranslation(c, "deepl");
  })

  /**
   * Google Translate endpoint
   * POST /google - Uses Google Translate service
   */
  .post("/google", async (c) => {
    return handleTranslation(c, "google");
  })

  /**
   * Sharkey 专用翻译端点
   * 返回 DeepL 官方 API 兼容格式，供 Sharkey 使用
   * POST /deepl-sharkey
   */
  .post("/deepl-sharkey", async (c) => {
    const env = c.env;
    const clientIP = getSecureClientIP(c.req.raw) || "unknown";

    try {
      // 解析请求参数
      let params;
      try {
        params = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      // 参数验证（与 handleTranslation 保持一致）
      if (!params?.text || typeof params.text !== "string" || !params.text.trim()) {
        return c.json({ error: "Missing or invalid text" }, 400);
      }

      const sanitizedText = params.text.slice(0, PAYLOAD_LIMITS.MAX_TEXT_LENGTH);
      const sourceLang = params.source_lang ? validateLanguageCode(params.source_lang) : "auto";
      const targetLang = params.target_lang ? validateLanguageCode(params.target_lang) : "en";

      if (!sourceLang || !targetLang) {
        return c.json({ error: "Invalid language codes" }, 400);
      }

      // 归一化语言代码（与 handleTranslation 一致）
      const normalizedSourceLang = normalizeLanguageCode(sourceLang);
      const normalizedTargetLang = normalizeLanguageCode(targetLang);

      // 调用 DeepL 翻译核心（复用现有 query）
      const result = await query(
        {
          text: sanitizedText,
          source_lang: normalizedSourceLang,
          target_lang: normalizedTargetLang,
        },
        { env, clientIP }
      );

      // 如果翻译成功，转换为 Sharkey 期望的 DeepL 格式
      if (result.code === 200 && result.data) {
        return c.json(
          {
            translations: [{ text: result.data }],
          },
          200
        );
      } else {
        // 翻译失败时返回错误信息
        return c.json(
          { error: result.data || "Translation failed" },
          result.code || 500
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return c.json({ error: errorMessage }, 500);
    }
  })

  /**
   * Catch-all route for undefined paths
   * Redirects all other requests to the GitHub repository
   */
  .all("*", (c) => c.redirect("https://github.com/xixu-me/DeepLX"));
