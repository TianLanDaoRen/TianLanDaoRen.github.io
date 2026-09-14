// relay-core.test.mjs — gemini-relay.js 内核行为回归测试（2026-09-13 全量审阅后新建）
//
// 与 relay-router.test.mjs 的分工：
//   · relay-router.test.mjs —— 供应商字典与路由分发的**静态快照**断言（配置改了要重定基线）
//   · 本文件              —— 运行时**行为**断言：用假 fetch 喂分块数据，驱动真实解析器，
//                            断言"喂进去什么、吐出来什么"，不依赖任何配置数值
//
// 覆盖 2026-09-13 全量审阅发现的逻辑漏洞，均已成为本文件的回归护栏：
//   H1 流式 JSON 扫描器状态失同步：对象跨 chunk 且含嵌套括号时，旧 depth/inString 被重复累加，
//      导致对象永远合不拢、该请求解析静默停摆（§1.2/§1.3 即复现该场景）
//   M1 completion 通道上游 error 块被 catch 无差别吞掉（[Completion Stream Error] 曾是死代码）
//   M2 流中途未捕获异常不了结响应，客户端空等至 REQUEST_TIMEOUT(600s)，任务与节点配额双双挂住
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

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
    'const pendingRequests = new Map();', // 生产文件中定义在各 @slice 之外，补齐供兜底收尾函数使用
    slice('config'), slice('classes'), slice('router'), slice('continuation'), slice('finalize'), slice('helpers'),
    'export { VirtualWorkerNode, CompletionWorkerNode, getBestNode, extractModelName, initFallbackIndex, buildContinuationBody, finalizeRequestOnException, appletPool, pendingRequests, GLOBAL_FALLBACK_MODELS };'
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

// —— 假 res：记录写入、可判定了结状态 ——
function makeRes() {
    const rec = { wrote: [], status: null, json: null, ended: false };
    return {
        rec,
        res: {
            get writableEnded() { return rec.ended; },
            setHeader() { }, flushHeaders() { },
            write(s) { rec.wrote.push(String(s)); return true; },
            end() { rec.ended = true; },
            status(c) { rec.status = c; return { json(b) { rec.json = b; } }; }
        }
    };
}
function armedTimer() { const h = setTimeout(() => { }, 60000); if (h.unref) h.unref(); return h; }

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
// 💡 用 canonical id：deepseek-v4-pro 现已下架，只有官方还承载它；
//    deepseek-flash 才是三 provider（官方 + CC 双通道）共用的那款，路由测试必须用它。
const DS_PATH = '/v1beta/models/deepseek-flash:streamGenerateContent?alt=sse';
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
    console.log('=== 0. 全文语法自检（覆盖未被切片的区段：WS 分发器 / 兜底收尾 / 定时器）===');
    // ============================================================
    {
        const tmp = path.join(os.tmpdir(), 'relay-whole-syntax.mjs');
        fs.writeFileSync(tmp, src);
        let okSyntax = true, errMsg = '';
        try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
        catch (e) { okSyntax = false; errMsg = (e.stderr || Buffer.from('')).toString().slice(0, 200); }
        finally { fs.rmSync(tmp, { force: true }); }
        ok(okSyntax, okSyntax ? '全文语法通过（node --check 整文件）' : `全文语法失败: ${errMsg}`);
    }

    // ============================================================
    console.log('\n=== 1. 流式 JSON 扫描器：分块边界不得破坏解析 ===');
    // ============================================================
    const CH_A = '{"candidates":[{"content":{"parts":[{"text":"甲"}]}}]}';
    const CH_B = '{"candidates":[{"content":{"parts":[{"text":"乙"}]}}],"usageMetadata":{"totalTokenCount":7}}';

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
        const em = await runVirtual(Array.from(CH_A + CH_B), 'c3');
        ok(textsOf(em, 'c3').join('') === '甲乙', `逐字符切块 → 仍解析出甲乙 (got ${JSON.stringify(textsOf(em, 'c3').join(''))})`);
        ok(!!doneOf(em, 'c3'), '逐字符切块后仍正常收尾');
    }

    // 1.4 字符串值内含花括号与引号，且切点落在字符串中间
    {
        const inner = '花括号{"a":1} 与 "引号" 包裹';
        const payload = JSON.stringify({ candidates: [{ content: { parts: [{ text: inner }] } }], usageMetadata: {} });
        const at = payload.indexOf('花括号') + 3;
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

    {
        const em = await runCompletion(['data: {"choices":[{"delta":{}}]}\n\n'], 'd3t', 'd3');
        const f = failureOf(em, 'd3t');
        ok(!!f && /Stream Truncated/.test(f.msg.error),
            `零产出断流 → 抛 Stream Truncated 换节点 (got ${f ? f.msg.error.slice(0, 50) : 'none'})`);
    }

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

        ds1.pendingTasks = 0; ds2.pendingTasks = 0;
        ds1.lastUsed = 0; ds2.lastUsed = Date.now();
        ok(H.getBestNode(DS_PATH)?.nodeId === 'ds1', '同负载下取 lastUsed 更久者（轮询语义）');

        ds1.lastUsed = 0; ds2.lastUsed = 0;
        ds1.lastErrorTime = Date.now();
        ok(H.getBestNode(DS_PATH)?.nodeId === 'ds2', `刚出错节点被惩罚机制推开（新逻辑走惩罚分层，不再靠 +10 载荷）(got ${H.getBestNode(DS_PATH)?.nodeId})`);

        ds1.lastErrorTime = Date.now() - 61000;
        ds1.lastUsed = 0; ds2.lastUsed = 0;
        ok(H.getBestNode(DS_PATH) !== null, '惩罚窗口(60s)过期后节点重新可用');
    }

    // ============================================================
    console.log('\n=== 5. 异常兜底收尾（M2 回归）===');
    // ============================================================
    {
        // 5.1 流已开始 → 发中断标记并了结，配额与账目立即释放
        H.pendingRequests.clear();
        const a = makeRes();
        const ws1 = { nodeId: 'n1', pendingTasks: 2 };
        H.pendingRequests.set('x1', {
            res: a.res, hasStartedStream: true, isSSE: true,
            timeoutId: armedTimer(), firstChunkTimeoutId: armedTimer()
        });
        H.finalizeRequestOnException(ws1, 'x1', new Error('boom'));
        ok(ws1.pendingTasks === 1, `节点配额被立即释放 (got ${ws1.pendingTasks})`);
        ok(H.pendingRequests.has('x1') === false, '任务从待办表清除（不再挂到 600s）');
        ok(a.rec.wrote.some(s => s.includes('stream_interrupted')), 'SSE 流收到中断标记');
        ok(a.rec.ended === true, '响应被了结（客户端不再空等）');

        // 5.2 流未开始 → 立即 500，而不是空等超时
        H.pendingRequests.clear();
        const b = makeRes();
        const ws2 = { nodeId: 'n2', pendingTasks: 1 };
        H.pendingRequests.set('x2', {
            res: b.res, hasStartedStream: false, isSSE: true,
            timeoutId: armedTimer(), firstChunkTimeoutId: null
        });
        H.finalizeRequestOnException(ws2, 'x2', new Error('state machine fail'));
        ok(b.rec.status === 500 && b.rec.json?.error?.status === 'INTERNAL_ERROR', '未开始流 → 立即回 500 而非空等');
        ok(H.pendingRequests.has('x2') === false, '任务已清账');

        // 5.3 幂等：对已清账任务二次调用不得重复扣减配额（先人为抬高载荷，否则 0 与 0 无从区分）
        ws2.pendingTasks = 3;
        H.finalizeRequestOnException(ws2, 'x2', new Error('again'));
        ok(ws2.pendingTasks === 3, `对已清账任务不重复扣减配额（幂等）(got ${ws2.pendingTasks})`);

        // 5.4 id 缺失（JSON.parse 阶段就炸）→ 不触碰任何状态
        const ws3 = { nodeId: 'n3', pendingTasks: 5 };
        H.finalizeRequestOnException(ws3, null, new Error('no id'));
        ok(ws3.pendingTasks === 5, 'id 缺失时不动任何状态');

        // 5.5 静态护栏：catch 里确实挂了这个兜底（防日后被删）
        ok(/catch \(e\) \{[\s\S]{0,900}?finalizeRequestOnException\(ws, taskId, e\);/.test(src),
            'handleIncomingWSMessage 的 catch 内确实调用兜底收尾（静态护栏）');
        ok(/let taskId = null;/.test(src), 'taskId 已提到 try 之外（否则 catch 取不到 id）');
    }

    // ============================================================
    console.log('\n=== 6. 别名层：canonical id → provider 原生 id（2026-09-13 新增）===');
    // ============================================================
    {
        const body = { contents: [{ role: 'user', parts: [{ text: 'x' }] }] };
        const mk = (provider, baseUrl) => new H.CompletionWorkerNode('t', 'k', baseUrl, 'deepseek-flash', provider);

        const cc = mk('commandcode', 'https://api.commandcode.ai/provider');
        ok(cc.convertGeminiToCompletion(body, 'deepseek-flash').model === 'deepseek/deepseek-v4.1-flash',
            'CC: deepseek-flash → deepseek/deepseek-v4.1-flash');
        ok(cc.convertGeminiToCompletion(body, 'glm-5.3-flash').model === 'z-ai/glm-5.3-flash',
            'CC: glm-5.3-flash → z-ai/glm-5.3-flash（前缀带连字符，最易写错的一处）');
        ok(cc.convertGeminiToCompletion(body, 'gpt-5.6-luna').model === 'gpt-5.6-luna',
            'CC: gpt-5.6-luna 恒等（官方清单里它就是无前缀）');
        ok(cc.convertGeminiToCompletion(body, 'unknown-model-xyz').model === 'unknown-model-xyz',
            'CC: 未配别名的模型原样透传（别名表是可选白名单，不是全量映射）');
        ok(cc.convertGeminiToCompletion(body, undefined).model !== undefined, 'CC: 不传模型时走 defaultModel 且不炸');

        const ds = mk('deepseek-official', 'https://api.deepseek.com');
        ok(ds.convertGeminiToCompletion(body, 'deepseek-flash').model === 'deepseek-flash',
            'DeepSeek 官方：无 aliases → canonical 即原生，行为零变化');
        const zp = mk('zhipu-official', 'https://open.bigmodel.cn/api/paas/v4');
        ok(zp.convertGeminiToCompletion(body, 'glm-5.3-flash').model === 'glm-5.3-flash',
            '智谱官方：同上，未被别名层波及');
    }

    // ============================================================
    console.log('\n=== 7. 优先级分层：CC 未炸就绝不轮到官方（2026-09-13 新增）===');
    // ============================================================
    {
        H.appletPool.clear();
        const cc = new H.CompletionWorkerNode('ccA', 'k', 'https://api.commandcode.ai/provider', 'deepseek-flash', 'commandcode');
        const off = new H.CompletionWorkerNode('offA', 'k', 'https://api.deepseek.com', 'deepseek-flash', 'deepseek-official');
        off.priority = 1;   // 官方直连 = 备胎档
        H.appletPool.add(cc); H.appletPool.add(off);

        cc.pendingTasks = 99;   // 故意把 CC 压到极忙
        ok(H.getBestNode(DS_PATH)?.nodeId === 'ccA', '优先级优先于负载：CC 再多在途任务也不溢出到官方（省真金白银）');

        cc.lastErrorTime = Date.now();
        ok(H.getBestNode(DS_PATH)?.nodeId === 'offA', 'CC 进 60s 惩罚窗 → 官方自动接管（无需人工干预）');

        cc.lastErrorTime = Date.now() - 61000;
        ok(H.getBestNode(DS_PATH)?.nodeId === 'ccA', '惩罚窗过期 → CC 自动夺回');

        cc.lastErrorTime = Date.now(); off.lastErrorTime = Date.now();
        ok(H.getBestNode(DS_PATH)?.nodeId === 'ccA', '两层都在惩罚窗内时退回惩罚层内挑，仍按优先级取 CC（绝不返回 null）');
        ok(H.getBestNode(DS_PATH) !== null, '全池被惩罚时仍返回节点（不允许 null 打断在途请求）');

        H.appletPool.clear();
        ok(H.getBestNode(DS_PATH) === null, '真空池才返回 null');
    }

    console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;
} finally {
    fs.rmSync(harnessPath, { force: true });
}
