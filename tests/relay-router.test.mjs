// relay-router.test.mjs — gemini-relay.js 供应商字典与路由逻辑回归测试
// 直接提取生产文件源码切片构造隔离 harness（不启动服务器、不发请求），tests/ 目录不入库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RELAY = path.resolve(process.argv[2] || '/Users/yunsisanren/Documents/Workspaces/VSCWorkspace/GualingAI/gemini-relay.js');
const src = fs.readFileSync(RELAY, 'utf8');

function sliceBetween(label, startAnchor, endAnchor) {
    const s = src.indexOf(startAnchor);
    const e = src.indexOf(endAnchor, s);
    if (s === -1 || e === -1) throw new Error(`anchor not found for ${label}`);
    return src.slice(s, e);
}

// 切片改用生产文件里显式埋设的 @slice 标记（2026-09-13 插桩）——
// 原先按注释文案切片，任何一句注释被改写都会把 harness 打断（这份测试就是这样烂掉两个月的）。
function slice(label) {
    return sliceBetween(label, `// @slice:${label}:start`, `// @slice:${label}:end`);
}

// config：降级链 / 四类 key / PROVIDER_REGISTRY / MODEL_TO_PROVIDERS / 超时与续传常量
const A = slice('config');
// classes：VirtualWorkerNode / CompletionWorkerNode
const B = slice('classes');
// router：getBestNode
const C = slice('router');
// continuation：buildContinuationBody
const D = slice('continuation');
// helpers：extractModelName / initFallbackIndex / handleTimeout
const E = slice('helpers');

const harness = [
    "import { StringDecoder } from 'node:string_decoder';",
    'function handleIncomingWSMessage() {}', // stub：测试不触发真实分发
    'globalThis.fetch = async () => { throw new Error("fetch not allowed in test"); };',
    'const appletPool = new Set();', // 生产文件中定义在 @slice:classes 之外，此处手动补齐
    A, B, C, D, E,
    'export { PROVIDER_REGISTRY, MODEL_TO_PROVIDERS, GLOBAL_FALLBACK_MODELS, DEEPSEEK_API_KEYS, OPENCODE_API_KEYS, COMMANDCODE_API_KEYS, STABLE_API_KEYS, ZHIPU_API_KEYS, ENABLE_OPENCODE, VirtualWorkerNode, CompletionWorkerNode, getBestNode, extractModelName, appletPool, initFallbackIndex, buildContinuationBody };'
].join('\n');

const harnessPath = path.join(os.tmpdir(), 'relay-router-harness.mjs');
fs.writeFileSync(harnessPath, harness);

let passed = 0, failed = 0;
function ok(cond, label) {
    if (cond) { passed++; console.log('  ✅', label); }
    else { failed++; console.error('  ❌', label); }
}

try {
    const H = await import(pathToFileURL(harnessPath).href + '?t=' + Date.now());
    console.log('=== 1. 供应商字典 ===');
    ok(H.PROVIDER_REGISTRY['deepseek-official']?.protocol === 'openai-chat', 'deepseek-official 注册且协议 openai-chat');
    ok(H.PROVIDER_REGISTRY['zhipu-official']?.protocol === 'openai-chat', 'zhipu-official 注册且协议 openai-chat');
    ok(H.PROVIDER_REGISTRY['commandcode']?.protocol === 'openai-chat', 'commandcode 注册且协议 openai-chat');
    ok(H.PROVIDER_REGISTRY['gemini-official']?.protocol === 'gemini-worker', 'gemini-official 注册且协议 gemini-worker');
    ok(H.PROVIDER_REGISTRY['commandcode']?.baseUrl === 'https://api.commandcode.ai/provider', 'commandcode 直连 CC 官方 baseUrl（代码补 /v1/chat/completions）');
    ok(H.PROVIDER_REGISTRY['commandcode-proxy']?.baseUrl.includes('/commandcode-proxy/provider'), 'commandcode-proxy 走 Vercel 兜底通道（直连实测 8/10 抖动）');
    ok(H.ENABLE_OPENCODE === false && H.PROVIDER_REGISTRY['opencode'] === undefined, 'opencode 总闸关闭：provider 不再注册');
    ok(JSON.stringify(H.PROVIDER_REGISTRY['commandcode']?.models) === JSON.stringify(['deepseek-flash', 'glm-5.3-flash', 'gpt-5.6-luna']),
        'commandcode 只承载 canonical 三款（deepseek-flash / glm-5.3-flash / gpt-5.6-luna）');
    ok(H.PROVIDER_REGISTRY['commandcode']?.aliases['deepseek-flash'] === 'deepseek/deepseek-v4.1-flash'
        && H.PROVIDER_REGISTRY['commandcode']?.aliases['glm-5.3-flash'] === 'z-ai/glm-5.3-flash'
        && H.PROVIDER_REGISTRY['commandcode']?.aliases['gpt-5.6-luna'] === 'gpt-5.6-luna',
        'aliases 三个原生 id 与 CC 官方清单一致（glm 前缀 z-ai 带连字符，luna 无前缀）');
    const gemModels = H.PROVIDER_REGISTRY['gemini-official']?.models || [];
    ok(gemModels.includes('gemini-3.8-flash') && gemModels.includes('gemini-3.7-flash') && gemModels.includes('gemini-3.6-flash') && gemModels.length === 7, 'gemini 七模型（3.8/3.7/3.6 + fallback 四款）');
    ok(JSON.stringify(H.MODEL_TO_PROVIDERS['deepseek-flash']) === JSON.stringify(['deepseek-official', 'commandcode', 'commandcode-proxy']), 'deepseek-flash 反查三 provider（官方 + CC 双通道）');
    ok(JSON.stringify(H.MODEL_TO_PROVIDERS['glm-5.3-flash']) === JSON.stringify(['zhipu-official', 'commandcode', 'commandcode-proxy']), 'glm-5.3-flash 反查：智谱官方 + CC 双通道');
    ok(JSON.stringify(H.MODEL_TO_PROVIDERS['gpt-5.6-luna']) === JSON.stringify(['commandcode', 'commandcode-proxy']), 'gpt-5.6-luna 只有 CC 双通道（任何官方均无此模型）');
    ok(H.MODEL_TO_PROVIDERS['gemini-3.7-flash']?.length === 1 && H.MODEL_TO_PROVIDERS['gemini-3.7-flash'][0] === 'gemini-official', 'gemini-3.7-flash 反查仅 gemini-official');
    ok(!H.MODEL_TO_PROVIDERS['glm-5.3'] && !H.MODEL_TO_PROVIDERS['kimi-k3'] && !H.MODEL_TO_PROVIDERS['muse-spark-1.3-contributor']
        && !H.MODEL_TO_PROVIDERS['deepseek-v4-flash'], 'opencode 时代旧模型全部退出字典（glm-5.3/kimi-k3/muse/deepseek-v4-flash）');

    console.log('=== 2. 节点 provider 标签 ===');
    const gNode = new H.VirtualWorkerNode('g1', 'k', 'https://x', null, 'gemini-official');
    const dsNode = new H.CompletionWorkerNode('ds1', 'k', 'https://api.deepseek.com', 'deepseek-flash', 'deepseek-official');
    const ccNode = new H.CompletionWorkerNode('cc1', 'k', 'https://api.commandcode.ai/provider', 'deepseek-flash', 'commandcode');
    ok(gNode.provider === 'gemini-official' && gNode.supportsModel('gemini-3.6-flash') && !gNode.supportsModel('deepseek-flash'), 'Gemini 节点支持 gemini 模型、拒 deepseek');
    ok(dsNode.supportsModel('deepseek-flash') && !dsNode.supportsModel('glm-5.3-flash'), 'DeepSeek 官方节点只支持自家模型');
    ok(ccNode.supportsModel('deepseek-flash') && ccNode.supportsModel('glm-5.3-flash') && ccNode.supportsModel('gpt-5.6-luna') && !ccNode.supportsModel('gemini-3.7-flash'), 'commandcode 节点支持 canonical 三款、拒 gemini');
    ok(H.STABLE_API_KEYS.every(c => c.provider === 'gemini-official'), '三个 Gemini key 均打 gemini-official 标签');
    ok(H.DEEPSEEK_API_KEYS.every(c => c.provider === 'deepseek-official'), 'DeepSeek key 打 deepseek-official 标签');
    ok(H.OPENCODE_API_KEYS.length === 2, 'opencode 双账号配置仍留在源码里（总闸翻 true 即复用）');
    ok(H.COMMANDCODE_API_KEYS.length === 2
        && H.COMMANDCODE_API_KEYS[0].provider === 'commandcode'
        && H.COMMANDCODE_API_KEYS[1].provider === 'commandcode-proxy'
        && H.COMMANDCODE_API_KEYS.every(c => c.priority === 0), 'Command Code 双通道已就绪（直连 + Vercel 兜底，priority 0）');
    ok(gNode.priority === 0 && ccNode.priority === 0, '节点类 priority 默认 0（官方档靠挂载时覆写为 1，见 §3 手工对齐）');

    console.log('=== 3. 路由分发（appletPool 注入）===');
    H.appletPool.clear();
    const nodes = {
        g1: new H.VirtualWorkerNode('g1', 'k', 'https://x', null, 'gemini-official'),
        g2: new H.VirtualWorkerNode('g2', 'k', 'https://x', null, 'gemini-official'),
        g3: new H.VirtualWorkerNode('g3', 'k', 'https://x', null, 'gemini-official'),
        ds1: new H.CompletionWorkerNode('ds1', 'k', 'https://api.deepseek.com', 'deepseek-flash', 'deepseek-official'),
        cc1: new H.CompletionWorkerNode('cc1', 'k', 'https://api.commandcode.ai/provider', 'deepseek-flash', 'commandcode'),
        cc2: new H.CompletionWorkerNode('cc2', 'k', 'https://proxy.gualing.top/commandcode-proxy/provider', 'deepseek-flash', 'commandcode-proxy'),
        zp1: new H.CompletionWorkerNode('zp1', 'sk', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash', 'zhipu-official'),
    };
    // 💡 官方节点在真实挂载时会被覆写为 priority 1，这里手工对齐，保证测试语义与生产一致
    nodes.ds1.priority = 1;
    nodes.zp1.priority = 1;
    Object.values(nodes).forEach(n => H.appletPool.add(n));
    const deepseekPath = '/v1beta/models/deepseek-flash:streamGenerateContent?alt=sse';

    const b1 = H.getBestNode(deepseekPath);
    ok(b1 && ['cc1', 'cc2'].includes(b1.nodeId), `deepseek-flash 优先落 CC 双通道 (got: ${b1?.nodeId})`);
    b1.pendingTasks = 5;
    const b2 = H.getBestNode(deepseekPath);
    ok(b2 && ['cc1', 'cc2'].includes(b2.nodeId) && b2.nodeId !== b1.nodeId, `CC 双通道内部负载均衡（不溢出到官方）(got: ${b2?.nodeId})`);
    b1.pendingTasks = 0;
    b2.pendingTasks = 0;

    ok(['cc1', 'cc2'].includes(H.getBestNode('/v1beta/models/glm-5.3-flash:streamGenerateContent?alt=sse')?.nodeId), 'glm-5.3-flash 优先落 CC（智谱官方降为备胎）');
    ok(['cc1', 'cc2'].includes(H.getBestNode('/v1beta/models/gpt-5.6-luna:streamGenerateContent?alt=sse')?.nodeId), 'gpt-5.6-luna 只可能落 CC 双通道');
    const gemBest = H.getBestNode('/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    ok(gemBest && ['g1', 'g2', 'g3'].includes(gemBest.nodeId), `gemini-3.8-flash 只走 gemini 节点 (got: ${gemBest?.nodeId})`);

    // 优先级分层：CC 双通道全被排除 → 自动轮到官方备胎档
    const exclCc = new Set(['cc1', 'cc2']);
    ok(H.getBestNode(deepseekPath, exclCc)?.nodeId === 'ds1', 'CC 双通道全排除后，自动轮到 DeepSeek 官方接管');
    ok(H.getBestNode('/v1beta/models/glm-5.3-flash:streamGenerateContent', exclCc)?.nodeId === 'zp1', 'glm-5.3-flash 在 CC 排除后轮到智谱官方');
    ok(H.getBestNode('/v1beta/models/gpt-5.6-luna:streamGenerateContent', exclCc) === null, 'luna 无官方备胎：CC 全排除后为 null（交给降级链处理）');

    // 字典外模型回退（仍受优先级分层约束：未知 deepseek 模型也优先 CC）
    const legacyDs = H.getBestNode('/v1beta/models/deepseek-reasoner:streamGenerateContent');
    ok(legacyDs && ['cc1', 'cc2'].includes(legacyDs.nodeId), `字典外 deepseek 模型回退旧规则且仍优先 CC (got: ${legacyDs?.nodeId})`);
    const legacyGem = H.getBestNode('/v1beta/models/gemini-2.5-flash:streamGenerateContent');
    ok(legacyGem && ['g1', 'g2', 'g3'].includes(legacyGem.nodeId), `字典外 gemini 模型回退旧规则 (got: ${legacyGem?.nodeId})`);

    // 惩罚与接管：CC 一个出错 → 另一条接；CC 全出错 → 官方接管
    nodes.cc1.pendingTasks = 0; nodes.cc2.pendingTasks = 0; nodes.ds1.pendingTasks = 0;
    nodes.cc1.lastErrorTime = Date.now();
    ok(H.getBestNode(deepseekPath)?.nodeId === 'cc2', 'CC 直连出错 → 同档的另一条 Vercel 通道接手');
    nodes.cc2.lastErrorTime = Date.now();
    ok(H.getBestNode(deepseekPath)?.nodeId === 'ds1', 'CC 双通道都进惩罚窗 → 官方备胎档自动接管（无需人工干预）');
    nodes.cc1.lastErrorTime = 0; nodes.cc2.lastErrorTime = 0;
    ok(['cc1', 'cc2'].includes(H.getBestNode(deepseekPath)?.nodeId), '惩罚窗清除后 CC 自动夺回（官方不再参与）');

    console.log('=== 4. fallback 全量链 ===');
    const fbChain = H.GLOBAL_FALLBACK_MODELS;
    ok(fbChain.length === 10, `全量链 10 站 (got ${fbChain.length})`);
    ok(fbChain[0] === 'gemini-3.8-flash' && fbChain[1] === 'gemini-3.7-flash' && fbChain[2] === 'gemini-3.6-flash', 'gemini 支线 3.8 → 3.7 → 3.6（主 + 首级回退，位置不动）');
    ok(fbChain[3] === 'deepseek-flash' && fbChain[4] === 'glm-5.3-flash' && fbChain[5] === 'gpt-5.6-luna',
        'CC 段按「请求量 × 稀缺度」排：deepseek-flash 主力 → glm-5.3-flash → luna 沉底（GOAT 额度最小）');
    ok(fbChain.slice(6).join(',') === 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3-flash-preview', '老旧 gemini 四站垫底');
    ok(fbChain.every(m => H.MODEL_TO_PROVIDERS[m]), '链内每个模型都能被字典路由（canonical id 化后不再有 indexOf=-1 的孤儿）');
    ok(H.PROVIDER_REGISTRY['commandcode'].models.every(m => fbChain.includes(m)), 'CC 承载的三款全部在链中');
    ok(!fbChain.includes('muse-spark-1.3-contributor') && !fbChain.includes('glm-5.3') && !fbChain.includes('kimi-k3'), 'opencode 时代旧模型已退出降级链');

    console.log('=== 4.5 降级起点 = 当前主模型下一位 ===');
    // 注意：真实运行时 pendingRequests 创建时 fallbackIndex 初始为 -1（未定位哨兵）
    const r1 = { originalPath: '/v1beta/models/gpt-5.6-luna:streamGenerateContent', fallbackIndex: -1 };
    H.initFallbackIndex(r1);
    ok(r1.fallbackIndex === 5 && H.GLOBAL_FALLBACK_MODELS[6] === 'gemini-3.5-flash', `luna 失败 → 下一位 gemini-3.5-flash (got ${r1.fallbackIndex})`);
    const r2 = { originalPath: '/v1beta/models/gemini-3.7-flash:streamGenerateContent', fallbackIndex: -1 };
    H.initFallbackIndex(r2);
    ok(r2.fallbackIndex === 1 && H.GLOBAL_FALLBACK_MODELS[2] === 'gemini-3.6-flash', `3.7-flash 失败 → 下一位 3.6-flash (got ${r2.fallbackIndex})`);
    const r3 = { originalPath: '/v1beta/models/deepseek-flash:streamGenerateContent', fallbackIndex: -1 };
    H.initFallbackIndex(r3);
    ok(r3.fallbackIndex === 3 && H.GLOBAL_FALLBACK_MODELS[4] === 'glm-5.3-flash', `deepseek-flash 失败 → 下一位 glm-5.3-flash (got ${r3.fallbackIndex})`);
    const r5 = { originalPath: '/v1beta/models/unknown-model-xyz:streamGenerateContent', fallbackIndex: -1 };
    H.initFallbackIndex(r5);
    ok(r5.fallbackIndex === -1, `未知模型 → -1（从链头开始）(got ${r5.fallbackIndex})`);
    const r6 = { originalPath: '/v1beta/models/deepseek-flash:streamGenerateContent', fallbackIndex: 3 };
    H.initFallbackIndex(r6);
    ok(r6.fallbackIndex === 3, '已定位的 fallbackIndex(>=0) 不被覆盖');

    console.log('=== 5. 源码完整性 ===');
    ok(/function handleTimeout\(id\)\s*{/.test(src), 'handleTimeout 函数已定义（不再 ReferenceError）');
    ok(!/https:\/\/opencode\.ai\/zen\/go\/v1['"]/.test(src.replace(/.*opencode-proxy.*/gs, '')), '无任何直连 opencode.ai 的 baseUrl 残留');
    ok((src.match(/if \(ENABLE_OPENCODE\) \{/g) || []).length === 2, 'opencode 条件块两处（注册 + 挂载）都在源码里，改一个字即可复活');
    ok((src.match(/ENABLE_OPENCODE && this\.provider === 'opencode'/g) || []).length === 2, '两处 x-opencode-session 均已受总闸控制');
    ok(!/if \(this\.provider === 'opencode'\)/.test(src), '不存在未受总闸控制的 opencode 分支残留');

    console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;
} finally {
    fs.rmSync(harnessPath, { force: true });
}
