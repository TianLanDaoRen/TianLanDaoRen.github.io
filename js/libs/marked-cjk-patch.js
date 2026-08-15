/**
 * marked-cjk-patch.js
 * 修复 marked (v17) 对中文标点（《》「」（）【】等）强调解析的"水土不服"问题。
 *
 * 根因：marked 的强调（em/strong）闭合判定使用 Unicode 标点类 \p{P} + 符号类 \p{S}，
 *       并按 CommonMark flanking 规则要求闭合标记 ** 后跟空白/标点、或前一个字符非标点。
 *       英文 "**word**text" 合法（闭包前 d 非标点）；中文 "**《书名》**字" 中闭包前是
 *       标点 》、后是汉字（非标点非空白），"双不靠" → 无法闭合 → 星号字面显示。
 *
 * 方案：不做任何文本预处理（不插空格/不转义/不改原文，流式每次全量重解析幂等），
 *       只替换 marked 内部两条解析正则，把 CJK 标点从"标点类"中豁免（视为普通字符）：
 *         - emStrongLDelim    ：修复"强调前有文字"的入口判定（如 云：**《》**有云）
 *         - emStrongRDelimAst ：修复星号闭合（如 **《》**字）
 *       v5：字符类同时去掉 \p{S}（符号）——六十四卦 ䷭、八卦 ☰、太极 ☯、花色 ♣、
 *       扑克牌 🃏 等 Unicode So 符号在"加粗内容结尾"时同样闭合失败（**《地风升》䷭**乃进升之象
 *       中闭包 ** 前是符号 ䷭、后是汉字 → 双不靠），现将其与 CJK 标点一样视为内容字符；
 *       嵌套强调触发条件同步去掉 \p{S}。
 *       下划线版 emStrongRDelimUnd 刻意不动（CommonMark _ 词内规则，foo_bar 不强调）。
 *       注意：marked 的 inline rules 有 normal/gfm/breaks/pedantic 四套共享变体，
 *       且 setOptions 后可能切换变体 → 补丁对四套全部覆盖（各自幂等）。
 *
 * 升级 marked 后需重新验证本补丁（行为断言见 tests/marked-cjk.test.js）。
 */
(function () {
  if (typeof marked === 'undefined' || typeof marked.Lexer !== 'function') return;
  try {
    // marked 内部有多套 inline rules 变体（normal/gfm/breaks/pedantic，模块级共享对象），
    // 且 marked.setOptions 每次创建新的 defaults 对象 → 业务代码 setOptions({gfm,breaks})
    // 后 Lexer 会选用 breaks 变体。因此补丁一次性覆盖全部 4 个变体（各自幂等）。
    const variants = [
      new marked.Lexer(),
      new marked.Lexer({ gfm: true, breaks: true }),
      new marked.Lexer({ gfm: false }),
      new marked.Lexer({ pedantic: true }),
    ];

    // CJK 标点码点范围：CJK符号标点、全角形式、中文引号/破折号/省略号/间隔号/书名号等
    const CJK_CLS = '[\u3000-\u303F\uFF00-\uFFEF\u2014\u2018-\u201F\u2026\u00B7\u2013\u2015\u2032\u2033\u3008-\u3011\u3014-\u301B\uFF5B\uFF5D]';
    // 注意：四类字符类只豁免 \p{P}（标点），刻意去掉 \p{S}（符号）。
    // 六十四卦（䷀-䷿ U+4DC0-4DFF）、八卦（☰☷）、太极（☯）、花色（♠♥♦♣）、
    // 扑克牌（🃏）等均为 Unicode So（Symbol）类别 → 视为"内容字符"，
    // 使 `**《地风升》䷭**，` 这类"加粗内容以符号结尾"的闭合判定成功。
    const punctN        = '(?:(?!' + CJK_CLS + ')[\\p{P}])';
    const punctSpaceN   = '(?:(?!' + CJK_CLS + ')[\\s\\p{P}])';
    const notPunctN     = '(?:(?!' + CJK_CLS + ')[^\\s\\p{P}]|' + CJK_CLS + ')';
    const notPunctTildeN = '(?:(?:(?!' + CJK_CLS + ')[^\\s\\p{P}])|~|' + CJK_CLS + ')';

    // 把正则中的三类互补字符类替换为 CJK 豁免版（三类同步替换，保持分类一致性）
    function cjkify(re) {
      const s = re.source
        .replace(/\(\?:\[\^\\s\\p\{P\}\\p\{S\}\]\|~\)/g, notPunctTildeN)
        .replace(/\[\^\\s\\p\{P\}\\p\{S\}\]/g, notPunctN)
        .replace(/\[\\s\\p\{P\}\\p\{S\}\]/g, punctSpaceN)
        .replace(/\[\\p\{P\}\\p\{S\}\]/g, punctN);
      return new RegExp(s, re.flags);
    }

    for (const lex of variants) {
      const inline = lex.tokenizer.rules.inline;
      if (!inline || !inline.emStrongLDelim || !inline.emStrongRDelimAst || inline.__cjkPatched) continue;
      inline.emStrongLDelim = cjkify(inline.emStrongLDelim);
      inline.emStrongRDelimAst = cjkify(inline.emStrongRDelimAst);
      inline.__cjkPatched = true;
    }

    // === 第二部分：嵌套强调规范化 ===
    // marked 的线性扫描算法无法处理「外层单星包裹 + 内部含 **」且内部 ** 前为
    // 空格或 ASCII 标点的嵌套强调（如 *起卦时为**丙申月**，…① **体卦艮土**…*，
    // CommonMark 规范栈算法可以处理）→ 外层 em 配对错乱、星号字面残留。
    // 预处理：命中该模式时删除外层单星，内部 ** 独立配对为 strong，保证无字面星号。
    // 触发条件：单星包裹 + 内容含 ** + 内容含「空格 或 非CJK豁免标点 + **」。
    // 成功段（内部 ** 前全为汉字/豁免标点，marked 可正常嵌套解析）不受影响。
    // 触发条件同步去掉 \p{S}：符号（六十四卦/八卦/花色等）按内容字符处理，不触发删外层单星。
    const triggerRe = new RegExp('(?:\\s|(?:(?!' + CJK_CLS + ')[\\p{P}]))\\*\\*', 'u');
    const emNestRe = /(?<!\*)\*(?!\*)((?:[^*]|\*\*)+?)(?<!\*)\*(?!\*)/gm;
    function normalizeEmphasis(src) {
      if (!src || !src.includes('*')) return src;
      return src.replace(emNestRe, (m, g1) => {
        if (!g1.includes('**')) return m;
        if (!triggerRe.test(g1)) return m;
        return g1; // 删外层单星：*A① **B** C* → A① **B** C
      });
    }
    // === 第三部分：星号包裹链接 → 链接内强调 ===
    // marked 先 tokenize 链接再掩码解析强调：**[text](url)** 掩码后为 **[aaa]**，
    // 若其后紧跟汉字（如 **[...]**即可），] + ** 触发 opening run 误判 → 字面星号。
    // 转换：**[text](url)** → [**text**](url)，*[text](url)* → [*text*](url)（幂等、流式安全）。
    const linkEmRe = /(?<!\*)(\*{1,2})(\[[^\]]*\]\([^)]*\))(\*{1,2})(?!\*)/g;
    function fixLinkEmphasis(src) {
      if (!src || !src.includes('*')) return src;
      return src.replace(linkEmRe, (m, open, link, close) => {
        const bracket = link.indexOf(']');
        const label = link.slice(1, bracket);
        const rest = link.slice(bracket + 1);
        return '[' + open + label + close + ']' + rest;
      });
    }
    // === 第四部分：轻量 LaTeX 翻译（marked 无数学扩展）===
    // $...$ 数学模式 marked 原生不解析，字面显示很"捞"。
    // 轻量翻译：剥离 $ 并把常用 LaTeX 命令替换为 Unicode 符号（箭头/运算符/希腊字母等）。
    // 金额保护：$ 后紧跟数字视为金额，不翻译（如 价格 $5，共 $10）。
    const latexMap = {
      '\\rightarrow': '→', '\\leftarrow': '←', '\\Rightarrow': '⇒', '\\Leftarrow': '⇐',
      '\\leftrightarrow': '↔', '\\Leftrightarrow': '⇔', '\\uparrow': '↑', '\\downarrow': '↓',
      '\\times': '×', '\\div': '÷', '\\cdot': '·', '\\pm': '±', '\\mp': '∓',
      '\\geq': '≥', '\\leq': '≤', '\\neq': '≠', '\\approx': '≈', '\\equiv': '≡',
      '\\infty': '∞', '\\sum': '∑', '\\prod': '∏', '\\sqrt': '√', '\\partial': '∂',
      '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ε',
      '\\theta': 'θ', '\\lambda': 'λ', '\\mu': 'μ', '\\pi': 'π', '\\sigma': 'σ',
      '\\phi': 'φ', '\\omega': 'ω', '\\Delta': 'Δ', '\\Omega': 'Ω',
      '\\circ': '°', '\\degree': '°', '\\%': '%', '\\&': '&', '\\#': '#',
      '\\pmod': 'mod', '\\bmod': 'mod', '\\mod': 'mod',
    };
    // 一次性正则：\\ + (按长度降序的 key 去反斜杠) + 词边界 (?![a-zA-Z])。
    // 词边界保证 \pmod 不会被 \pm 子串误替换（pm 后跟 o 是字母 → 该分支不匹配），
    // \pmatrix/\pmb 等更长的命令也保持原样；\pmod 6 正确译为 mod 6。
    const latexRe = new RegExp(
      '\\\\(?:' +
      Object.keys(latexMap)
        .map((k) => k.slice(1))
        .sort((a, b) => b.length - a.length)
        .join('|') +
      ')(?![a-zA-Z])',
      'g'
    );
    function translateLatex(expr) {
      return expr.replace(latexRe, (m) => latexMap[m]).trim();
    }
    function fixLatex(src) {
      if (!src || !src.includes('$')) return src;
      return src
        .replace(/\$\$([\s\S]+?)\$\$/g, (m, expr) => translateLatex(expr))
        .replace(/\$((?![0-9])[^$\n]+)\$/g, (m, expr) => translateLatex(expr));
    }
    // marked.parse 为 getter-only 属性（v18 UMD），无法包装 → 用官方 hooks.preprocess
    marked.use({ hooks: { preprocess: (src) => fixLatex(fixLinkEmphasis(normalizeEmphasis(src))) } });
  } catch (e) {
    // 静默失败：保持 marked 原行为，不阻塞页面
  }
})();
