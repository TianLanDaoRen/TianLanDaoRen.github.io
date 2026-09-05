// 💡 使用 Vercel Nodejs Runtime，原生支持 Web Standard Fetch 与 SSE 流式传输
export const config = {
    runtime: 'nodejs',
};

// 💡【Node.js 运行时】：锁定 300 秒（5分钟）Hobby 免费版最大执行时长
export const maxDuration = 300;

export default async function handler(req, res) {
    const hostHeader = req.headers.host || 'gemini.gualing.top';
    const url = new URL(req.url, `https://${hostHeader}`);
    const pathname = url.pathname;

    // =================================================================
    // 1. 处理 Steam 二次验证代理路由 (/steam-proxy)
    // =================================================================
    if (pathname === '/steam-proxy') {
        let bodyText = req.body;
        if (typeof bodyText === 'object') {
            bodyText = new URLSearchParams(bodyText).toString();
        }

        try {
            const steamRes = await fetch('https://steamcommunity.com/openid/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                body: bodyText
            });
            const resText = await steamRes.text();
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.status(200).send(resText);
        } catch (err) {
            const cause = err.cause ? ` (${err.cause.message || err.cause})` : '';
            return res.status(502).json({ error: `Steam Proxy Error: ${err.message}${cause}` });
        }
    }

    // =================================================================
    // 2. 处理 Turnstile 人机验证代理路由 (/turnstile-proxy)
    // =================================================================
    if (pathname === '/turnstile-proxy') {
        let bodyText = req.body;
        if (typeof bodyText === 'object') {
            bodyText = new URLSearchParams(bodyText).toString();
        }

        try {
            const turnstileRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                body: bodyText
            });
            const resText = await turnstileRes.text();
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.status(200).send(resText);
        } catch (err) {
            const cause = err.cause ? ` (${err.cause.message || err.cause})` : '';
            return res.status(502).json({ error: `Turnstile Proxy Error: ${err.message}${cause}` });
        }
    }

    // =================================================================
    // 2.5. 处理 OpenCode 代理请求 (/opencode-proxy/* → https://opencode.ai/*)
    // =================================================================
    if (pathname.startsWith('/opencode-proxy')) {
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-opencode-session',
            'Access-Control-Max-Age': '86400',
        };

        if (req.method === 'OPTIONS') {
            Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
            return res.status(204).end();
        }

        const ocPath = req.url.replace(/^\/opencode-proxy/, '');
        const ocTarget = `https://opencode.ai${ocPath}`;

        try {
            // 💡 仅保留业务必需头，避免透传底层冲突头
            const cleanOcHeaders = {
                'Content-Type': 'application/json'
            };
            if (req.headers['authorization']) {
                cleanOcHeaders['Authorization'] = req.headers['authorization'];
            }
            // 💡 2026-09-05 opencode 强制要求 x-opencode-session（09/06 起缺头可能报错），必须透传
            if (req.headers['x-opencode-session']) {
                cleanOcHeaders['x-opencode-session'] = req.headers['x-opencode-session'];
            }

            let reqBody = undefined;
            if (req.method === 'POST') {
                reqBody = typeof req.body === 'object' ? JSON.stringify(req.body) : req.body;
            }

            const ocRes = await fetch(ocTarget, {
                method: req.method,
                headers: cleanOcHeaders,
                body: reqBody,
                redirect: 'follow'
            });

            Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

            // /models：注入 reasoning 能力扩展标记
            if (ocPath.includes('/models')) {
                const text = await ocRes.text();
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                try {
                    const j = JSON.parse(text);
                    const THINKING_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3', 'glm-5.3']);
                    if (j && Array.isArray(j.data)) {
                        j.data.forEach(m => { if (m && THINKING_MODELS.has(m.id)) m.reasoning = true; });
                    }
                    return res.status(200).send(JSON.stringify(j));
                } catch {
                    return res.status(200).send(text);
                }
            }

            // SSE 流式规范化：遇到 [DONE] 立即截断结束
            const ct = ocRes.headers.get('content-type') || '';
            if (req.method === 'POST' && ocRes.ok && (ct.includes('text/event-stream') || ct.includes('text/plain'))) {
                res.writeHead(200, {
                    ...corsHeaders,
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });

                const decoder = new TextDecoder();
                let buffer = '';
                let finished = false;

                for await (const chunk of ocRes.body) {
                    buffer += decoder.decode(chunk, { stream: true });
                    let idx;
                    while ((idx = buffer.indexOf('\n')) >= 0) {
                        const line = buffer.slice(0, idx + 1);
                        buffer = buffer.slice(idx + 1);
                        if (line.trim() === 'data: [DONE]') {
                            res.write(line);
                            finished = true;
                            res.end();
                            return;
                        }
                        res.write(line);
                    }
                }

                if (buffer && !finished) res.write(buffer);
                if (!finished) res.end();
                return;
            }

            const data = await ocRes.arrayBuffer();
            res.status(ocRes.status);
            ocRes.headers.forEach((v, k) => {
                if (!['content-encoding', 'content-length'].includes(k.toLowerCase())) {
                    res.setHeader(k, v);
                }
            });
            return res.send(Buffer.from(data));

        } catch (err) {
            Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
            const cause = err.cause ? ` (${err.cause.message || err.cause})` : '';
            return res.status(502).json({
                error: { code: 502, message: `OpenCode Node Fetch Error: ${err.message}${cause}`, status: "BAD_GATEWAY" }
            });
        }
    }

    // =================================================================
    // 3. 处理 Gemini API 代理请求
    // =================================================================

    // 💡【路径净化】：防止 Vercel Rewrites 污染原始请求路径
    let rawPath = req.url || '';
    if (rawPath.startsWith('/api/index.js')) {
        rawPath = rawPath.replace('/api/index.js', '');
    }
    if (!rawPath.startsWith('/')) {
        rawPath = '/' + rawPath;
    }
    const targetUrl = `https://generativelanguage.googleapis.com${rawPath}`;

    // 提取 API Key
    let apiKey = req.headers['x-gemini-api-key'];
    if (!apiKey) {
        const authHeader = req.headers['authorization'] || '';
        if (authHeader.startsWith('Bearer ')) {
            apiKey = authHeader.substring(7);
        }
    }
    if (!apiKey) {
        apiKey = process.env.GEMINI_API_KEY;
    }

    if (!apiKey) {
        return res.status(400).json({
            error: { code: 400, message: "Gemini API Key is missing.", status: "INVALID_ARGUMENT" }
        });
    }

    // 💡【核心修复】：纯净构建发往 Google 的 Headers，严禁透传客户端 content-length/host 造成崩溃
    const googleHeaders = {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    try {
        let reqBody = undefined;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            if (typeof req.body === 'object' && req.body !== null) {
                reqBody = JSON.stringify(req.body);
            } else if (typeof req.body === 'string') {
                reqBody = req.body;
            }
        }

        const response = await fetch(targetUrl, {
            method: req.method,
            headers: googleHeaders,
            body: reqBody
        });

        const maskedKey = apiKey.length > 12
            ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`
            : apiKey;

        res.status(response.status);
        response.headers.forEach((v, k) => {
            if (!['content-encoding', 'content-length'].includes(k.toLowerCase())) {
                res.setHeader(k, v);
            }
        });
        res.setHeader('X-Debug-Key-Used', maskedKey);

        // 原生 Node.js 流式直通传输
        for await (const chunk of response.body) {
            res.write(chunk);
        }
        return res.end();

    } catch (err) {
        const cause = err.cause ? ` (${err.cause.message || JSON.stringify(err.cause)})` : '';
        return res.status(502).json({
            error: { code: 502, message: `Vercel Node Fetch Error: ${err.message}${cause}`, status: "BAD_GATEWAY" }
        });
    }
}