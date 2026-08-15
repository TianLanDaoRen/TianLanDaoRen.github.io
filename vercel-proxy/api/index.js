// 💡 使用 Vercel Edge Runtime，原生支持 Web Standard Fetch 与 SSE 流式传输
export const config = {
    runtime: 'edge',
};

export default async function handler(request) {
    const url = new URL(request.url);

    // 1. 处理 Steam 二次验证代理路由 (/steam-proxy)
    if (url.pathname === '/steam-proxy') {
        const bodyText = await request.text();
        const steamRes = await fetch('https://steamcommunity.com/openid/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            body: bodyText
        });
        const resText = await steamRes.text();
        return new Response(resText, {
            status: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }

    // 2. 在 Vercel 的 api/index.js 中添加 Turnstile 代理处理：
    if (url.pathname === '/turnstile-proxy') {
        const bodyText = await request.text();
        const turnstileRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: bodyText
        });
        const resText = await turnstileRes.text();
        return new Response(resText, {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 2.5. 处理 OpenCode Go 套餐代理请求 (/opencode-proxy/* → https://opencode.ai/*)
    // 💡 北京 ECS 无法直连 opencode.ai（实测 TCP 不通），经 Vercel Edge 中转；
    // 认证由上游 relay 的 Authorization: Bearer 原样透传，本层不存储任何密钥；
    // 同时作为「OpenAI 兼容自定义模型供应商」对外暴露：
    //   ① 补 CORS 头支持网页端客户端
    //   ② SSE 流规范化：上游在 [DONE] 后多发一行非标准 {"choices":[],"cost":"0"}，
    //      严格 OpenAI 客户端会因此不结束——截断 [DONE] 之后的所有内容
    //   ③ /models 注入 reasoning 能力标记：让客户端知道哪些模型支持 thinking（实测支持）
    if (url.pathname.startsWith('/opencode-proxy')) {
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '86400',
        };

        // CORS 预检
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const ocPath = url.pathname.replace(/^\/opencode-proxy/, '') + url.search;
        const ocTarget = `https://opencode.ai${ocPath}`;

        try {
            const ocRes = await fetch(ocTarget, {
                method: request.method,
                headers: request.headers,
                body: request.method === 'POST' ? request.body : null,
                redirect: 'follow'
            });

            // ③ /models：注入 reasoning 能力扩展字段（实测支持思考的模型）
            if (ocPath.includes('/models')) {
                const text = await ocRes.text();
                const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' };
                try {
                    const j = JSON.parse(text);
                    const THINKING_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3', 'glm-5.3']);
                    if (j && Array.isArray(j.data)) {
                        j.data.forEach(m => { if (m && THINKING_MODELS.has(m.id)) m.reasoning = true; });
                    }
                    return new Response(JSON.stringify(j), { status: 200, headers: jsonHeaders });
                } catch {
                    return new Response(text, { status: 200, headers: jsonHeaders });
                }
            }

            // ② SSE 流规范化：读到 data: [DONE] 即结束，丢弃其后所有内容
            if (request.method === 'POST' && ocRes.ok) {
                const ct = ocRes.headers.get('content-type') || '';
                if (ct.includes('text/event-stream') || ct.includes('text/plain')) {
                    const encoder = new TextEncoder();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let finished = false;
                    const stream = ocRes.body.pipeThrough(new TransformStream({
                        transform(chunk, controller) {
                            buffer += decoder.decode(chunk, { stream: true });
                            let idx;
                            while ((idx = buffer.indexOf('\n')) >= 0) {
                                const line = buffer.slice(0, idx + 1);
                                buffer = buffer.slice(idx + 1);
                                if (line.trim() === 'data: [DONE]') {
                                    controller.enqueue(encoder.encode(line));
                                    finished = true;
                                    controller.terminate();
                                    return;
                                }
                                controller.enqueue(encoder.encode(line));
                            }
                        },
                        flush(controller) {
                            if (buffer && !finished) controller.enqueue(encoder.encode(buffer));
                            if (!finished) controller.terminate(); // 上游 EOF 未遇 DONE 也正常收尾
                        }
                    }));
                    return new Response(stream, {
                        status: 200,
                        headers: { ...corsHeaders, 'Content-Type': 'text/event-stream; charset=utf-8' }
                    });
                }
            }

            // 其余（非流式 JSON 等）：原样透传 + CORS
            const ocResponse = new Response(ocRes.body, ocRes);
            ocResponse.headers.set('Access-Control-Allow-Origin', '*');
            ocResponse.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
            ocResponse.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
            return ocResponse;
        } catch (err) {
            return new Response(JSON.stringify({
                error: { code: 502, message: `OpenCode Edge Fetch Error: ${err.message}`, status: "BAD_GATEWAY" }
            }), {
                status: 502,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
    }

    // 3. 处理 Gemini API 代理请求
    const targetPath = url.pathname + url.search;
    const geminiHost = 'https://generativelanguage.googleapis.com';
    const targetUrl = `${geminiHost}${targetPath}`;

    // 读取 X-Gemini-API-Key
    let apiKey = request.headers.get('X-Gemini-API-Key');

    // 兼容性回退：读取标准的 Authorization 头部
    if (!apiKey) {
        const authHeader = request.headers.get('Authorization') || '';
        if (authHeader.startsWith('Bearer ')) {
            apiKey = authHeader.substring(7);
        }
    }

    // 兜底回退：读取 Vercel 环境变量 (process.env.GEMINI_API_KEY)
    if (!apiKey) {
        apiKey = process.env.GEMINI_API_KEY;
    }

    if (!apiKey) {
        return new Response(JSON.stringify({
            error: { code: 400, message: "Gemini API Key is missing.", status: "INVALID_ARGUMENT" }
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const newHeaders = new Headers(request.headers);
    newHeaders.set('x-goog-api-key', apiKey);
    newHeaders.delete('Authorization');
    newHeaders.delete('X-Gemini-API-Key');

    try {
        const response = await fetch(targetUrl, {
            method: request.method,
            headers: newHeaders,
            body: request.method === 'POST' ? request.body : null
        });

        // 构建脱敏后的 Key 用于诊断 (如 "AQ.Ab8RN...1Wpg")
        const maskedKey = apiKey.length > 12
            ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`
            : apiKey;

        // 克隆响应，在 Headers 中注入当前请求实际使用的 Key
        const newResponse = new Response(response.body, response);
        newResponse.headers.set('X-Debug-Key-Used', maskedKey);
        return newResponse;

    } catch (err) {
        return new Response(JSON.stringify({
            error: { code: 502, message: `Vercel Edge Fetch Error: ${err.message}`, status: "BAD_GATEWAY" }
        }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}