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