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
    'export { PROVIDER_REGISTRY, MODEL_TO_PROVIDERS, GLOBAL_FALLBACK_MODELS, DEEPSEEK_API_KEYS, OPENCODE_API_KEYS, STABLE_API_KEYS, ZHIPU_API_KEYS, VirtualWorkerNode, CompletionWorkerNode, getBestNode, extractModelName, appletPool, initFallbackIndex, buildContinuationBody };'
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
    ok(H.PROVIDER_REGISTRY['opencode']?.protocol === 'openai-chat', 'opencode 注册且协议 openai-chat');
    ok(H.PROVIDER_REGISTRY['gemini-official']?.protocol === 'gemini-worker', 'gemini-official 注册且协议 gemini-worker');
    ok(H.PROVIDER_REGISTRY['opencode']?.baseUrl.includes('/opencode-proxy/zen/go'), 'opencode baseUrl 走 Vercel 中转（北京不可直连）');
    ok(H.PROVIDER_REGISTRY['opencode']?.models.includes('deepseek-v4-pro')
        && H.PROVIDER_REGISTRY['opencode']?.models.includes('deepseek-v4-flash')
        && H.PROVIDER_REGISTRY['opencode']?.models.includes('glm-5.3')
        && H.PROVIDER_REGISTRY['opencode']?.models.includes('kimi-k3')
        && H.PROVIDER_REGISTRY['opencode']?.models.includes('gpt-5.6-luna')
        && H.PROVIDER_REGISTRY['opencode']?.models.includes('muse-spark-1.3-contributor')
        && H.PROVIDER_REGISTRY['opencode']?.models.length === 6, 'opencode 六模型（deepseek 双档 + glm-5.3 + kimi-k3 + gpt-5.6-luna + muse-spark）');
    ok(!H.PROVIDER_REGISTRY['opencode']?.models.includes('glm-5.2')
        && !H.PROVIDER_REGISTRY['opencode']?.models.includes('minimax-m2.7')
        && !H.PROVIDER_REGISTRY['opencode']?.models.includes('minimax-m3')
        && !H.PROVIDER_REGISTRY['opencode']?.models.includes('mimo-v2.5-pro')
        && !H.PROVIDER_REGISTRY['opencode']?.models.includes('qwen3.8-max')
        && !H.PROVIDER_REGISTRY['opencode']?.models.includes('hy3')
        && !H.PROVIDER_REGISTRY['opencode']?.models.includes('grok-4.5'), 'qwen/minimax/hy3/mimo 系列与 grok 不入字典');
    const gemModels = H.PROVIDER_REGISTRY['gemini-official']?.models || [];
    ok(gemModels.includes('gemini-3.8-flash') && gemModels.includes('gemini-3.7-flash') && gemModels.includes('gemini-3.6-flash') && gemModels.length === 7, 'gemini 七模型（3.8/3.7/3.6 + fallback 四款）');
    ok(JSON.stringify(H.MODEL_TO_PROVIDERS['deepseek-v4-pro']) === JSON.stringify(['deepseek-official', 'opencode']), 'deepseek-v4-pro 反查双 provider');
    ok(H.MODEL_TO_PROVIDERS['glm-5.3']?.length === 1 && H.MODEL_TO_PROVIDERS['glm-5.3'][0] === 'opencode', 'glm-5.3 反查仅 opencode');
    ok(H.MODEL_TO_PROVIDERS['gemini-3.7-flash']?.length === 1 && H.MODEL_TO_PROVIDERS['gemini-3.7-flash'][0] === 'gemini-official', 'gemini-3.7-flash 反查仅 gemini-official');

    console.log('=== 2. 节点 provider 标签 ===');
    const gNode = new H.VirtualWorkerNode('g1', 'k', 'https://x', null, 'gemini-official');
    const dsNode = new H.CompletionWorkerNode('ds1', 'k', 'https://api.deepseek.com', 'deepseek-v4-pro', 'deepseek-official');
    const ocNode = new H.CompletionWorkerNode('oc1', 'k', 'https://proxy.gualing.top/opencode-proxy/zen/go', 'deepseek-v4-pro', 'opencode');
    ok(gNode.provider === 'gemini-official' && gNode.supportsModel('gemini-3.6-flash') && !gNode.supportsModel('deepseek-v4-pro'), 'Gemini 节点支持 gemini 模型、拒 deepseek');
    ok(dsNode.supportsModel('deepseek-v4-pro') && !dsNode.supportsModel('glm-5.3'), 'DeepSeek 官方节点只支持官方模型');
    ok(ocNode.supportsModel('deepseek-v4-pro') && ocNode.supportsModel('glm-5.3') && ocNode.supportsModel('kimi-k3') && !ocNode.supportsModel('gemini-3.7-flash'), 'opencode 节点支持 6 模型、拒 gemini');
    ok(H.STABLE_API_KEYS.every(c => c.provider === 'gemini-official'), '三个 Gemini key 均打 gemini-official 标签');
    ok(H.DEEPSEEK_API_KEYS.every(c => c.provider === 'deepseek-official'), 'DeepSeek key 打 deepseek-official 标签');
    ok(H.OPENCODE_API_KEYS.length === 2 && H.OPENCODE_API_KEYS.every(c => c.provider === 'opencode' && c.key.startsWith('sk-')), 'opencode 双账号 key 均配置且 provider 正确');

    console.log('=== 3. 路由分发（appletPool 注入）===');
    H.appletPool.clear();
    const nodes = {
        g1: new H.VirtualWorkerNode('g1', 'k', 'https://x', null, 'gemini-official'),
        g2: new H.VirtualWorkerNode('g2', 'k', 'https://x', null, 'gemini-official'),
        g3: new H.VirtualWorkerNode('g3', 'k', 'https://x', null, 'gemini-official'),
        ds1: new H.CompletionWorkerNode('ds1', 'k', 'https://api.deepseek.com', 'deepseek-v4-pro', 'deepseek-official'),
        oc1: new H.CompletionWorkerNode('oc1', 'k', 'https://proxy.gualing.top/opencode-proxy/zen/go', 'deepseek-v4-pro', 'opencode'),
    };
    Object.values(nodes).forEach(n => H.appletPool.add(n));
    const deepseekPath = '/v1beta/models/deepseek-v4-pro:streamGenerateContent?alt=sse';

    const b1 = H.getBestNode(deepseekPath);
    ok(b1 && ['ds1', 'oc1'].includes(b1.nodeId), `deepseek-v4-pro 命中双源节点 (got: ${b1?.nodeId})`);
    b1.pendingTasks = 5;
    const b2 = H.getBestNode(deepseekPath);
    ok(b2 && ['ds1', 'oc1'].includes(b2.nodeId) && b2.nodeId !== b1.nodeId, `负载均衡：高负载节点被跳过，选另一 provider (got: ${b2?.nodeId})`);
    b1.pendingTasks = 0;
    b2.pendingTasks = 0;

    const gBest = H.getBestNode('/v1beta/models/glm-5.3:streamGenerateContent?alt=sse');
    ok(gBest && gBest.nodeId === 'oc1', `glm-5.3 只走 opencode (got: ${gBest?.nodeId})`);
    const kBest = H.getBestNode('/v1beta/models/kimi-k3:streamGenerateContent?alt=sse');
    ok(kBest && kBest.nodeId === 'oc1', `kimi-k3 只走 opencode (got: ${kBest?.nodeId})`);
    const gemBest = H.getBestNode('/v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=sse');
    ok(gemBest && ['g1', 'g2', 'g3'].includes(gemBest.nodeId), `gemini-3.7-flash 只走 gemini 节点 (got: ${gemBest?.nodeId})`);

    // failover：exclude 已试节点
    const excl = new Set(['oc1']);
    const fb = H.getBestNode(deepseekPath, excl);
    ok(fb && fb.nodeId === 'ds1', `横向 failover：排除 opencode 后落到官方 (got: ${fb?.nodeId})`);
    const excl2 = new Set(['ds1', 'g1', 'g2', 'g3']);
    const fb2 = H.getBestNode(deepseekPath, excl2);
    ok(fb2 && fb2.nodeId === 'oc1', `横向 failover：排除官方+gemini 后落到 opencode (got: ${fb2?.nodeId})`);
    const noOc = H.getBestNode('/v1beta/models/glm-5.3:streamGenerateContent', excl);
    ok(noOc === null, 'opencode 不可用时 glm-5.3 无节点（触发降级链语义）');

    // 字典外模型回退
    const legacyDs = H.getBestNode('/v1beta/models/deepseek-reasoner:streamGenerateContent');
    ok(legacyDs && ['ds1', 'oc1'].includes(legacyDs.nodeId), `字典外 deepseek 模型回退旧规则 (got: ${legacyDs?.nodeId})`);
    const legacyGem = H.getBestNode('/v1beta/models/gemini-2.5-flash:streamGenerateContent');
    ok(legacyGem && ['g1', 'g2', 'g3'].includes(legacyGem.nodeId), `字典外 gemini 模型回退旧规则 (got: ${legacyGem?.nodeId})`);

    // 60s 错误惩罚
    nodes.ds1.pendingTasks = 0; nodes.oc1.pendingTasks = 0;
    nodes.oc1.lastErrorTime = Date.now();
    const penalized = H.getBestNode(deepseekPath);
    ok(penalized && penalized.nodeId === 'ds1', `lastErrorTime 60s 惩罚生效，避开刚出错节点 (got: ${penalized?.nodeId})`);

    console.log('=== 4. fallback 全量链 ===');
    const fbChain = H.GLOBAL_FALLBACK_MODELS;
    ok(fbChain.length === 14, `全量链 14 模型 (got ${fbChain.length})`);
    ok(fbChain[0] === 'gemini-3.8-flash', '链首 gemini-3.8-flash（2026-09-03 起主模型入链）');
    ok(fbChain[1] === 'gemini-3.7-flash' && fbChain[2] === 'gemini-3.6-flash', 'gemini 支线 3.8 → 3.7 → 3.6（首级回退位）');
    ok(fbChain[3] === 'muse-spark-1.3-contributor' && fbChain[4] === 'glm-5.3-flash', '新锐支线：muse-spark → glm-5.3-flash');
    // 2026-09-13 已裁定：副线顺序以 GLOBAL_FALLBACK_MODELS 数组为准（DS4F 紧随 DS4P）。
    // 源文件 L17 注释曾与此矛盾，同日已改注释对齐数组（只纠文字、不动行为）。
    ok(fbChain[5] === 'deepseek-v4-pro' && fbChain[6] === 'deepseek-v4-flash' && fbChain[7] === 'gpt-5.6-luna' && fbChain[8] === 'glm-5.3' && fbChain[9] === 'kimi-k3', '副线数组实况：DS4P → DS4F → gpt → glm-5.3 → k3');
    ok(fbChain.includes('glm-5.3') && fbChain.includes('deepseek-v4-flash') && fbChain.includes('gpt-5.6-luna'), '付费模型全部入链（含 gpt-5.6-luna）');
    ok(fbChain.indexOf('gpt-5.6-luna') < fbChain.indexOf('glm-5.3') && fbChain.indexOf('glm-5.3') < fbChain.indexOf('kimi-k3'), '用户调序：gpt 在 GLM 前、GLM 在 K3 前');
    const lastDomestic = fbChain.indexOf('gpt-5.6-luna');
    const firstOldGemini = Math.min(fbChain.indexOf('gemini-3.5-flash'), fbChain.indexOf('gemini-3.5-flash-lite'), fbChain.indexOf('gemini-3.1-flash-lite'), fbChain.indexOf('gemini-3-flash-preview'));
    ok(lastDomestic < firstOldGemini, '老旧 gemini flash 全部垫底');
    ok(fbChain.every(m => H.MODEL_TO_PROVIDERS[m] || m.includes('gemini') || m.includes('deepseek')), '链内每个模型都可被字典或回退逻辑路由');
    ok(H.PROVIDER_REGISTRY['opencode']?.models.every(m => fbChain.includes(m)), '字典内全部 opencode 模型均在 fallback 链中（gpt 已补齐）');

    console.log('=== 4.5 降级起点 = 当前主模型下一位 ===');
    // 注意：真实运行时 pendingRequests 创建时 fallbackIndex 初始为 -1（未定位哨兵）
    const r1 = { originalPath: '/v1beta/models/kimi-k3:streamGenerateContent', fallbackIndex: -1 };
    H.initFallbackIndex(r1);
    ok(r1.fallbackIndex === 9 && H.GLOBAL_FALLBACK_MODELS[r1.fallbackIndex + 1] === 'gemini-3.5-flash', `K3 失败 → 下一位 gemini-3.5-flash (got ${r1.fallbackIndex} → ${H.GLOBAL_FALLBACK_MODELS[r1.fallbackIndex + 1]})`);
    const r2 = { originalPath: '/v1beta/models/gemini-3.7-flash:streamGenerateContent', fallbackIndex: -1 };
    H.initFallbackIndex(r2);
    ok(r2.fallbackIndex === 1 && H.GLOBAL_FALLBACK_MODELS[r2.fallbackIndex + 1] === 'gemini-3.6-flash', `3.7-flash 失败 → 下一位 3.6-flash (got ${r2.fallbackIndex} → ${H.GLOBAL_FALLBACK_MODELS[r2.fallbackIndex + 1]})`);
    const r3 = { originalPath: '/v1beta/models/deepseek-v4-pro:streamGenerateContent', fallbackIndex: -1 };
    H.initFallbackIndex(r3);
    ok(r3.fallbackIndex === 5 && H.GLOBAL_FALLBACK_MODELS[r3.fallbackIndex + 1] === 'deepseek-v4-flash', `DS4P 失败 → 下一位 DS4F (got ${r3.fallbackIndex} → ${H.GLOBAL_FALLBACK_MODELS[r3.fallbackIndex + 1]})`);
    const r5 = { originalPath: '/v1beta/models/unknown-model-xyz:streamGenerateContent', fallbackIndex: -1 };
    H.initFallbackIndex(r5);
    ok(r5.fallbackIndex === -1, `未知模型 → -1（从链头开始）(got ${r5.fallbackIndex})`);
    const r6 = { originalPath: '/v1beta/models/kimi-k3:streamGenerateContent', fallbackIndex: 5 };
    H.initFallbackIndex(r6);
    ok(r6.fallbackIndex === 5, '已定位的 fallbackIndex(>=0) 不被覆盖');

    console.log('=== 5. 源码完整性 ===');
    ok(/function handleTimeout\(id\)\s*{/.test(src), 'handleTimeout 函数已定义（不再 ReferenceError）');
    ok(!/https:\/\/opencode\.ai\/zen\/go\/v1['"]/.test(src.replace(/.*opencode-proxy.*/gs, '')), '无任何直连 opencode.ai 的 baseUrl 残留');

    console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;
} finally {
    fs.rmSync(harnessPath, { force: true });
}
