// relay-core.test.mjs — gemini-relay.js 内核行为回归测试（2026-09-13 全量审阅后新建）
//
// 与 relay-router.test.mjs 的分工：
//   · relay-router.test.mjs —— 供应商字典与路由分发的**静态快照**断言（配置改了要重定基线）
//   · 本文件              —— 运行时**行为**断言：用假 fetch 喂分块数据，驱动真实解析器，
//                            断言"喂进去什么、吐出来什么"，不依赖任何配置数值
//
// 覆盖 2026-09-13 全量审阅发现的三处逻辑漏洞（前两处已修，本文件即其回归护栏）：
//   H1 流式 JSON 扫描器状态失同步：对象跨 chunk 且含嵌套括号时，旧 depth/inString 被重复累加，
//      导致对象永远合不拢、该请求解析静默停摆（本文件 §1.2/§1.3 即复现该场景）
//   M1 completion 通道上游 error 块被 catch 无差别吞掉（[Completion Stream Error] 曾是死代码）
//   M2 流中途未捕获异常会把客户端挂死 —— 尚未修复，故不在此断言，留待决策
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RELAY = path.resolve(process.argv[2] || '/Users/yunsisanren/Documents/Workspaces/VSCWorkspace/GualingAI/gemini-relay.js');
const src = fs.readFileSync(RELAY, 'utf8');

function slice(label) {
    const s = src.indexOf(`// @slice:${label}:start`);
    const e = src.indexOf(`// @slice:${label}:end`, s);
    if (s === -1 || e === -1) throw new Error(`@slice 标记缺失: ${label}（生产文件里的插桩标记被删了？）`);
    return src.slice(s, e);
}

// 用可记录的 stub 替换真实分发，使节点吐出的消息可被断言
const harness = [
    "import { StringDecoder } from 'node:string_decoder';",
    'globalThis.__relayEmitted = [];',
    'function handleIncomingWSMessage(ws, s) { globalThis.__relayEmitted.push({ nodeId: ws && ws.nodeId, msg: JSON.parse(s) }); }',
    'const appletPool = new Set();',
    slice('config'), slice('classes'), slice('router'), slice('continuation'), slice('helpers'),
    'export { VirtualWorkerNode, CompletionWorkerNode, getBestNode, extractModelName, initFallbackIndex, buildContinuationBody, appletPool, GLOBAL_FALLBACK_MODELS };'
].join('\n');

const harnessPath = path.join(os.tmpdir(), 'relay-core-harness.mjs');
fs.writeFileSync(harnessPath, harness);

let passed = 0, failed = 0;
function ok(cond, label) {
    if (cond) { passed++; console.log('  ✅', label); }
    else { failed++; console.error('  ❌', label); }
}

// —— 假 fetch：把给定字符串数组作为流式 body 分块吐出 ——
function installFakeFetch(chunks, { okStatus = true, status = 200 } = {}) {
    globalThis.fetch = async () => ({
        ok: okStatus,
        status,
        headers: { get: () => null },
        text: async () => chunks.join(''),
        json: async () => JSON.parse(chunks.join('')),
        body: (async function* () { for (const c of chunks) yield Buffer.from(c, 'utf8'); })()
    });
}

function batchesOf(emitted, id) { return emitted.filter(e => e.msg.id === id && e.msg.type === 'batch'); }
function doneOf(emitted, id) { return emitted.find(e => e.msg.id === id && e.msg.done === true); }
function failureOf(emitted, id) { return emitted.find(e => e.msg.id === id && e.msg.success === false); }
function partsOf(emitted, id) {
    const out = [];
    for (const b of batchesOf(emitted, id)) for (const c of (b.msg.chunks || [])) {
        const parts = c?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) for (const p of parts) out.push(p);
    }
    return out;
}
function textsOf(emitted, id) { return partsOf(emitted, id).map(p => p.text); }

const SSE_PATH = '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse';
const DS_PATH = '/v1beta/models/deepseek-v4-pro:streamGenerateContent?alt=sse';
const ZP_PATH = '/v1beta/models/glm-5.3-flash:streamGenerateContent?alt=sse';

try {
    const H = await import(pathToFileURL(harnessPath).href + '?t=' + Date.now());

    async function runVirtual(chunks, id) {
        globalThis.__relayEmitted = [];
        installFakeFetch(chunks);
        const node = new H.VirtualWorkerNode('v1', 'k', 'https://fake.invalid', null, 'gemini-official');
        await node.send(JSON.stringify({ id, path: SSE_PATH, body: {}, method: 'POST' }));
        return globalThis.__relayEmitted;
    }

    // ============================================================
    console.log('=== 1. 流式 JSON 扫描器：分块边界不得破坏解析 ===');
    // ============================================================
    const CH_A = '{"candidates":[{"content":{"parts":[{"text":"甲"}]}}]}';
    const CH_B = '{"candidates":[{"content":{"parts":[{"text":"乙"}]}}],"usageMetadata":{"totalTokenCount":7}}';

    // 1.1 单块内含两个完整对象
    {
        const em = await runVirtual([CH_A + CH_B], 'c1');
        ok(textsOf(em, 'c1').join('') === '甲乙', `单块两对象 → 文本顺序正确 (got ${JSON.stringify(textsOf(em, 'c1').join(''))})`);
        ok(!!doneOf(em, 'c1') && !failureOf(em, 'c1'), 'usageMetadata 收尾 → done:true 且无 error（sawFinish 生效）');
    }

    // 1.2 【H1 回归】对象跨 chunk，切点落在嵌套结构内部
    {
        const cut = 20;
        const em = await runVirtual([CH_A.slice(0, cut), CH_A.slice(cut) + CH_B], 'c2');
        ok(textsOf(em, 'c2').join('') === '甲乙', `嵌套对象跨 chunk → 仍解析出甲乙 (got ${JSON.stringify(textsOf(em, 'c2').join(''))})`);
        ok(!!doneOf(em, 'c2'), '跨 chunk 后仍正常收尾 done:true（旧实现会静默停摆）');
        ok(!failureOf(em, 'c2'), '跨 chunk 不应被误判为上游掐流');
    }

    // 1.3 逐字符切块（最坏情况）
    {
        const cc = Array.from(CH_A + CH_B);
        const em = await runVirtual(cc, 'c3');
        ok(textsOf(em, 'c3').join('') === '甲乙', `逐字符切块 → 仍解析出甲乙 (got ${JSON.stringify(textsOf(em, 'c3').join(''))})`);
        ok(!!doneOf(em, 'c3'), '逐字符切块后仍正常收尾');
    }

    // 1.4a 字符串值内含花括号与引号，且切点落在字符串中间
    {
        const inner = '花括号{"a":1} 与 "引号" 包裹';
        const payload = JSON.stringify({ candidates: [{ content: { parts: [{ text: inner }] } }], usageMetadata: {} });
        const at = payload.indexOf('花括号') + 3; // 切进该字符串内部
        const em = await runVirtual([payload.slice(0, at), payload.slice(at)], 'c4');
        ok(textsOf(em, 'c4').join('') === inner, `字符串内的括号/引号不被误判结构 (got ${JSON.stringify(textsOf(em, 'c4').join(''))})`);
    }

    // 1.5 中文与 emoji 被切在多字节中间（StringDecoder 应兜住）
    {
        const inner = '中文测试🙂';
        const payload = JSON.stringify({ candidates: [{ content: { parts: [{ text: inner }] } }], usageMetadata: {} });
        const buf = Buffer.from(payload, 'utf8');
        const em = await runVirtual([buf.subarray(0, 30), buf.subarray(30)], 'c5');
        ok(textsOf(em, 'c5').join('') === inner, `多字节字符跨块不被截断 (got ${JSON.stringify(textsOf(em, 'c5').join(''))})`);
    }

    // ============================================================
    console.log('\n=== 2. completion 通道：上游 error 块必须上抛（M1 回归）===');
    // ============================================================
    async function runCompletion(chunks, id, nodeId = 'd1') {
        globalThis.__relayEmitted = [];
        installFakeFetch(chunks);
        const ds = new H.CompletionWorkerNode(nodeId, 'sk-test', 'https://fake.invalid', 'deepseek-v4-pro', 'deepseek-official');
        await ds.send(JSON.stringify({ id, path: SSE_PATH, body: {}, method: 'POST' }));
        return globalThis.__relayEmitted;
    }

    {
        const em = await runCompletion(['data: {"error":{"message":"upstream boom","code":503}}\n\n'], 'd1t');
        const f = failureOf(em, 'd1t');
        ok(!!f && /\[Completion Stream Error\]/.test(f.msg.error),
            `error 块上抛为 [Completion Stream Error] (got ${f ? f.msg.error.slice(0, 60) : 'none'})`);
    }

    // 2.2 正常流：reasoning_content → thought，content → 正文，finish_reason + [DONE] → done
    {
        const em = await runCompletion([
            'data: {"choices":[{"delta":{"reasoning_content":"想一下"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"答一句"}}]}\n\n',
            'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n'
        ], 'd2t', 'd2');
        const parts = partsOf(em, 'd2t');
        ok(parts.some(p => p.text === '想一下' && p.thought === true), 'reasoning_content → part{thought:true}');
        ok(parts.some(p => p.text === '答一句' && !p.thought), 'content → 普通 part');
        ok(!!doneOf(em, 'd2t') && !failureOf(em, 'd2t'), 'finish_reason + [DONE] → done:true 无 error');
    }

    // 2.3 零产出且无 finish_reason → 必须抛错换节点，不得伪装成功
    {
        const em = await runCompletion(['data: {"choices":[{"delta":{}}]}\n\n'], 'd3t', 'd3');
        const f = failureOf(em, 'd3t');
        ok(!!f && /Stream Truncated/.test(f.msg.error),
            `零产出断流 → 抛 Stream Truncated 换节点 (got ${f ? f.msg.error.slice(0, 50) : 'none'})`);
    }

    // 2.4 非 2xx → 直接抛 HTTP 状态，不进入流解析
    {
        globalThis.__relayEmitted = [];
        installFakeFetch(['nope'], { okStatus: false, status: 500 });
        const ds = new H.CompletionWorkerNode('d4', 'sk-test', 'https://fake.invalid', 'deepseek-v4-pro', 'deepseek-official');
        await ds.send(JSON.stringify({ id: 'd4t', path: SSE_PATH, body: {}, method: 'POST' }));
        const f = failureOf(globalThis.__relayEmitted, 'd4t');
        ok(!!f && /Completion API 报错 500/.test(f.msg.error), `非 2xx 抛状态码 (got ${f ? f.msg.error.slice(0, 50) : 'none'})`);
    }

    // ============================================================
    console.log('\n=== 3. buildContinuationBody 结构不变量 ===');
    // ============================================================
    {
        const orig = {
            contents: [{ role: 'user', parts: [{ text: '起卦' }] }],
            systemInstruction: { parts: [{ text: '你是卦灵' }] },
            generationConfig: { temperature: 0.7 }
        };
        const snap = JSON.stringify(orig);
        const out = H.buildContinuationBody(orig, '已输出的前半段');
        ok(JSON.stringify(orig) === snap, '原 body 未被就地修改（深拷贝语义）');
        ok(out.contents.length === 3, `contents 追加两轮 (got ${out.contents.length})`);
        ok(out.contents[1].role === 'model' && out.contents[1].parts[0].text === '已输出的前半段', '倒数第二轮为 model/已输出文本');
        ok(out.contents[2].role === 'user' && out.contents[2].parts[0].text === '继续。', '末轮为 user/「继续。」');
        ok(out.systemInstruction.parts.length === 2 && /未完成/.test(out.systemInstruction.parts[1].text), '续传指令追加进 systemInstruction');
        ok(out.generationConfig.temperature === 0.7, 'generationConfig 原样保留');
        ok(out.contents[0].role === 'user', '原始轮次顺序未被扰动（user→model→user 交替）');

        const bare = H.buildContinuationBody({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] }, 'y');
        ok(Array.isArray(bare.systemInstruction?.parts) && bare.systemInstruction.parts.length === 1, '无 systemInstruction 时新建');
        const noContents = H.buildContinuationBody({ generationConfig: {} }, 'z');
        ok(Array.isArray(noContents.contents) && noContents.contents.length === 2, '无 contents 时补齐并追加');
    }

    // ============================================================
    console.log('\n=== 4. 路由边界与故障惩罚 ===');
    // ============================================================
    {
        ok(H.extractModelName('deepseek-v4-pro') === 'deepseek-v4-pro', '裸模型名原样返回（降级循环依赖此行为）');
        ok(H.extractModelName('/v1beta/models/kimi-k3:streamGenerateContent') === 'kimi-k3', '路径中提取模型名');
        ok(H.extractModelName('') === '', '空输入返回空串');
        ok(H.extractModelName('/v1beta/models') === '/v1beta/models', '无下游模型段时原样返回（列表路由依赖此行为）');

        H.appletPool.clear();
        ok(H.getBestNode(SSE_PATH) === null, '空池 → null（调用方据此回 503）');

        const g1 = new H.VirtualWorkerNode('g1', 'k', 'https://x', null, 'gemini-official');
        const ds1 = new H.CompletionWorkerNode('ds1', 'sk', 'https://api.deepseek.com', 'deepseek-v4-pro', 'deepseek-official');
        const ds2 = new H.CompletionWorkerNode('ds2', 'sk', 'https://api.deepseek.com', 'deepseek-v4-pro', 'deepseek-official');
        const zp1 = new H.CompletionWorkerNode('zp1', 'sk', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash', 'zhipu-official');
        [g1, ds1, ds2, zp1].forEach(n => H.appletPool.add(n));

        ok(H.getBestNode('/v1beta/models')?.nodeId === 'g1', '列表请求只落 gemini 节点（不落 Completion）');
        ok(['ds1', 'ds2'].includes(H.getBestNode(DS_PATH)?.nodeId), 'deepseek 模型落官方 Completion 节点');
        ok(H.getBestNode(ZP_PATH)?.nodeId === 'zp1', 'zhipu 系模型只落 zhipu 节点（不与 deepseek 混用）');
        ok(H.getBestNode(SSE_PATH)?.nodeId === 'g1', 'gemini 模型落 gemini 节点');

        // 负载均衡：同 provider 两节点应轮流（lastUsed 最久者优先）
        ds1.pendingTasks = 0; ds2.pendingTasks = 0;
        ds1.lastUsed = 0; ds2.lastUsed = Date.now();
        ok(H.getBestNode(DS_PATH)?.nodeId === 'ds1', '同负载下取 lastUsed 更久者（轮询语义）');

        // 60s 错误惩罚：刚出错的节点应被 +10 载荷推开
        ds1.lastUsed = 0; ds2.lastUsed = 0;
        ds1.lastErrorTime = Date.now();
        ok(H.getBestNode(DS_PATH)?.nodeId === 'ds2', `刚出错节点被 +10 载荷推开 (got ${H.getBestNode(DS_PATH)?.nodeId})`);

        // 惩罚过期后应重新可用
        ds1.lastErrorTime = Date.now() - 61000;
        ds1.lastUsed = 0; ds2.lastUsed = 0;
        ok(H.getBestNode(DS_PATH) !== null, '惩罚窗口(60s)过期后节点重新可用');
    }

    console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;
} finally {
    fs.rmSync(harnessPath, { force: true });
}
