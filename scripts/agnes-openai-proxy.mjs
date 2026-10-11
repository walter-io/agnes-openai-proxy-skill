#!/usr/bin/env node
/**
 * Agnes → OpenAI 兼容代理(单文件,零依赖,Node >= 18)
 *
 * 作用:让只支持 OpenAI chat 协议的客户端(如 Hypit、各类 agent 框架)
 * 能够像调用文本模型一样调用 Agnes 的图像/视频模型。
 *
 * 路由规则(按模型名):
 *   - 含 "image" → 内部转调 POST {upstream}/v1/images/generations,结果包装成 chat 回复
 *   - 含 "video" → 内部转调 POST {upstream}/v1/videos + 轮询 GET {upstream}/agnesapi,结果包装成 chat 回复
 *   - 其他      → 原样透传到 {upstream}/v1/chat/completions(支持流式)
 *
 * 另外原样透传(便于 OpenAI SDK 直接使用):
 *   POST /v1/images/generations(自动把顶层 response_format 规范化进 extra_body)
 *   POST /v1/videos
 *   GET  /v1/models
 *
 * 配置(环境变量,均可省略):
 *   AGNES_API_KEY    API Key;未设置时依次读 AGNES_KEY_FILE、~/.agnes_key、~/.workbuddy/agnes-key.txt
 *   AGNES_BASE_URL   默认 https://api.agnes-ai.cn(国内站;国际站填 https://apihub.agnes-ai.com)
 *   PORT             默认 8787
 *   HOST             默认 127.0.0.1
 *   AGNES_VIDEO_POLL_TIMEOUT  视频轮询上限秒数,默认 900
 *
 * 启动:node agnes-openai-proxy.mjs
 * 客户端接入:Base URL 填 http://127.0.0.1:8787/v1,API Key 随意(代理不校验,统一用 Agnes Key)
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ---------- 配置 ----------

const PORT = Number(process.env.PORT || 18787);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM = (process.env.AGNES_BASE_URL || "https://api.agnes-ai.cn").replace(/\/+$/, "");
const VIDEO_POLL_TIMEOUT = Number(process.env.AGNES_VIDEO_POLL_TIMEOUT || 900);

function loadApiKey() {
  if (process.env.AGNES_API_KEY) return process.env.AGNES_API_KEY.trim();
  const candidates = [];
  if (process.env.AGNES_KEY_FILE) candidates.push(process.env.AGNES_KEY_FILE);
  candidates.push(path.join(os.homedir(), ".agnes_key"));
  candidates.push(path.join(os.homedir(), ".workbuddy", "agnes-key.txt"));
  for (const p of candidates) {
    try {
      const t = fs.readFileSync(p, "utf8").trim();
      if (t) return t.split(/\r?\n/)[0].trim();
    } catch {}
  }
  return "";
}
const API_KEY = loadApiKey();

// ---------- 小工具 ----------

const log = (...a) => console.log(new Date().toISOString(), ...a);

function randId(prefix) {
  return prefix + crypto.randomBytes(12).toString("hex");
}

async function upstreamFetch(urlPath, options = {}, timeoutMs = 600000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(UPSTREAM + urlPath, {
      ...options,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function openaiError(res, status, message, code) {
  sendJson(res, status, {
    error: { message, type: "agnes_proxy_error", code: code || String(status) },
  });
}

function chatCompletionPayload(model, content) {
  return {
    id: randId("chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 把一次性的完整回复按客户端要求输出(流式则包装成单帧 SSE) */
function respondChat(res, model, content, stream) {
  if (!stream) {
    sendJson(res, 200, chatCompletionPayload(model, content));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const chunk = {
    id: randId("chatcmpl-"),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  const done = {
    id: chunk.id,
    object: "chat.completion.chunk",
    created: chunk.created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  res.write(`data: ${JSON.stringify(done)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

/** 从 chat messages 中提取:全部文本(合并)与参考图片 URL 数组 */
function extractFromMessages(messages) {
  let prompt = "";
  const images = [];
  const walk = (content) => {
    if (typeof content === "string") {
      prompt += (prompt ? "\n" : "") + content;
      return;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
          prompt += (prompt ? "\n" : "") + part.text;
        } else if (part?.type === "image_url") {
          const u = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          if (u) images.push(u);
        } else if (part?.type === "input_image") {
          const u = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          if (u) images.push(u);
        }
      }
    }
  };
  // 只取最后一条用户消息(生成类指令以最后一次输入为准),历史文本不拼接
  const lastUser = [...(messages || [])].reverse().find((m) => m?.role === "user");
  if (lastUser) walk(lastUser.content);
  return { prompt: prompt.trim(), images };
}

// ---------- 图像模型处理 ----------

const IMAGE_SIZES = new Set([
  "1024x1024", "1024x768", "768x1024",
  "864x1152", "1152x864", "1312x736", "736x1312",
  "1664x2496", "2496x1664", "1248x832", "832x1248", "1568x672",
  "1728x2304", "2304x1728", "2624x1472", "1472x2624", "3136x1344",
  "2048x2048", "3072x3072", "4096x4096",
]);

async function handleImageViaChat(reqBody, res) {
  const model = reqBody.model;
  const { prompt, images } = extractFromMessages(reqBody.messages);
  if (!prompt) return openaiError(res, 400, "messages 中没有可用的文本提示词(prompt)");

  // 尺寸:优先取请求体顶层 size;否则默认 1024x1024
  let size = typeof reqBody.size === "string" ? reqBody.size : "1024x1024";
  if (!IMAGE_SIZES.has(size) && !/^\d{3,4}x\d{3,4}$/.test(size)) size = "1024x1024";

  const extra = { response_format: "url" };
  if (images.length) extra.image = images;

  log(`[image] model=${model} size=${size} refs=${images.length}`);
  const r = await upstreamFetch("/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({ model, prompt, size, extra_body: extra }),
  });
  const text = await r.text();
  if (!r.ok) {
    log(`[image] upstream ${r.status}: ${text.slice(0, 300)}`);
    return openaiError(res, r.status, `Agnes 图像生成失败: ${text.slice(0, 500)}`, "upstream_error");
  }
  let j;
  try { j = JSON.parse(text); } catch { return openaiError(res, 502, "Agnes 返回了无法解析的内容", "upstream_parse"); }
  const item = j?.data?.[0];
  const url = item?.url || "";
  const b64 = item?.b64_json || "";
  if (!url && !b64) return openaiError(res, 502, "Agnes 未返回图片数据(可能被内容安全策略拦截)", "empty_result");

  let content;
  if (url) {
    content = `![generated image](${url})\n\n图片地址:${url}`;
  } else {
    const ext = b64.startsWith("iVBOR") ? "png" : "jpg";
    content = `![generated image](data:image/${ext};base64,${b64})`;
  }
  respondChat(res, model, content, !!reqBody.stream);
}

// ---------- 视频模型处理 ----------

const ASPECT_RATIOS = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const VIDEO_SIZES = new Set(["720P", "1080P", "1K", "2K"]);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pollVideo(videoId, model, res, stream) {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT * 1000;
  let lastKeepAlive = 0;
  while (Date.now() < deadline) {
    const r = await upstreamFetch(
      `/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model)}`,
      { method: "GET" },
      60000
    );
    if (r.ok) {
      const j = await r.json().catch(() => null);
      if (j) {
        log(`[video] ${videoId} status=${j.status} progress=${j.progress}`);
        if (j.status === "completed") return j;
        if (j.status === "failed") {
          const msg = j?.error?.message || "未知原因";
          throw new Error(`视频生成失败: ${msg}`);
        }
      }
    } else if (r.status !== 429) {
      // 404/401 等直接失败;429 退避后继续
      const t = await r.text().catch(() => "");
      if (r.status !== 404 || !t.includes("not ready")) {
        log(`[video] poll ${r.status}: ${t.slice(0, 200)}`);
      }
    }
    // 流式请求时发 SSE 注释行做 keep-alive(解析器会忽略)
    if (stream && res.writableEnded === false && Date.now() - lastKeepAlive > 15000) {
      lastKeepAlive = Date.now();
      res.write(`: keep-alive ${new Date().toISOString()}\n\n`);
    }
    await sleep(2000);
  }
  throw new Error(`视频轮询超时(>${VIDEO_POLL_TIMEOUT}s),任务可能仍在进行,video_id=${videoId}`);
}

async function handleVideoViaChat(reqBody, res) {
  const model = reqBody.model;
  const { prompt, images } = extractFromMessages(reqBody.messages);
  if (!prompt && !images.length) {
    return openaiError(res, 400, "messages 中没有可用的提示词或参考图");
  }

  let seconds = typeof reqBody.seconds === "string" || typeof reqBody.seconds === "number"
    ? String(reqBody.seconds) : "5";
  if (!/^[4-9]$|^1[0-2]$/.test(seconds)) seconds = "5";

  let size = typeof reqBody.size === "string" ? reqBody.size.toUpperCase() : "720P";
  if (!VIDEO_SIZES.has(size)) size = "720P";

  let aspect = typeof reqBody.aspect_ratio === "string" ? reqBody.aspect_ratio : "16:9";
  if (!ASPECT_RATIOS.has(aspect)) aspect = "16:9";

  const body = { model, prompt: prompt || "为参考图生成自然连贯的视频", seconds, size, mode: "text", n: 1 };

  const firstFrame = typeof reqBody.first_frame === "string" ? reqBody.first_frame : undefined;
  const lastFrame = typeof reqBody.last_frame === "string" ? reqBody.last_frame : undefined;
  const audios = Array.isArray(reqBody.audios) ? reqBody.audios.filter((u) => typeof u === "string") : [];

  if (firstFrame || lastFrame) {
    body.mode = "keyframe";
    if (firstFrame) body.first_frame = firstFrame;
    if (lastFrame) body.last_frame = lastFrame;
  } else if (images.length) {
    body.mode = "reference";
    body.images = images.slice(0, 5);
  } else if (audios.length) {
    body.mode = "reference";
    body.audios = audios.slice(0, 3);
  } else if (prompt) {
    body.mode = "text";
  }
  if (body.mode === "reference" && !body.images && !body.audios) {
    return openaiError(res, 400, "reference 模式需要至少一张参考图或一段参考音频");
  }

  log(`[video] model=${model} mode=${body.mode} seconds=${seconds} size=${size} refs=${images.length}`);
  const r = await upstreamFetch("/v1/videos", { method: "POST", body: JSON.stringify(body) }, 120000);
  const text = await r.text();
  if (!r.ok) {
    log(`[video] create ${r.status}: ${text.slice(0, 300)}`);
    return openaiError(res, r.status, `创建视频任务失败: ${text.slice(0, 500)}`, "upstream_error");
  }
  let created;
  try { created = JSON.parse(text); } catch { return openaiError(res, 502, "Agnes 返回了无法解析的内容", "upstream_parse"); }
  const videoId = created.video_id || created.id || created.task_id;
  if (!videoId) return openaiError(res, 502, "创建任务成功但未返回 video_id", "no_video_id");

  // 流式:先建立 SSE,再轮询;非流式:直接等
  if (reqBody.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
  }
  try {
    const done = await pollVideo(videoId, model, res, !!reqBody.stream);
    const url = done.url || "";
    if (!url) throw new Error("任务完成但未返回视频地址");
    const content = `视频已生成完成。\n\n[下载/播放视频](${url})\n\n视频地址:${url}`;
    if (reqBody.stream) {
      const chunk = {
        id: randId("chatcmpl-"), object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      sendJson(res, 200, chatCompletionPayload(model, content));
    }
  } catch (e) {
    if (reqBody.stream && !res.writableEnded) {
      const chunk = {
        id: randId("chatcmpl-"), object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: { content: "生成失败:" + e.message }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (!res.headersSent) {
      openaiError(res, 500, e.message, "video_failed");
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

// ---------- 透传 ----------

async function passthrough(req, res, urlPath, bodyBuf, extraTransform) {
  let body = bodyBuf && bodyBuf.length ? bodyBuf.toString("utf8") : undefined;
  if (body && extraTransform) body = extraTransform(body);
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await upstreamFetch(urlPath, { method: req.method, body, headers });
  const isSse = (r.headers.get("content-type") || "").includes("text/event-stream");
  if (isSse) {
    res.writeHead(r.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    // 逐帧转发
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } else {
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, {
      "Content-Type": r.headers.get("content-type") || "application/json",
      "Content-Length": buf.length,
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
  }
}

// ---------- HTTP 服务 ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    return res.end();
  }
  if (p === "/healthz") return sendJson(res, 200, { ok: true, upstream: UPSTREAM, key_loaded: !!API_KEY });

  if (!API_KEY) {
    return openaiError(res, 500, "未找到 Agnes API Key,请设置 AGNES_API_KEY 或写入 ~/.agnes_key", "missing_key");
  }

  try {
    // 模型列表
    if (req.method === "GET" && p === "/v1/models") {
      return await passthrough(req, res, "/v1/models");
    }

    // chat completions:按模型名路由
    if (req.method === "POST" && (p === "/v1/chat/completions" || p === "/chat/completions")) {
      const bodyBuf = await readBody(req);
      let body;
      try { body = JSON.parse(bodyBuf.toString("utf8")); } catch {
        return openaiError(res, 400, "请求体不是合法 JSON");
      }
      const model = String(body.model || "");
      if (/image/i.test(model)) return await handleImageViaChat(body, res);
      if (/video/i.test(model)) return await handleVideoViaChat(body, res);
      return await passthrough(req, res, "/v1/chat/completions", bodyBuf);
    }

    // 图像端点直通(规范化 response_format 位置)
    if (req.method === "POST" && (p === "/v1/images/generations" || p === "/images/generations")) {
      const bodyBuf = await readBody(req);
      return await passthrough(req, res, "/v1/images/generations", bodyBuf, (s) => {
        try {
          const j = JSON.parse(s);
          if (j.response_format && !j.extra_body) j.extra_body = { response_format: j.response_format };
          else if (j.response_format && j.extra_body && !j.extra_body.response_format) {
            j.extra_body.response_format = j.response_format;
          }
          delete j.response_format;
          return JSON.stringify(j);
        } catch { return s; }
      });
    }

    // 视频创建/查询直通
    if (req.method === "POST" && (p === "/v1/videos" || p === "/videos")) {
      const bodyBuf = await readBody(req);
      return await passthrough(req, res, "/v1/videos", bodyBuf);
    }
    if (req.method === "GET" && p === "/agnesapi") {
      return await passthrough(req, res, "/agnesapi" + u.search);
    }

    return openaiError(res, 404, `未知路径: ${p}。可用: /v1/chat/completions, /v1/models, /v1/images/generations, /v1/videos, /agnesapi, /healthz`);
  } catch (e) {
    log("error:", e?.message || e);
    if (!res.headersSent) openaiError(res, 500, String(e?.message || e));
    else if (!res.writableEnded) res.end();
  }
});

// 长任务(视频轮询最长 15+ 分钟)不被 Node 默认超时掐断
server.requestTimeout = 0;
server.headersTimeout = 60 * 60 * 1000;
server.keepAliveTimeout = 75 * 1000;

server.listen(PORT, HOST, () => {
  console.log("==============================================");
  console.log(" Agnes OpenAI 兼容代理已启动");
  console.log(` 本地地址 : http://${HOST}:${PORT}/v1  (常驻服务,开机自启)`);
  console.log(` 上游站点 : ${UPSTREAM}`);
  console.log(` API Key  : ${API_KEY ? "已加载(" + API_KEY.slice(0, 6) + "...)" : "未找到!请设置 AGNES_API_KEY 或 ~/.agnes_key"}`);
  console.log(" 客户端接入: Base URL 填上面的地址,API Key 随意填");
  console.log(" 图像模型 : agnes-image-2.5-flash / agnes-image-2.1-flash");
  console.log(" 视频模型 : agnes-video-2.5-flash / agnes-video-2.5");
  console.log(" 文本模型 : agnes-2.5-flash 等(原样透传)");
  console.log("==============================================");
});
