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
    const punctN        = '(?:(?!' + CJK_CLS + ')[\\p{P}\\p{S}])';
    const punctSpaceN   = '(?:(?!' + CJK_CLS + ')[\\s\\p{P}\\p{S}])';
    const notPunctN     = '(?:(?!' + CJK_CLS + ')[^\\s\\p{P}\\p{S}]|' + CJK_CLS + ')';
    const notPunctTildeN = '(?:(?:(?!' + CJK_CLS + ')[^\\s\\p{P}\\p{S}])|~|' + CJK_CLS + ')';

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
  } catch (e) {
    // 静默失败：保持 marked 原行为，不阻塞页面
  }
})();
