/* rag-client.js — CA-Accounting Agent · Phase 6 浏览器端 RAG 镜像
 * 离线可用：从 window.APP_DATA 构建语料，提供 retrieve() / answer()。
 * 逻辑与 rag/rag_engine.py 保持一致（中文 lexical 检索 + 来源优先级 + 待审标注）。
 */
(function (global) {
  "use strict";

  var SOURCE_PRIORITY = { A: 7, B: 6, C: 5, D: 4, E: 3, F: 2, G: 1 };

  var AGENTS = {
    "tutor-agent":   { name: "一对一辅导", composition: "explain_then_practice", prefer: ["kp", "doc", "question"], lead: "针对你的问题「{q}」，先讲清原理，再给一道练习巩固。" },
    "teacher-agent": { name: "课程教师",   composition: "explain",               prefer: ["doc", "kp"],          lead: "关于「{q}」，从权威资料梳理如下。" },
    "analysis-agent":{ name: "财务分析",   composition: "analysis",              prefer: ["doc", "kp", "case"],  lead: "围绕「{q}」的财务分析口径与框架如下。" },
    "analytics-agent":{name: "学习分析",   composition: "analytics",             prefer: ["kp", "doc"],          lead: "基于学习数据，对「{q}」的分析如下。" },
    "case-agent":    { name: "案例教学",   composition: "case",                  prefer: ["case", "doc"],        lead: "为你匹配到与「{q}」相关的案例与解析。" },
    "exam-agent":    { name: "考核组卷",   composition: "exam",                  prefer: ["question", "kp"],     lead: "按「{q}」的组卷需求，从题库抽取如下题目。" },
    "exercise-agent":{ name: "练习生成",   composition: "exercise",              prefer: ["question", "kp"],     lead: "围绕「{q}」生成针对性练习如下。" },
    "practice-agent":{ name: "实操训练",   composition: "practice",              prefer: ["doc", "kp", "case"],  lead: "针对「{q}」的实操步骤与分录模板如下。" }
  };

  function tokenize(text) {
    var s = (text || "").replace(/[^\w\u4e00-\u9fff]+/g, "");
    var toks = {};
    var i, ch;
    for (i = 0; i < s.length; i++) { toks[s[i]] = 1; }
    for (i = 0; i < s.length - 1; i++) { toks[s.substr(i, 2)] = 1; }
    var m = s.match(/[A-Za-z0-9]{2,}/g);
    if (m) { for (i = 0; i < m.length; i++) { toks[m[i].toLowerCase()] = 1; } }
    return toks;
  }

  function intersect(a, b) {
    var out = [], k;
    for (k in a) { if (b[k]) out.push(k); }
    return out;
  }

  var _corpus = null;
  function buildCorpus() {
    if (_corpus) return _corpus;
    var D = global.APP_DATA || {};
    var chunks = [], cid = 0;
    function mk(type, content, source, kpId, moduleId, review, copyright, title, tags, snippet) {
      cid++;
      kpId = (kpId || []).filter(Boolean);
      var full = [title, (tags || []).join(" "), kpId.join(" "), content].join(" ");
      var toks = tokenize(full);
      return {
        chunk_id: "CHK" + ("000" + cid).slice(-4),
        type: type, content: content, source: source || "G",
        kp_id: kpId, module_id: moduleId || "", review_status: review || "pending",
        copyright: copyright || "", title: title || "", tags: tags || [],
        snippet: (snippet || content).slice(0, 200),
        _t: toks, _tt: tokenize(title), _tg: tokenize((tags || []).join(" ")),
        _tk: tokenize(kpId.join(" "))
      };
    }
    (D.knowledge_docs || []).forEach(function (d) {
      chunks.push(mk("doc", d.title + "\n" + d.body, d.source_type, d.kp_id, d.module_id, d.review_status, d.copyright, d.title, d.tags, d.body));
    });
    (D.knowledge_points || []).forEach(function (kp) {
      var parts = [kp.title, kp.rag_text, kp.summary];
      (kp.key_points || []).forEach(function (p) { parts.push("要点：" + p); });
      (kp.common_mistakes || []).forEach(function (p) { parts.push("易错：" + p); });
      chunks.push(mk("kp", parts.filter(Boolean).join("\n"), kp.source, [kp.kp_id], kp.module_id, kp.status, kp.source_detail, kp.title, [], kp.rag_text));
    });
    (D.cases || []).forEach(function (c) {
      var parts = [c.title, c.background, "问题：" + c.accounting_question, "分析：" + c.analysis_question, "参考答案：" + c.reference_answer];
      chunks.push(mk("case", parts.filter(Boolean).join("\n"), c.source, c.knowledge_points, c.module_id, c.review_status, c.copyright, c.title, [c.domain], c.reference_answer));
    });
    (D.questions || []).forEach(function (q) {
      var parts = [q.stem, "解析：" + q.explanation, "答案：" + q.answer];
      chunks.push(mk("question", parts.filter(Boolean).join("\n"), q.source, q.kp_id ? [q.kp_id] : [], q.module_id, q.review_status, q.copyright, q.stem, [q.type], q.explanation));
    });
    _corpus = chunks;
    return chunks;
  }

  function retrieve(query, opts) {
    opts = opts || {};
    var corpus = buildCorpus();
    var filters = opts.filters || {};
    var qToks = tokenize(query);
    var kpInQ = (query.toUpperCase().match(/KP\d-\d{3}/g) || []);
    var prefer = AGENTS[opts.agent] ? AGENTS[opts.agent].prefer : null;
    var topK = opts.top_k || 5;
    var scored = [];
    corpus.forEach(function (c) {
      if (filters.module_id && c.module_id && c.module_id !== filters.module_id) return;
      if (filters.type && c.type !== filters.type) return;
      if (filters.source && c.source !== filters.source) return;
      if (filters.kp_id && c.kp_id.indexOf(filters.kp_id) < 0) return;
      var ov = intersect(qToks, c._t);
      if (!ov.length) return;
      var s = 0;
      ov.forEach(function (t) {
        if (c._tk[t]) s += 3.0;
        else if (c._tt[t]) s += 2.5;
        else if (c._tg[t]) s += 2.0;
        else s += 1.0;
      });
      s /= Math.max(1, Object.keys(qToks).length);
      if (kpInQ.length && c.kp_id.filter(function (k) { return kpInQ.indexOf(k) >= 0; }).length) s += 1.0;
      s += 0.02 * (SOURCE_PRIORITY[c.source] || 1);
      if (prefer && prefer.indexOf(c.type) >= 0) s += 0.15 * (prefer.length - prefer.indexOf(c.type));
      if (c.review_status === "pending" || c.source === "G") s *= 0.85;
      scored.push({ s: s, c: c });
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, topK).map(function (x) {
      var c = x.c;
      return {
        chunk_id: c.chunk_id, type: c.type, content: c.content, source: c.source,
        kp_id: c.kp_id, module_id: c.module_id, review_status: c.review_status,
        copyright: c.copyright, title: c.title, tags: c.tags, snippet: c.snippet,
        score: Math.min(1, x.s).toFixed(3) * 1
      };
    });
  }

  function answer(agent, query, retrieved, studentId) {
    if (!AGENTS[agent]) throw new Error("未知 agent: " + agent);
    var cfg = AGENTS[agent];
    if (!retrieved) retrieved = retrieve(query, { agent: agent });
    var warnings = [], citations = [], related = [];
    retrieved.forEach(function (c) {
      citations.push({ chunk_id: c.chunk_id, source: c.source, kp_id: c.kp_id, module_id: c.module_id, type: c.type, title: c.title, snippet: c.snippet.slice(0, 120) });
      c.kp_id.forEach(function (k) { if (related.indexOf(k) < 0) related.push(k); });
      if (c.review_status === "pending" || c.source === "G") warnings.push("引用了未审核内容（" + c.chunk_id + "，来源" + c.source + "），须教师复核后方可纳入正式教学。");
    });
    var comp = cfg.composition;
    if (comp === "analytics" && studentId) return composeAnalytics(agent, cfg, query, retrieved, citations, warnings, related, studentId);
    if (!retrieved.length) {
      return finalize(agent, query, "未在知识库中检索到与「" + query + "」直接相关的内容。建议：① 缩小关键词；② 指定知识点编号（如 KP3-001）；③ 联系课程组补充资料。",
        citations, warnings, related, ["尝试更具体的关键词", "指定 kp_id 重新检索"]);
    }
    var lead = cfg.lead.replace("{q}", query);
    var lines = retrieved.slice(0, 3).map(function (c) { return "· " + c.snippet; });
    var text = lead + "\n" + lines.join("\n");
    var suggested = [];
    if (comp === "explain_then_practice" || comp === "exercise" || comp === "exam") {
      var qs = retrieved.filter(function (c) { return c.type === "question"; });
      if (qs.length) { text += "\n\n练习：" + qs[0].title; suggested.push("完成上题后查看解析"); }
    }
    if (comp === "case") {
      var cs = retrieved.filter(function (c) { return c.type === "case"; });
      if (cs.length) text += "\n\n案例参考答案：" + cs[0].snippet.slice(0, 120);
    }
    if (comp === "practice") text += "\n\n（实操请结合实验指导与分录模板逐步核对，AI 不直接生成凭证。）";
    if (comp === "analytics") text += "\n\n（学习预警需结合真实行为数据，结论供教师参考，不替代人工判断。）";
    if (related.length) suggested.push("复习关联知识点：" + related.slice(0, 3).join("、"));
    suggested.push("可继续追问或指定其它 agent 复核");
    return finalize(agent, query, text, citations, warnings, related, suggested);
  }

  function composeAnalytics(agent, cfg, query, retrieved, citations, warnings, related, studentId) {
    var D = global.APP_DATA || {};
    var mine = (D.learning_records || []).filter(function (r) { return r.student_id === studentId; });
    var perf = mine.filter(function (r) { return ["弱", "较差", "fail", "low"].indexOf(r.performance) >= 0; });
    var seen = {}, weak = [];
    perf.forEach(function (r) { if (r.kp_id && !seen[r.kp_id]) { seen[r.kp_id] = 1; weak.push(r.kp_id); } });
    var risk = "低";
    if (weak.length >= 5) risk = "高"; else if (weak.length >= 2) risk = "中";
    var lead = cfg.lead.replace("{q}", query);
    var lines = ["学生 " + studentId + " 共命中学习记录 " + mine.length + " 条，预警等级：" + risk + "。"];
    if (weak.length) {
      lines.push("薄弱知识点：" + weak.slice(0, 6).join("、"));
      weak.slice(0, 3).forEach(function (k) {
        var ex = retrieve(k, { agent: agent, top_k: 1 });
        if (ex.length) {
          lines.push("· 针对 " + (ex[0].kp_id.join(",") || ex[0].title) + "：" + ex[0].snippet.slice(0, 100));
          if (ex[0].review_status === "pending") warnings.push("薄弱点参考资料 " + ex[0].chunk_id + " 未审核，需教师复核。");
        }
      });
    } else {
      lines.push("暂未识别到显著薄弱点，建议保持当前节奏。");
    }
    return finalize(agent, query, lead + "\n" + lines.join("\n"), citations, warnings, related, ["为薄弱点推送 tutor-agent 练习", "教师人工确认预警阈值"]);
  }

  function finalize(agent, query, text, citations, warnings, related, suggested) {
    return { agent: agent, agent_name: AGENTS[agent].name, query: query, answer: text,
      citations: citations, warnings: warnings, related_kps: related, suggested_next: suggested };
  }

  global.RAG = { tokenize: tokenize, buildCorpus: buildCorpus, retrieve: retrieve, answer: answer, AGENTS: AGENTS };
})(window);
