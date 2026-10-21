// ==UserScript==
// @name         好医生本地播放助手
// @namespace    local.cme.playback.helper
// @version      0.3.0
// @description  本地课程队列、正常播放、可选逐题反馈试答；无需云端授权。
// @match        https://www.cmechina.net/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self || document.getElementById('cme-local-panel')) return;
  const KEY = 'cme_local_v1';
  const RUN = 'cme_local_run_v1';
  const LOCK = 'cme_local_lock_v1';
  const ENDED = 'cme_local_ended_v1';
  const EXAM = 'cme_local_exam_v1';
  const RESPONSES = 'cme_local_exam_responses_v1';
  const COMPLETED = 'cme_local_completed_courses_v1';
  const read = (store, key, fallback) => {
    try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const write = (store, key, value) => store.setItem(key, JSON.stringify(value));
  let config = read(localStorage, KEY, { queue: [], muted: true });
  if (!Array.isArray(config.queue)) config.queue = [];
  config.autoExam = config.autoExam === true;
  config.examLimit = Math.min(120, Math.max(1, Number(config.examLimit) || 12));
  let examController = null;
  let favoriteController = null;
  // 每份文档使用独立 ID，避免“复制标签页”继承 sessionStorage 后共用锁。
  const tabId = crypto.randomUUID();
  let running = read(sessionStorage, RUN, false) === true;
  let busy = false;
  let video = null;
  let lastPlay = 0;
  let endedAt = 0;
  let status = '已停止';
  let lastLog = '';
  let pending = null;
  let ownerSince = 0;
  const logs = [];
  const path = location.pathname;
  const isPlayer = /\/(study2|polyv)\.jsp$/i.test(path);
  const isExam = /exam|ewmface/i.test(path);
  const params = new URLSearchParams(location.search);
  const courseId = params.get('course_id') || '';
  const chapterId = params.get('courseware_id') || '';
  const norm = id => String(id || '').replace(/^0+/, '') || '0';

  function courseUrl(id) {
    return '/cme/course.jsp?course_id=' + encodeURIComponent(id);
  }
  function safeUrl(raw, playerOnly = false) {
    try {
      if (!raw || !String(raw).trim()) return null;
      if (/[\s'"<>`]/.test(String(raw).trim())) return null;
      const url = new URL(String(raw).trim().replace(/&amp;/g, '&'), document.baseURI || location.origin + '/cme/');
      if (url.origin !== location.origin) return null;
      if (playerOnly && !/\/(study2|polyv)\.jsp$/i.test(url.pathname)) return null;
      return url;
    } catch { return null; }
  }
  function chapterUrl(node) {
    const values = ['href', 'onclick', 'data-url', 'data-href', 'data-src'].map(attr => node.getAttribute(attr));
    for (const raw of values) {
      if (!raw) continue;
      const direct = safeUrl(raw, true);
      if (direct) return direct;
      const match = raw.match(/(?:kjJumpTo\s*\(\s*)?['"]([^'"]*(?:study2|polyv)\.jsp\?[^'"]+)['"]/i);
      if (match) {
        const url = safeUrl(match[1], true);
        if (url) return url;
      }
    }
    return null;
  }
  function chapterState(row) {
    // 只读取章节状态标签，避免把标题中的“完成”等字样认作已通过。
    const marker = row.querySelector('i, .chapter-status, .status');
    const text = marker?.textContent?.replace(/\s+/g, '') || '';
    const classes = marker?.className || '';
    if (/kstg/.test(classes) || /^(考试通过|已通过考试|考试已通过|已通过|已完成)$/.test(text) || row.querySelector('.kstg')) return 'done';
    if (/xxz/.test(classes) || /^(待考试|待考)$/.test(text) || row.querySelector('.xxz')) return 'exam';
    if (/wxx/.test(classes) || /^(未学习|未学)$/.test(text) || row.querySelector('.wxx')) return 'study';
    return 'unknown';
  }
  function chapters() {
    const found = new Map();
    for (const node of document.querySelectorAll('a[href], [onclick], [data-url], [data-href], [data-src]')) {
      if (node.closest('#cme-local-panel')) continue;
      const url = chapterUrl(node);
      if (!url || (url.searchParams.has('course_id') && url.searchParams.get('course_id') !== courseId)) continue;
      const id = url.searchParams.get('courseware_id');
      if (!id) continue;
      const row = node.closest('li, tr, .course_item, .course_list') || node;
      const key = norm(id);
      const item = { id, node, row, url, state: chapterState(row) };
      if (!found.has(key) || found.get(key).state === 'unknown') found.set(key, item);
    }
    return [...found.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }
  function log(message) {
    status = message;
    if (message !== lastLog) {
      lastLog = message;
      logs.unshift(new Date().toLocaleTimeString() + ' ' + message);
      logs.splice(40);
      console.info('[好医生本地助手]', message);
    }
    render();
  }
  function ownsLock() {
    const lock = read(localStorage, LOCK, null);
    return lock?.id === tabId && lock.until > Date.now();
  }
  function renewLock() {
    const now = Date.now();
    const lock = read(localStorage, LOCK, null);
    if (lock && lock.id !== tabId && lock.until > now) {
      ownerSince = 0;
      log('另一个标签页正在运行；本页等待');
      return false;
    }
    if (!ownsLock()) ownerSince = now;
    write(localStorage, LOCK, { id: tabId, until: now + 12000 });
    if (!ownerSince) ownerSince = now;
    return now - ownerSince >= 1500 && ownsLock();
  }
  function stop() {
    running = false;
    examController?.abort();
    favoriteController?.abort();
    write(sessionStorage, RUN, false);
    if (ownsLock()) localStorage.removeItem(LOCK);
    try { video?.pause(); } catch { /* player may have detached */ }
    pending = null;
    log('已停止（已暂停可访问的视频）');
  }
  function navigate(url) {
    if (!running || !ownsLock()) return;
    location.assign(url);
  }
  function visible(node) {
    const css = getComputedStyle(node);
    return css.display !== 'none' && css.visibility !== 'hidden' && node.getClientRects().length > 0;
  }
  function blocker() {
    return [...document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper, [role="dialog"], #qrCode')]
      .some(node => !node.closest('#cme-local-panel') && visible(node));
  }
  function findVideo(doc = document, depth = 0) {
    const candidates = [...doc.querySelectorAll('video')];
    const current = candidates.find(v => !v.ended && v.duration > 0) || candidates[0];
    if (current) return current;
    if (depth >= 3) return null;
    for (const frame of doc.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) {
          const result = findVideo(frame.contentDocument, depth + 1);
          if (result) return result;
        }
      } catch { /* 跨域 iframe 需要后续适配，不越过浏览器边界。 */ }
    }
    return null;
  }
  function ended() {
    if (!running || !ownsLock() || endedAt) return;
    endedAt = Date.now();
    write(sessionStorage, ENDED, { courseId, chapterId, at: endedAt });
    log('视频已结束；等待 10 秒让平台保存进度');
  }
  async function playTick() {
    if (blocker()) return log('发现弹窗；请完成题目或认证后继续');
    const nextVideo = findVideo();
    if (nextVideo !== video) {
      video?.removeEventListener('ended', ended);
      video = nextVideo;
      endedAt = 0;
      video?.addEventListener('ended', ended);
    }
    if (!video) return log('未找到可访问的视频；请手动开始播放，或导出诊断');
    if (video.ended) ended();
    if (endedAt) {
      if (Date.now() - endedAt >= 10000 && courseId) navigate(courseUrl(courseId));
      return;
    }
    video.muted = config.muted;
    if (video.paused && Date.now() - lastPlay > 10000) {
      lastPlay = Date.now();
      try { await video.play(); }
      catch { return log('浏览器未允许播放；请手动点击一次视频播放按钮'); }
    }
    if (video.error) return log('播放器报告错误；请检查网络或刷新页面');
    log('正常播放 ' + Math.floor(video.currentTime) + ' / ' + (Number.isFinite(video.duration) ? Math.floor(video.duration) : '?') + ' 秒');
  }
  function examLink(item) {
    const candidates = [item.row, ...item.row.querySelectorAll('a[href], [onclick], [data-url], [data-href]'),
      ...document.querySelectorAll('a[href*="exam.jsp"], [onclick*="exam.jsp"], [data-url*="exam.jsp"]')];
    for (const node of candidates) {
      for (const raw of ['href', 'onclick', 'data-url', 'data-href'].map(attr => node.getAttribute(attr))) {
        if (!raw) continue;
        const values = [raw, ...[...raw.matchAll(/['"]([^'"]*exam\.jsp\?[^'"]*)['"]/gi)].map(match => match[1])];
        for (const value of values) {
          const url = safeUrl(value);
          if (!url || !/\/exam\.jsp$/i.test(url.pathname)) continue;
          if (url.searchParams.has('course_id') && url.searchParams.get('course_id') !== courseId) continue;
          if (!url.searchParams.has('paper_id') || norm(url.searchParams.get('paper_id')) !== norm(item.id)) continue;
          url.searchParams.set('course_id', courseId);
          if (!url.searchParams.has('type')) url.searchParams.set('type', '7');
          return url;
        }
      }
    }
    return null;
  }
  function standardExamLink(item) {
    // 原脚本 fetchExamPage 同样支持不带 product_id 的 type=7 章节试卷。
    // 只在已识别为“待考试”的数字章节上构造地址；不修改平台的考试资格。
    if (item.state !== 'exam' || !/^\d+$/.test(courseId) || !/^\d+$/.test(String(item.id))) return null;
    const url = new URL('/cme/exam.jsp', location.origin);
    url.searchParams.set('course_id', courseId);
    url.searchParams.set('paper_id', String(item.id));
    url.searchParams.set('type', '7');
    const product = item.url?.searchParams.get('product_id');
    if (product && /^\d+$/.test(product)) url.searchParams.set('product_id', product);
    return url;
  }
  function examChoices(options, multi) {
    if (!multi) return options.map(value => [value]);
    if (options.length > 8) throw new Error('多选题选项超过 8 个，请手动作答');
    const choices = [];
    for (let mask = 1; mask < 2 ** options.length; mask++) {
      choices.push(options.filter((_, index) => mask & (1 << index)));
    }
    return choices;
  }
  function parseExam(doc, baseUrl) {
    const form = [...doc.querySelectorAll('form')].find(node =>
      /examDo\.jsp/i.test(node.getAttribute('action') || '') && node.querySelector('input[name="ques_list"]'));
    if (!form) throw new Error('未找到完整答卷表单；请完成认证或导出诊断');
    const action = new URL(form.getAttribute('action'), baseUrl);
    if (action.origin !== location.origin || !/^\/cme\/examDo\.jsp$/i.test(action.pathname)) throw new Error('答卷提交地址不受支持');
    const ids = form.querySelector('input[name="ques_list"]').value.split(',').map(id => id.trim()).filter(Boolean);
    if (!ids.length || new Set(ids).size !== ids.length) throw new Error('题号缺失或重复，停止提交');
    const inputs = [...doc.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
    const entries = ids.map(id => {
      const matches = inputs.filter(input => input.name === 'ques_' + id && !input.disabled);
      const options = [...new Set(matches.map(input => String(input.value)))];
      if (!options.length) throw new Error('题目选项不完整，停止提交');
      const multi = matches.some(input => input.type === 'checkbox') || /多选/.test(matches[0].closest('li')?.textContent || '');
      return { id, name: matches[0].name, options, multi };
    });
    return { form, action, entries };
  }
  function chooseExamEntries(entries, state) {
    return entries.map(entry => {
      // 选项值集合改变时，不复用旧答案与历史试答记录。
      const fingerprint = JSON.stringify([entry.multi, entry.options]);
      let memo = state.questions[entry.id];
      if (!memo || memo.fingerprint !== fingerprint) memo = state.questions[entry.id] = { fingerprint, tried: [] };
      const value = memo.correct || examChoices(entry.options, entry.multi).find(values => !memo.tried.includes(JSON.stringify(values)));
      if (!value) throw new Error('选项已全部尝试，仍未通过；停止试答');
      return { ...entry, value };
    });
  }
  function examBody(parsed, filled) {
    const body = new URLSearchParams();
    const answerNames = new Set(filled.map(entry => entry.name));
    for (const input of parsed.form.querySelectorAll('input[type="hidden"]')) {
      // ques_list 也是 ques_ 前缀，但它是必须保留的题号清单。
      // 只替换本次实际作答字段，保留其余隐藏元数据与签名。
      if (input.name && !input.disabled && !answerNames.has(input.name)) body.append(input.name, input.value);
    }
    for (const entry of filled) for (const value of entry.value) body.append(entry.name, value);
    const ids = (body.get('ques_list') || '').split(',').map(id => id.trim()).filter(Boolean);
    if (ids.length !== filled.length || new Set(ids).size !== ids.length || !filled.every(entry => ids.includes(entry.id))) {
      throw new Error('交卷前检查失败：题号清单缺失或与答案不一致，未提交');
    }
    return body;
  }
  function applyExamFeedback(doc, url, filled, state) {
    const results = new Map();
    const responseUrl = new URL(url, location.origin);
    const wrong = responseUrl.searchParams.get('error_ques');
    if (wrong) {
      const wrongIds = new Set(wrong.split(',').map(value => value.trim()).filter(Boolean));
      if ([...wrongIds].every(id => filled.some(entry => entry.id === id))) {
        for (const entry of filled) results.set(entry.id, !wrongIds.has(entry.id));
      }
    }
    // 反馈行可能调序：优先使用题号；没有题号时，只有行数完全一致才按顺序对应。
    const rows = [...doc.querySelectorAll('.answer_list')];
    rows.forEach((row, index) => {
      const h3 = row.querySelector('h3');
      if (!h3) return;
      const input = row.querySelector('input[name^="ques_"]');
      const id = input?.name?.slice(5) || row.getAttribute('data-ques-id') || (rows.length === filled.length ? filled[index]?.id : null);
      if (!id || !filled.some(entry => entry.id === id)) return;
      if (h3.classList.contains('dui')) results.set(id, true);
      if (h3.classList.contains('cuo')) results.set(id, false);
    });
    for (const entry of filled) {
      const memo = state.questions[entry.id];
      if (!results.has(entry.id)) continue;
      const serialized = JSON.stringify(entry.value);
      if (!memo.tried.includes(serialized)) memo.tried.push(serialized);
      if (results.get(entry.id)) memo.correct = entry.value;
      else delete memo.correct;
    }
    return results.size;
  }
  function examGuard(text, url) {
    if (/\/login(?:\/|\.)|qc\d+\.haoyisheng/i.test(url) || /登录超时|请先登录|安全验证|验证码/.test(text)) return '请先在网站完成登录或安全验证';
    if (/学习时长不足|不能答卷|请先学习/.test(text)) return '平台尚未允许考试，请继续正常学习';
    if (/考试次数.{0,10}(?:不足|已用完|上限)|(?:超过|达到).{0,10}(?:考试|答题|重考)次数|明天再试|请求过于频繁/.test(text)) return '平台提示次数或频率限制，已停止';
    if (/ewmface|ewm1\.jsp|ewmstate\.jsp|wx_pay_ewm|人脸识别/.test(text) && !/name\s*=\s*["']ques_list/.test(text)) return '请先在网站本人完成人脸认证';
    return '';
  }
  function examPassed(text, url) {
    if (/examQuizFail/i.test(url) || /未通过考试|考试未通过|考试失败|学习时长不足/.test(text)) return false;
    if (/class\s*=\s*(?:["'][^"']*\bcuo\b|cuo\b)/i.test(text)) return false;
    return /已通过考试|已经通过考试|考试已通过|考试通过|examSuccess|exam_pass|show_exam_btns/.test(text);
  }
  function feedbackLink(text, baseUrl) {
    // 只解析静态 URL；不执行服务端返回的脚本，也不猜测动态拼接参数。
    const normalized = text.replace(/\\\//g, '/').replace(/\\(?:x26|u0026)/gi, '&').replace(/&amp;/gi, '&');
    const pattern = /(?:https?:\/\/[^\s'"<>/]+)?(?:\/cme\/)?examQuizFail\.jsp(?:\?[^\s'"<>]*)?/gi;
    for (const match of normalized.matchAll(pattern)) {
      const after = normalized.slice(match.index + match[0].length);
      if (/^['"]\s*\+/.test(after)) continue;
      const target = new URL(match[0], baseUrl);
      if (target.origin !== location.origin || target.pathname !== '/cme/examQuizFail.jsp') continue;
      if ([...target.searchParams.values()].some(value => value === '')) continue;
      return target;
    }
    return null;
  }
  function responseSummary(result, method) {
    const text = result.text;
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const url = new URL(result.url, location.origin);
    const count = selector => doc?.querySelectorAll?.(selector)?.length || 0;
    const markers = ['answer_list', 'ques_list', 'error_ques', 'error_order', 'ansList', 'examQuizFail', 'examSuccess', 'show_exam_btns'];
    const messages = ['考试通过', '已通过考试', '考试已通过', '考试未通过', '考试失败', '学习时长不足', '答题时间', '交卷时间', '提交成功', '请先登录', '登录超时', '人脸识别', '参数错误', '签名', '重复提交', '系统繁忙', '操作频繁'];
    return {
      method, path: url.pathname, status: result.status || 200,
      contentType: result.contentType || '', length: text.length,
      queryKeys: [...new Set(url.searchParams.keys())],
      markers: markers.filter(marker => text.includes(marker)),
      messages: messages.filter(message => text.includes(message)),
      feedbackRows: count('.answer_list'),
      correctMarkers: count('.dui'), wrongMarkers: count('.cuo'),
      forms: count('form'), scripts: count('script'),
      dynamicFeedbackRedirect: /examQuizFail\.jsp[^'"\r\n]*['"]\s*\+/.test(text),
      feedbackTarget: diagnosticUrl(feedbackLink(text, result.url)?.href),
      shortMessage: shortResponseMessage(text),
      // 仅保存结构、预定义提示和参数名称；不保存 HTML、题目、答案或签名。
    };
  }
  function shortResponseMessage(text) {
    if (text.length > 512) return null;
    const redact = value => String(value)
      .replace(/((?:sign|token|authorization|loginName|user_?id|mobile\w*|certificate\w*|session\w*|eId|ansList|ques_list)\s*["']?\s*[:=]\s*["']?)[^\s,"'&<>}]+/gi, '$1[已遮蔽]')
      .replace(/\b[a-f0-9]{24,}\b/gi, '[已遮蔽]')
      .replace(/\b\d{11,18}\b/g, '[已遮蔽]')
      .slice(0, 300);
    try {
      const value = JSON.parse(text.trim());
      if (!value || typeof value !== 'object') return null;
      const selected = {};
      for (const key of ['state', 'status', 'code', 'success', 'message', 'msg', 'detail', 'error', 'reason']) {
        if (['string', 'number', 'boolean'].includes(typeof value[key])) selected[key] = redact(value[key]);
      }
      return Object.keys(selected).length ? selected : null;
    } catch {
      // 只提供短纯文本提示，不输出短脚本、HTML 或疑似票据 URL。
      if (/[<>]|https?:\/\/|location\s*[.=]|document\./i.test(text)) return null;
      return redact(text.trim());
    }
  }
  function rememberExamResponse(result, method) {
    const history = read(sessionStorage, RESPONSES, []);
    history.unshift(responseSummary(result, method));
    write(sessionStorage, RESPONSES, history.slice(0, 5));
  }
  async function examRequest(url, options = {}) {
    const target = new URL(url, location.origin);
    if (target.origin !== location.origin || !/^\/cme\/(exam|examDo|examQuizFail)\.jsp$/i.test(target.pathname)) throw new Error('拒绝未识别的考试请求地址');
    examController = new AbortController();
    const timer = setTimeout(() => examController?.abort(), 25000);
    try {
      const response = await fetch(target.href, { ...options, credentials: 'same-origin', redirect: 'follow', signal: examController.signal });
      if (new URL(response.url).origin !== location.origin) throw new Error('考试请求被重定向到外部验证页面，请手动处理');
      if (!response.ok) throw new Error('考试接口返回 HTTP ' + response.status);
      const result = {
        text: await response.text(), url: response.url, status: response.status,
        contentType: response.headers?.get('content-type') || ''
      };
      rememberExamResponse(result, options.method || 'GET');
      return result;
    } finally { clearTimeout(timer); examController = null; }
  }
  async function examTick() {
    if (!config.autoExam) return log('自动试答未开启；请手动答题或勾选“自动试答”');
    if (!/\/exam\.jsp$/i.test(path)) return log('请打开本节正式答题页，再开始自动试答');
    if (blocker()) return log('请处理网站弹窗或认证后继续');
    const paperId = params.get('paper_id');
    if (!courseId || !paperId) return log('答题页缺少课程或试卷编号，请导出诊断');
    const key = courseId + ':' + norm(paperId);
    const states = read(sessionStorage, EXAM, {});
    const state = states[key] ||= { attempts: 0, questions: {}, halted: false };
    if (state.halted) return;
    if (Date.now() < (state.nextAt || 0)) return;
    const save = () => write(sessionStorage, EXAM, states);
    const complete = message => {
      state.halted = true;
      state.passed = true;
      save();
      log(message);
      navigate(courseUrl(courseId));
    };
    try {
      const current = await examRequest(location.href);
      if (!running || !config.autoExam || !ownsLock()) return;
      const guard = examGuard(current.text, current.url);
      if (guard) throw new Error(guard);
      // 已通过章节的取卷接口返回短提示，不再返回 form；先识别再解析。
      if (!/ques_list/.test(current.text) && examPassed(current.text, current.url)) {
        complete('平台提示本节已通过考试；返回课程页继续');
        return;
      }
      if (state.attempts >= config.examLimit) throw new Error('已达到本节 ' + config.examLimit + ' 次提交上限');
      const doc = new DOMParser().parseFromString(current.text, 'text/html');
      const parsed = parseExam(doc, current.url);
      const filled = chooseExamEntries(parsed.entries, state);
      const body = examBody(parsed, filled);
      // 发请求前持久化计数；超时也占一次，避免网络不确定性造成无限重交。
      state.attempts++;
      save();
      log('本地试答：第 ' + state.attempts + '/' + config.examLimit + ' 次提交，共 ' + filled.length + ' 题');
      let result = await examRequest(parsed.action.href, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
      });
      if (!running || !config.autoExam || !ownsLock()) return;
      const guardAfter = examGuard(result.text, result.url);
      if (guardAfter) throw new Error(guardAfter);
      if (examPassed(result.text, result.url)) {
        complete('平台返回考试通过；返回课程页核对状态');
        return;
      }
      if (!/answer_list/.test(result.text)) {
        const target = feedbackLink(result.text, result.url) ||
          (/\/examQuizFail\.jsp$/i.test(new URL(result.url).pathname) && !new URL(result.url).searchParams.get('error_ques') ? new URL(result.url) : null);
        if (target) {
          result = await examRequest(target.href);
          if (!running || !config.autoExam || !ownsLock()) return;
          const failureGuard = examGuard(result.text, result.url);
          if (failureGuard) throw new Error(failureGuard);
        }
      }
      const failDoc = new DOMParser().parseFromString(result.text, 'text/html');
      const count = applyExamFeedback(failDoc, result.url, filled, state);
      if (!count) throw new Error('没有可识别的逐题正误反馈；请点击“复制诊断”，提交结果结构已保留');
      state.nextAt = Date.now() + 3000;
      save();
      log('已读取 ' + count + ' 题反馈，保留正确选项；3 秒后重试');
    } catch (error) {
      state.halted = true;
      save();
      if (running) log('自动试答暂停：' + (error.name === 'AbortError' ? '请求超时或已取消，请先核对网站记录' : error.message));
    }
  }
  function favoriteCourses(doc, baseUrl) {
    const result = new Map();
    for (const a of doc.querySelectorAll('a[href*="course.jsp"]')) {
      if (a.closest('#cme-local-panel')) continue;
      let url;
      try { url = new URL(a.getAttribute('href').replace(/&amp;/g, '&'), baseUrl); } catch { continue; }
      const id = url.searchParams.get('course_id');
      if (url.origin !== location.origin || url.pathname !== '/cme/course.jsp' || !/^\d+$/.test(id || '')) continue;
      if (!result.has(id)) result.set(id, { id, title: a.textContent.trim() || '课程 ' + id });
    }
    return [...result.values()];
  }
  async function loadFavoriteQueue() {
    log('正在读取收藏课程，准备自动续播');
    const todo = [new URL('/cme/myFavorite.jsp', location.origin).href];
    const visited = new Set();
    const courses = new Map();
    favoriteController = new AbortController();
    const controller = favoriteController;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      // 只访问同源收藏页；分页 URL 必须由页面提供，最多读取 20 页。
      while (todo.length && visited.size < 20) {
        const target = todo.shift();
        if (visited.has(target)) continue;
        visited.add(target);
        const response = await fetch(target, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error('收藏页 HTTP ' + response.status);
        const finalUrl = new URL(response.url);
        if (finalUrl.origin !== location.origin || finalUrl.pathname !== '/cme/myFavorite.jsp') throw new Error('收藏页跳转到登录或验证页面');
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        if (doc.querySelector('input[type="password"]')) throw new Error('请先在好医生重新登录');
        for (const item of favoriteCourses(doc, finalUrl.href)) if (!courses.has(item.id)) courses.set(item.id, item);
        for (const a of doc.querySelectorAll('a[href]')) {
          let url;
          try { url = new URL(a.getAttribute('href'), finalUrl); } catch { continue; }
          if (url.origin !== location.origin || url.pathname !== '/cme/myFavorite.jsp') continue;
          if (![...url.searchParams].some(([key, value]) => /page/i.test(key) && /^\d+$/.test(value))) continue;
          url.hash = '';
          if (!visited.has(url.href) && !todo.includes(url.href)) todo.push(url.href);
        }
      }
      if (todo.length) throw new Error('收藏超过 20 页，暂不自动判断队列末尾');
      if (!courses.size) throw new Error('没有读取到收藏课程，请检查登录或导出诊断');
      if (controller.signal.aborted || !running || !ownsLock()) throw new Error('收藏队列读取已取消');
      config.queue = [...courses.values()];
      const latest = read(localStorage, KEY, config);
      write(localStorage, KEY, { ...latest, queue: config.queue });
      renderQueue();
      return config.queue;
    } finally { clearTimeout(timer); favoriteController = null; }
  }
  function nextQueuedCourse(queue, id, completed) {
    const at = queue.findIndex(item => item.id === id);
    if (at < 0) return null;
    return queue.slice(at + 1).find(item => !completed.includes(item.id)) || null;
  }
  async function advanceCourse() {
    const completed = read(sessionStorage, COMPLETED, []);
    if (!completed.includes(courseId)) completed.push(courseId);
    write(sessionStorage, COMPLETED, completed);
    let next = nextQueuedCourse(config.queue, courseId, completed);
    if (!next) {
      try {
        await loadFavoriteQueue();
      } catch (error) {
        cooldown = Date.now() + 60000;
        if (running) log('本课程已完成；读取后续收藏失败：' + error.message + '。60 秒后重试');
        return;
      }
      next = nextQueuedCourse(config.queue, courseId, completed);
      if (!config.queue.some(item => item.id === courseId)) {
        cooldown = Date.now() + 60000;
        return log('本课程已完成，但不在收藏列表中；请先收藏本课程以确定下一门顺序');
      }
    }
    if (!running || !ownsLock()) return;
    if (next) {
      log('本课程全部完成，自动进入下一门：' + (next.title || next.id));
      navigate(courseUrl(next.id));
    } else {
      stop();
      log('从当前课程到收藏队列末尾均已完成，已自动停止');
    }
  }
  async function startFavoriteQueue() {
    try {
      await loadFavoriteQueue();
      const completed = read(sessionStorage, COMPLETED, []);
      const next = config.queue.find(item => !completed.includes(item.id));
      if (next) {
        log('自动进入收藏课程：' + next.title);
        navigate(courseUrl(next.id));
      } else {
        stop();
        log('本次收藏队列均已完成');
      }
    } catch (error) {
      cooldown = Date.now() + 60000;
      if (running) log('读取收藏失败：' + error.message + '。60 秒后重试');
    }
  }
  async function courseTick() {
    const examStates = read(sessionStorage, EXAM, {});
    // passed 只在官方考试响应明确通过时写入，可用于目录状态滞后时继续。
    const items = chapters().map(item => examStates[courseId + ':' + norm(item.id)]?.passed ? { ...item, state: 'done' } : item);
    if (!items.length) return log('尚未识别到章节；请打开第一节视频，或导出诊断');
    const first = items.find(item => item.state !== 'done');
    if (!first) {
      return advanceCourse();
    }
    if (first.state === 'exam') {
      pending = first;
      if (config.autoExam && !blocker()) {
        const previous = read(sessionStorage, EXAM, {})[courseId + ':' + norm(first.id)];
        if (previous?.passed) return log('本节已通过，课程目录尚未同步；请稍后点击“重新检查”');
        const visibleLink = examLink(first);
        const target = visibleLink || standardExamLink(first);
        if (target) {
          log(visibleLink ? '进入第 ' + first.id + ' 节考试' : '未找到直接链接，尝试第 ' + first.id + ' 节标准考试入口');
          return navigate(target.href);
        }
        return log('本节待考试，但未识别到考试入口；请手动点击本节答题按钮');
      }
      return log('第 ' + first.id + ' 节待答题；请在网站完成后点击“重新检查”');
    }
    if (first.state === 'unknown') return log('章节状态无法确认；请手动打开章节并导出诊断');
    const finished = read(sessionStorage, ENDED, null);
    if (finished?.courseId === courseId && norm(finished.chapterId) === norm(first.id)) {
      pending = first;
      return log('本节视频已结束，平台仍显示未学习；请等待同步并重新检查');
    }
    if (blocker()) return log('请处理网站弹窗后继续');
    log('打开第 ' + first.id + ' 节');
    // 使用页面自己的点击逻辑，保留平台解锁和认证检查。
    first.node.click();
    pending = first;
    cooldown = Date.now() + 30000;
  }
  let cooldown = 0;
  async function tick() {
    if (!running || !renewLock() || busy) return;
    busy = true;
    try {
      if (isExam) await examTick();
      else if (isPlayer) await playTick();
      else if (/\/course\.jsp$/i.test(path)) {
        if (Date.now() >= cooldown) await courseTick();
      } else if (/\/myFavorite\.jsp$/i.test(path)) {
        if (Date.now() >= cooldown) await startFavoriteQueue();
      } else log('已就绪；从队列点击课程，或手动打开视频');
    } catch (error) { log('运行异常：' + error.message); }
    finally { busy = false; }
  }

  const panel = document.createElement('section');
  panel.id = 'cme-local-panel';
  panel.innerHTML = `<style>
    #cme-local-panel{position:fixed;right:16px;top:80px;width:310px;max-height:80vh;overflow:auto;z-index:2147483647;background:#fff;color:#17243b;box-shadow:0 8px 35px #0003;border:1px solid #cad5e7;border-radius:12px;padding:14px;font:13px/1.6 system-ui;text-align:left}
    #cme-local-panel button{cursor:pointer;border:1px solid #c5d3e6;border-radius:6px;background:#eef4ff;color:#173b78;padding:5px 9px;margin:3px 3px 3px 0;font:inherit}
    #cme-local-panel h3{font-size:16px;margin:0 0 8px}#cme-local-panel p{margin:7px 0}#cme-local-panel ul{padding-left:18px;margin:6px 0;max-height:155px;overflow:auto}#cme-local-panel pre{white-space:pre-wrap;font:11px/1.5 monospace;max-height:130px;overflow:auto}#cme-local-status{background:#eef4ff;padding:8px;border-radius:6px}
  </style><h3>好医生本地播放助手 v0.3.0</h3>
  <div id="cme-local-status"></div>
  <p>正常播放 · 本地队列 · 可选反馈试答</p>
  <button data-action="start">开始 / 继续</button><button data-action="stop">停止</button>
  <button data-action="check">重新检查</button><button data-action="back">返回课程</button>
  <p><label><input type="checkbox" id="cme-local-mute"> 静音播放</label></p>
  <p><label><input type="checkbox" id="cme-local-exam"> 自动试答（会实际交卷）</label><br>
  <label>每节最多提交 <input id="cme-local-limit" type="number" min="1" max="120" style="width:55px"> 次</label><br>
  <small>依据错题反馈逐项尝试，无 AI；人脸认证需本人完成。</small></p>
  <button data-action="collect">读取本页收藏</button><button data-action="clear">清空队列</button>
  <ul id="cme-local-queue"></ul>
  <button data-action="diagnose">复制诊断</button>
  <details><summary>运行日志</summary><pre id="cme-local-log"></pre></details>`;
  document.body.appendChild(panel);
  const mute = panel.querySelector('#cme-local-mute');
  mute.checked = config.muted;
  mute.addEventListener('change', () => {
    config.muted = mute.checked;
    write(localStorage, KEY, config);
    if (video) video.muted = config.muted;
  });
  const autoExam = panel.querySelector('#cme-local-exam');
  const examLimit = panel.querySelector('#cme-local-limit');
  autoExam.checked = config.autoExam;
  examLimit.value = config.examLimit;
  autoExam.addEventListener('change', () => {
    config.autoExam = autoExam.checked;
    write(localStorage, KEY, config);
    if (!config.autoExam) examController?.abort();
    log(config.autoExam ? '自动试答已开启；点击开始后运行' : '自动试答已关闭');
  });
  examLimit.addEventListener('change', () => {
    config.examLimit = Math.min(120, Math.max(1, Math.floor(Number(examLimit.value) || 12)));
    examLimit.value = config.examLimit;
    write(localStorage, KEY, config);
  });
  function render() {
    panel.querySelector('#cme-local-status').textContent = (running ? '运行中：' : '') + status;
    panel.querySelector('#cme-local-log').textContent = logs.join('\n');
  }
  function renderQueue() {
    const list = panel.querySelector('#cme-local-queue');
    list.replaceChildren();
    for (const item of config.queue) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.textContent = item.title;
      a.href = courseUrl(item.id);
      li.appendChild(a);
      list.appendChild(li);
    }
  }
  function collect() {
    const result = favoriteCourses(document, document.baseURI || location.origin + '/cme/myFavorite.jsp');
    if (!result.length) return log('本页没有课程链接；请在“我的收藏”页面读取');
    config.queue = result;
    write(localStorage, KEY, config);
    renderQueue();
    log('已读取 ' + config.queue.length + ' 门课程；点击开始可自动进入队列');
  }
  function diagnosticUrl(raw) {
    try {
      if (!raw || /[\s'"<>`]/.test(String(raw).trim())) return null;
      const url = new URL(String(raw).replace(/&amp;/g, '&'), document.baseURI || location.origin + '/cme/');
      if (!/^https?:$/.test(url.protocol)) return null;
      // 仅保留路径和数字课程编号；剔除签名、认证票据和其他查询参数。
      const clean = new URL(url.origin + url.pathname);
      for (const key of ['course_id', 'courseware_id', 'ware_id', 'paper_id', 'product_id']) {
        const value = url.searchParams.get(key);
        if (value && /^\d+$/.test(value)) clean.searchParams.set(key, value);
      }
      return clean.href;
    } catch { return null; }
  }
  function linkSamples() {
    const result = [];
    for (const node of document.querySelectorAll('a[href], [onclick], [data-url], [data-href], [data-src]')) {
      if (node.closest('#cme-local-panel')) continue;
      const attrs = ['href', 'onclick', 'data-url', 'data-href', 'data-src'];
      const values = attrs.map(attr => node.getAttribute(attr) || '');
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/study|polyv|courseware|kjJumpTo|exam|paper_id|播放|看视频|未学习|待考试|答题|考试|第\s*\d+\s*节/i.test(values.join(' ') + ' ' + text)) continue;
      const urls = [];
      for (const raw of values) {
        if (!raw) continue;
        const direct = diagnosticUrl(raw);
        if (direct && /\.jsp(?:\?|$)/i.test(direct)) urls.push(direct);
        for (const match of raw.matchAll(/['"]([^'"]*\.jsp\?[^'"]*)['"]/gi)) {
          const url = diagnosticUrl(match[1]);
          if (url) urls.push(url);
        }
      }
      result.push({
        tag: node.tagName,
        classes: typeof node.className === 'string' ? node.className.slice(0, 100) : '',
        functions: [...values.join(' ').matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]).slice(0, 8),
        urls: [...new Set(urls)],
        state: chapterState(node.closest('li, tr, .course_item, .course_list') || node)
      });
      if (result.length >= 35) break;
    }
    return result;
  }
  async function diagnose() {
    const data = {
      version: '0.3.0', path: location.pathname,
      courseId, chapterId, running, status,
      autoExam: config.autoExam,
      examLimit: config.examLimit,
      courseQueue: {
        ids: config.queue.map(item => item.id),
        currentIndex: config.queue.findIndex(item => item.id === courseId),
        completed: read(sessionStorage, COMPLETED, [])
      },
      examResponses: read(sessionStorage, RESPONSES, []),
      examStructure: {
        forms: document.querySelectorAll('form[action*="examDo"]').length,
        questionLists: document.querySelectorAll('input[name="ques_list"]').length,
        options: document.querySelectorAll('input[type="radio"][name^="ques_"], input[type="checkbox"][name^="ques_"]').length
      },
      videos: document.querySelectorAll('video').length,
      frames: [...document.querySelectorAll('iframe')].map(frame => {
        let accessible = false;
        try { accessible = !!frame.contentDocument; } catch { /* inaccessible */ }
        return { origin: safeUrl(frame.getAttribute('src'))?.origin || 'cross-origin/unknown', accessible };
      }),
      chapters: chapters().map(item => ({ id: item.id, state: item.state, tag: item.node.tagName })),
      linkSamples: linkSamples(),
      structure: {
        readyState: document.readyState,
        links: document.querySelectorAll('a[href]').length,
        handlers: document.querySelectorAll('[onclick]').length,
        courseRows: document.querySelectorAll('li.course_list, #s_r_ml li, .course_box li').length,
        loginForm: !!document.querySelector('input[type="password"]')
      },
      logs: logs.slice(0, 10)
    };
    const text = JSON.stringify(data, null, 2);
    try { await navigator.clipboard.writeText(text); log('诊断已复制，可粘贴到聊天中'); }
    catch { window.prompt('请复制诊断内容（不包含 Cookie、授权码或整页 HTML）', text); }
  }
  panel.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'stop') stop();
    if (action === 'collect') collect();
    if (action === 'clear') {
      config.queue = [];
      sessionStorage.removeItem(COMPLETED);
      write(localStorage, KEY, config);
      renderQueue();
    }
    if (action === 'diagnose') void diagnose();
    if (action === 'start') {
      const states = read(sessionStorage, EXAM, {});
      const key = courseId + ':' + norm(params.get('paper_id'));
      if (states[key]) {
        states[key].halted = false;
        write(sessionStorage, EXAM, states);
      }
      running = true;
      write(sessionStorage, RUN, true);
      log('已启动；等待取得本标签页运行权');
      void tick();
    }
    if (action === 'check') {
      cooldown = 0;
      if (courseId && !isPlayer && !isExam) location.reload();
      else void tick();
    }
    if (action === 'back' && courseId) location.assign(courseUrl(courseId));
  });
  window.addEventListener('pagehide', () => { if (ownsLock()) localStorage.removeItem(LOCK); });
  renderQueue();
  log(running ? '恢复本标签页任务' : '请停用旧脚本，点击“读取本页收藏”或直接打开视频');
  setInterval(() => void tick(), 2000);
})();
