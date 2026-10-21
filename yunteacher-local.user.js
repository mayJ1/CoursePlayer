// ==UserScript==
// @name         云教师本地连续播放助手
// @namespace    local.yunteacher.playback.helper
// @version      1.2.0
// @description  云教师连续播放、后台播放、自动下一节及按播放推进量计时；纯本地、无授权服务。
// @match        https://saas.yunteacher.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '1.2.0';
  const PANEL = 'yt-local-panel';
  const CFG = 'yt_local_config_v1';
  const LOCK = 'yt_local_lock_v1';
  const LAST_PROGRESS = 'yt_local_last_progress_sent_v1';
  if (window.top !== window.self || document.getElementById(PANEL)) return;
  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 设置不可写时仍允许本页运行。 */ }
  };
  const config = { enabled: true, muted: true, skipCompleted: true, progressClock: true, backgroundPlayback: true, ...read(CFG, {}) };
  let timing = null;
  let visibilityPatch = null;
  const progressReceipts = [];
  let progressBlock = null;
  // 实测短间隔进度会被服务端以“多页面/多设备”拒绝；保守串行排队。
  const PROGRESS_INTERVAL = 15000;
  const progressQueue = [];
  let progressTransportBusy = false;
  let lastProgressSentAt = Math.min(Date.now(), Number(read(LAST_PROGRESS, 0)) || 0);
  let progressQueueTimer = null;
  const owner = crypto.randomUUID();
  let leaseSince = 0;
  let scope = '';
  let task = '';
  let bound = null;
  let onEnded = null;
  let ending = null;
  let switched = null;
  let readyAt = Date.now();
  let lastPlayAt = 0;
  let playPending = false;
  let done = false;
  let initialSelectionDone = false;
  let status = '';
  const logs = [];
  const panel = document.createElement('section');
  panel.id = PANEL;
  panel.innerHTML = `<style>
    #${PANEL}{position:fixed;right:16px;top:90px;width:292px;max-height:75vh;overflow:auto;z-index:2147483647;box-sizing:border-box;border:1px solid #cad5e7;border-radius:12px;padding:14px;background:#fff;color:#17243b;box-shadow:0 6px 28px #0003;font:13px/1.6 system-ui;text-align:left}
    #${PANEL} h3{margin:0 0 8px;font-size:16px}#${PANEL} button{border:1px solid #bfd0e5;border-radius:6px;padding:5px 9px;margin:6px 5px 6px 0;background:#eef4ff;color:#173b78;cursor:pointer;font:inherit}#${PANEL} p{margin:5px 0}#${PANEL} .yt-status{padding:8px;background:#eef4ff;border-radius:6px;overflow-wrap:anywhere}#${PANEL} pre{font:11px/1.5 monospace;white-space:pre-wrap;max-height:140px;overflow:auto}#${PANEL} [data-body][hidden]{display:none}
  </style><h3>云教师本地播放助手 <small>v${VERSION}</small></h3>
  <div class="yt-status" role="status"></div>
  <button data-action="toggle-panel">收起 / 展开</button>
  <div data-body><p>自动播放 → 自然结束 → 下一节</p>
  <button data-action="start">开始 / 继续</button><button data-action="stop">停止</button>
  <p><label><input type="checkbox" data-muted> 静音播放</label></p>
  <p><label><input type="checkbox" data-skip> 跳过已学完的视频</label></p>
  <p><label><input type="checkbox" data-clock> 按视频播放推进量计时</label></p>
  <p><label><input type="checkbox" data-background> 后台播放（关闭隐藏暂停）</label></p>
  <p data-current></p><button data-action="diagnose">复制诊断</button>
  <details><summary>运行日志</summary><pre></pre></details></div>`;
  document.body.appendChild(panel);

  function setStatus(message) {
    if (message === status) return;
    status = message;
    logs.unshift(new Date().toLocaleTimeString() + ' ' + message);
    logs.splice(30);
    panel.querySelector('[role="status"]').textContent = message;
    panel.querySelector('pre').textContent = logs.join('\n');
  }
  function visible(node) {
    if (!node?.isConnected) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  }
  function release(force = false) {
    if (!force && !progressBlock && (progressQueue.length || progressTransportBusy)) return;
    if (read(LOCK, null)?.id === owner) localStorage.removeItem(LOCK);
    leaseSince = 0;
  }
  function canDrive() {
    const now = Date.now();
    const previous = read(LOCK, null);
    if (previous && previous.id !== owner && previous.until > now) {
      leaseSince = 0;
      setStatus('另一个标签页正在播放；本页等待');
      return false;
    }
    if (!previous || previous.id !== owner || previous.until <= now) leaseSince = now;
    write(LOCK, { id: owner, until: now + 12000 });
    return read(LOCK, null)?.id === owner && now - leaseSince >= 500;
  }
  function courseVm() {
    const queue = [document.querySelector('.coursePlay')?.__vue__, document.querySelector('#app')?.__vue__];
    const seen = new Set();
    while (queue.length && seen.size < 250) {
      const vm = queue.shift();
      if (!vm || seen.has(vm)) continue;
      seen.add(vm);
      if (vm.currentCourse && typeof vm.goNextTrivia === 'function' && Array.isArray(vm.triviaList)) return vm;
      for (const child of vm.$children || []) queue.push(child);
    }
    return null;
  }
  function mediaIn(doc = document, depth = 0) {
    const media = [...doc.querySelectorAll('#video_play video, .CCH5playerContainer video, video, audio')];
    const usable = media.find(node => visible(node) && (node.currentSrc || node.srcObject)) || media.find(node => node.currentSrc || node.srcObject);
    if (usable) return usable;
    if (depth < 3) for (const frame of doc.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) {
          const result = mediaIn(frame.contentDocument, depth + 1);
          if (result) return result;
        }
      } catch { /* 交给宿主页的完成状态与 SDK 处理跨域播放器。 */ }
    }
    return null;
  }
  function rows() {
    return [...document.querySelectorAll('.courseVignette_box')].map((node, index) => ({
      node, index, title: node.querySelector('.vignette_title')?.textContent.trim() || '第 ' + (index + 1) + ' 节',
      active: node.classList.contains('active'),
      locked: !!node.querySelector('.icon-weijiesuo'),
      video: !!node.querySelector('.icon-shipin') || node.querySelector('.vignetteType')?.textContent.trim() === '视频',
      complete: /已学完/.test(node.querySelector('.learningStatus')?.textContent || '')
    }));
  }
  function taskKey(vm) {
    if (vm?.currentCourse?.taskId != null) return String(vm.currentCourse.taskId);
    const active = rows().find(row => row.active);
    return active ? 'row:' + active.index + ':' + active.title : '';
  }
  function selectTask(vm, target) {
    if (!target || Number(target.isLock) === 1) return false;
    const index = vm.triviaList.findIndex(item => String(item.taskId) === String(target.taskId));
    const row = rows()[index];
    if (row && !row.locked) row.node.click();
    else if (typeof vm.getVignetteDetail === 'function') vm.getVignetteDetail(target);
    else return false;
    return true;
  }
  function restoreVisibility() {
    if (!visibilityPatch) return;
    if (!visibilityPatch.vm._isDestroyed && !visibilityPatch.vm._isBeingDestroyed) {
      window.addEventListener('visibilitychange', visibilityPatch.handler);
    }
    visibilityPatch = null;
  }
  function installVisibility(vm) {
    if (!config.backgroundPlayback || typeof vm?.handleVisibilityChange !== 'function') return;
    if (visibilityPatch?.vm === vm) return;
    restoreVisibility();
    const handler = vm.handleVisibilityChange;
    // 平台 created() 在 window 上注册此精确回调；不拦截其他监听器，不伪造可见性。
    window.removeEventListener('visibilitychange', handler);
    visibilityPatch = { vm, handler };
  }
  // 观察并串行排队平台已有 XHR，不新建请求，不读取/记录 Cookie 或授权头。
  const xhrUrls = new WeakMap();
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  function pumpProgressQueue() {
    clearTimeout(progressQueueTimer);
    if (progressBlock || progressTransportBusy || !progressQueue.length) return;
    if (!canDrive()) {
      progressQueueTimer = setTimeout(pumpProgressQueue, 700);
      return;
    }
    lastProgressSentAt = Math.max(lastProgressSentAt, Math.min(Date.now(), Number(read(LAST_PROGRESS, 0)) || 0));
    const wait = Math.max(0, lastProgressSentAt + PROGRESS_INTERVAL - Date.now());
    if (wait) {
      progressQueueTimer = setTimeout(pumpProgressQueue, wait);
      return;
    }
    const job = progressQueue.shift();
    progressTransportBusy = true;
    lastProgressSentAt = Date.now();
    write(LAST_PROGRESS, lastProgressSentAt);
    job.report.state = '等待接口确认';
    job.report.wasSent = true;
    try { originalXhrSend.call(job.xhr, job.body); }
    catch (error) { job.finish(null, String(error.message || error)); }
  }
  function observedOpen(method, url) {
    xhrUrls.set(this, String(url));
    return originalXhrOpen.apply(this, arguments);
  }
  function observedSend(body) {
    let url;
    try { url = new URL(xhrUrls.get(this), location.href); } catch {}
    if (timing && url?.origin === location.origin && url.pathname === '/api/course/v2/app/homepage/study') {
      let data;
      try { data = JSON.parse(body); } catch {
        if (typeof body === 'string') data = Object.fromEntries(new URLSearchParams(body));
      }
      const state = timing;
      const report = data && state.reports.find(item => item.state === '待发送' && item.taskId === String(data.taskId) && item.learnTime === Number(data.learnTime));
      if (report) {
        report.state = '排队等待发送';
        report.playTime = Number(data.playTime);
        let settled = false;
        const finish = (response, errorMessage) => {
          if (settled) return;
          settled = true;
          if (report.wasSent) progressTransportBusy = false;
          const queuedIndex = progressQueue.findIndex(job => job.report === report);
          if (queuedIndex >= 0) progressQueue.splice(queuedIndex, 1);
          report.httpStatus = this.status;
          report.code = response?.code ?? null;
          report.message = String(errorMessage || response?.msg || (this.status ? '响应无法识别' : '网络中断，是否入账未知')).slice(0, 160);
          if (this.status >= 200 && this.status < 300 && Number(response?.code) === 200) {
            report.state = '接口已接受，累计值以平台目录为准';
          } else {
            report.state = this.status ? '接口拒绝或响应异常' : '结果未知，禁止自动重发';
            if (String(state.vm.currentCourse?.taskId) === report.taskId) {
              state.pending += report.consumed;
              state.vm.viewingTime = state.pending;
            }
            progressBlock = { taskId: report.taskId, message: report.message };
            clearInterval(state.vm.timer);
            try { state.media?.pause(); } catch {}
            setStatus('学习进度未确认，已暂停自动操作：' + report.message + '；请复制诊断');
          }
          progressReceipts.unshift({ taskId: report.taskId, learnTime: report.learnTime, playTime: report.playTime, httpStatus: report.httpStatus, code: report.code, message: report.message, state: report.state });
          progressReceipts.splice(12);
          state.reports = state.reports.filter(item => item !== report);
          pumpProgressQueue();
          if (!config.enabled && !progressQueue.length && !progressTransportBusy) release(true);
        };
        this.addEventListener('loadend', () => {
          let response;
          try { response = this.responseType === 'json' ? this.response : JSON.parse(this.responseText); } catch {}
          finish(response);
        }, { once: true });
        progressQueue.push({ xhr: this, body, report, finish });
        pumpProgressQueue();
        return;
      }
    }
    return originalXhrSend.apply(this, arguments);
  }
  XMLHttpRequest.prototype.open = observedOpen;
  XMLHttpRequest.prototype.send = observedSend;
  function restoreTiming() {
    if (!timing) return;
    const state = timing;
    timing = null;
    clearInterval(state.vm.timer);
    state.unbind();
    state.vm.setTimer = state.originalTimer;
    if (state.originalVideoTimer) state.vm.setVideoTime = state.originalVideoTimer;
    state.vm.updateStudyTime = state.originalUpdate;
    // 不丢弃已累计但尚未由平台上报的增量。
    state.vm.viewingTime = state.pending;
    const media = mediaIn();
    if (!state.vm._isDestroyed && !state.vm._isBeingDestroyed && media && !media.paused && !media.ended) state.originalTimer.call(state.vm);
  }
  function installTiming(vm) {
    if (!config.progressClock || !vm || typeof vm.setTimer !== 'function' || typeof vm.updateStudyTime !== 'function') return;
    if (timing?.vm === vm) return;
    restoreTiming();
    const state = {
      vm, originalTimer: vm.setTimer, originalVideoTimer: vm.setVideoTime,
      originalUpdate: vm.updateStudyTime, pending: Math.max(0, Number(vm.viewingTime) || 0),
      id: String(vm.currentCourse?.taskId || ''), position: null, sampledAt: performance.now(), media: null,
      lastReport: null, skippedEmptyReports: 0, reports: [], discardedSdkSeconds: 0, peakObservedRate: 0,
      unbind() {
        state.media?.removeEventListener('seeking', state.reset);
        state.media?.removeEventListener('seeked', state.reset);
        state.media = null;
      },
      probe() {
        const media = mediaIn();
        if (media !== state.media) {
          state.unbind(); state.media = media; state.position = null;
          media?.addEventListener('seeking', state.reset);
          media?.addEventListener('seeked', state.reset);
        }
        let position = media?.currentTime;
        if (!Number.isFinite(position)) {
          try { position = vm.player?.getCurrentTime?.() ?? vm.player?.getPosition?.(); } catch { position = null; }
        }
        return { media, position: Number.isFinite(position) ? position : null };
      },
      reset() {
        const media = state.media;
        state.position = media && Number.isFinite(media.currentTime) ? media.currentTime : null;
        state.sampledAt = performance.now();
      },
      sample() {
        const id = String(vm.currentCourse?.taskId || '');
        if (id !== state.id) {
          state.id = id; state.pending = 0; state.position = null; vm.viewingTime = 0;
        }
        const now = performance.now();
        const { media, position } = state.probe();
        const previous = state.position;
        const elapsed = Math.max(0, (now - state.sampledAt) / 1000);
        state.position = position; state.sampledAt = now;
        if (position == null || previous == null || media?.seeking || (!media && vm.isPositioned) || Number(vm.currentCourse?.mediumType) !== 2) return;
        const delta = position - previous;
        if (delta <= 0) return;
        // DOM 媒体拖动靠原生 seeking/seeked 排除，不能靠 playbackRate 推断。
        // 一些倍速工具对网页返回 1 倍速，却实际高速播放；旧的 2 秒阈值会漏记。
        if (!media && delta > Math.max(2, elapsed * 32 + .5)) {
          state.discardedSdkSeconds += delta;
          return;
        }
        if (elapsed > .02) state.peakObservedRate = Math.max(state.peakObservedRate, delta / elapsed);
        state.pending += delta;
        vm.viewingTime = state.pending;
        if (Number.isFinite(Number(vm.countTime))) vm.countTime = Math.max(0, Number(vm.countTime) - delta);
      }
    };
    timing = state;
    state.sample();
    vm.updateStudyTime = function (_amount, event) {
      if (Number(vm.currentCourse?.mediumType) !== 2) return state.originalUpdate.apply(this, arguments);
      state.sample();
      if (progressBlock) {
        setStatus('学习进度未确认，暂停后续上报：' + progressBlock.message + '；请先核对平台记录');
        return;
      }
      const final = event === 'upData';
      // 服务端实际按整秒入账；周期上报保留小数余量，不能每笔都丢掉。
      const rounded = Math.max(0, Math.floor(state.pending + 1e-8));
      if (state.pending < 1e-6) {
        state.skippedEmptyReports++;
        return;
      }
      // 实际接口拒绝不足 1 秒的尾段；保留原生结束补偿的最小 1 秒语义。
      // 非结束阶段的小片段先累计，不能发送 0 或 0.x，也不能重复补偿。
      if (!final && rounded < 1) return;
      const amount = final ? Math.max(1, Math.ceil(state.pending - 1e-8)) : rounded;
      // 加载/换课期间不得提交缺少课程或小节 ID 的请求，累计量仍保留。
      if (!vm.courseId || !vm.currentCourse?.taskId) {
        setStatus('进度尚未上报：等待完整课程和小节参数');
        return;
      }
      const consumed = final ? state.pending : amount;
      state.pending = Math.max(0, state.pending - consumed);
      vm.viewingTime = state.pending;
      const report = { taskId: String(vm.currentCourse.taskId), learnTime: amount, consumed, event: event || null, state: '待发送' };
      state.reports.push(report);
      // 原接口 learnTime 为增量；只上报本段推进量，不反复发送绝对播放位置。
      try {
        const result = state.originalUpdate.call(this, amount, event);
        state.lastReport = report;
        return result;
      } catch (error) {
        state.pending += consumed;
        vm.viewingTime = state.pending;
        state.reports = state.reports.filter(item => item !== report);
        throw error;
      }
    };
    vm.setTimer = function () {
      if (Number(vm.currentCourse?.mediumType) !== 2) return state.originalTimer.apply(this, arguments);
      clearInterval(vm.timer);
      state.sample();
      vm.timer = setInterval(() => {
        state.sample();
        const remaining = Math.max(0, Number(vm.countTime) || 0);
        const format = value => String(Math.floor(value)).padStart(2, '0');
        vm.toLiveBtn = [remaining / 3600, remaining / 60 % 60, remaining % 60].map(format).join(':');
        // countTime 是课程要求时长，不是视频结束信号。不要在其归零时
        // 提前 upData/刷新目录；最后一段留给平台原生 ended 回调上报。
        if (state.pending >= 60) vm.updateStudyTime(state.pending);
      }, 200);
    };
    if (typeof vm.setVideoTime === 'function') vm.setVideoTime = vm.setTimer;
    const media = state.media;
    if (media && !media.paused && !media.ended) vm.setTimer();
  }
  function detachMedia() {
    if (bound && onEnded) bound.removeEventListener('ended', onEnded);
    bound = null;
    onEnded = null;
  }
  function noteEnded(key) {
    if (!config.enabled || key !== task || !key) return;
    if (!ending || ending.key !== key) ending = { key, at: Date.now(), fromEvent: true };
  }
  function bindMedia(media) {
    if (!media || media === bound) return;
    detachMedia();
    bound = media;
    const key = task;
    onEnded = () => noteEnded(key);
    media.addEventListener('ended', onEnded);
  }
  function blockingDialog(vm) {
    if (vm?.answerDialogVisible || vm?.answerCorrectlyDialogVisible || vm?.breaksDialogVisible || vm?.isLockDialogVisible) return true;
    return [...document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper, [role="dialog"]')]
      .some(node => visible(node) && !node.contains(panel) && !node.querySelector('.startLearningBtn'));
  }
  function resetScope(key) {
    restoreTiming();
    restoreVisibility();
    detachMedia();
    scope = key;
    task = '';
    ending = null;
    switched = null;
    lastPlayAt = 0;
    readyAt = Date.now();
    done = false;
    initialSelectionDone = false;
  }
  function switchNext(vm) {
    if (!ending || Date.now() - ending.at < 2000) {
      setStatus('视频自然结束，等待平台保存进度后进入下一节');
      return;
    }
    if (progressBlock) return setStatus('学习进度未确认，已暂停切集：' + progressBlock.message + '；请复制诊断');
    const unconfirmed = timing?.reports.filter(item => item.taskId === task).length || 0;
    if (unconfirmed) return setStatus('视频已结束，仍有 ' + unconfirmed + ' 笔进度排队或等待确认；请保持页面打开，无需重看');
    if (vm?.currentCourse?.studyState != null && Number(vm.currentCourse.studyState) !== 2) {
      if (!ending.checkedCompletion) {
        ending.checkedCompletion = true;
        vm.getCourseHomeCategroy?.();
      }
      const remaining = Math.max(0, Number(vm.currentCourse.learnTime) - Number(vm.currentCourse.cumulativeTime));
      return setStatus('视频已结束，但平台尚未确认已学完' + (Number.isFinite(remaining) ? '；还需累计约 ' + Math.ceil(remaining) + ' 秒' : '') + '；已保留本节，不自动切走');
    }
    if (switched?.key === task) {
      if (Date.now() - switched.at > 20000) setStatus('切换后尚未检测到新小节；请检查网站提示或复制诊断');
      return;
    }
    let next = vm?.nextTrivia;
    if (vm && Array.isArray(vm.triviaList)) {
      const currentIndex = vm.triviaList.findIndex(item => String(item.taskId) === String(vm.currentCourse.taskId));
      if (currentIndex >= 0) next = vm.triviaList.slice(currentIndex + 1).find(item => Number(item.mediumType) === 2 && (!config.skipCompleted || Number(item.studyState) !== 2));
      if (currentIndex >= 0 && !next) {
        done = true;
        release();
        setStatus('本课程视频已播放完毕；非视频小节请按需手动查看');
        return;
      }
    }
    if (next?.taskId != null && Number(next.isLock) === 1) {
      setStatus('下一节尚未解锁；等待平台更新或本人处理提示');
      return;
    }
    if (next?.taskId != null && vm && String(next.taskId) !== String(vm.nextTrivia?.taskId)) {
      if (selectTask(vm, next)) {
        switched = { key: task, at: Date.now() };
        setStatus('已跳过非视频或已完成小节，打开下一个视频');
      } else setStatus('没有识别到下一个视频的切换入口，请复制诊断');
      return;
    }
    const button = [...document.querySelectorAll('.videoCompletion .nextSection_btn, .nextSection_btn')].find(visible);
    const list = rows();
    const at = list.findIndex(row => row.active);
    if (button && !button.matches('[disabled], [aria-disabled="true"], .is-disabled')) {
      switched = { key: task, at: Date.now() };
      button.click();
      setStatus('已点击网站“下一节”，等待播放器加载');
      return;
    }
    // 某些页面目录收起，不展示按钮；只调用平台已有的切换方法。
    if (vm && vm.isVideoComplete === true && next?.taskId != null) {
      switched = { key: task, at: Date.now() };
      vm.goNextTrivia();
      setStatus('已调用网站下一节，等待播放器加载');
      return;
    }
    if (at >= 0 && at + 1 < list.length && ending.fromEvent) {
      const candidate = list[at + 1];
      if (candidate.locked || !candidate.video) {
        setStatus('下一节未解锁或不是视频，请检查课程目录');
        return;
      }
      switched = { key: task, at: Date.now() };
      candidate.node.click();
      setStatus('已点击目录中的下一节');
      return;
    }
    if ((vm?.isVideoComplete === true && Array.isArray(vm.triviaList) && !next?.taskId) || (at >= 0 && at === list.length - 1 && ending.fromEvent)) {
      done = true;
      release();
      setStatus('本课程视频已播放完毕');
      return;
    }
    setStatus('视频已结束，等待网站显示下一节入口');
  }
  async function ensurePlaying(media, vm) {
    if (media) {
      media.muted = config.muted;
      if (media.error) return setStatus('播放器报告错误，请检查网络或重新打开本节');
      if (!media.paused) {
        setStatus('正在播放；结束后自动进入下一节');
        return;
      }
      if (playPending || Date.now() - lastPlayAt < 4000) return;
      lastPlayAt = Date.now();
      playPending = true;
      try {
        await media.play();
        if (!config.enabled) media.pause();
        else setStatus('已自动播放当前视频');
      } catch {
        if (config.enabled) setStatus('自动播放受浏览器限制；请手动点击一次播放');
      } finally { playPending = false; }
      return;
    }
    if (typeof vm?.player?.play === 'function' && Number(vm.currentCourse?.mediumType) === 2) {
      if (Date.now() - lastPlayAt < 10000) return;
      lastPlayAt = Date.now();
      try {
        if (config.muted) {
          if (typeof vm.player.setVolume === 'function') vm.player.setVolume(0);
          else if (typeof vm.player.mute === 'function') vm.player.mute();
        }
        await vm.player.play();
        setStatus('已请求网站播放器播放；等待完成状态');
      } catch { setStatus('请手动点击网站播放按钮一次'); }
      return;
    }
    setStatus('等待播放器加载');
  }
  async function tick() {
    try {
      if (!progressBlock && (progressQueue.length || progressTransportBusy)) {
        const lock = read(LOCK, null);
        if (!lock || lock.id === owner || lock.until <= Date.now()) write(LOCK, { id: owner, until: Date.now() + 12000 });
      }
      if (!/^\/coursePlay\/?$/i.test(location.pathname)) {
        restoreTiming();
        restoreVisibility();
        release();
        detachMedia();
        setStatus(/login/i.test(location.pathname) ? '请先在网站完成登录，进入课程后自动运行' : '等待进入云教师课程播放页');
        return;
      }
      const url = new URL(location.href);
      const key = url.pathname + ':' + (url.searchParams.get('courseId') || '');
      if (scope !== key) resetScope(key);
      if (!config.enabled) return;
      if (progressBlock) return setStatus('学习进度未确认，已暂停自动操作：' + progressBlock.message + '；请复制诊断');
      const vm = courseVm();
      const current = taskKey(vm);
      if (current && task !== current) {
        task = current;
        ending = null;
        switched = null;
        done = false;
        lastPlayAt = 0;
        detachMedia();
      }
      if (done || !canDrive()) return;
      installTiming(vm);
      installVisibility(vm);
      panel.querySelector('[data-current]').textContent = vm?.currentCourse?.title || rows().find(row => row.active)?.title || '等待课程目录';
      const start = [...document.querySelectorAll('.startLearningBtn')].find(visible);
      if (blockingDialog(vm)) return setStatus('网站弹出提示或认证，请本人处理后继续');
      if (start) {
        if (Date.now() - lastPlayAt >= 4000) { lastPlayAt = Date.now(); start.click(); }
        return setStatus('已点击网站“开始学习”，等待课程加载');
      }
      if (!initialSelectionDone && vm?.currentCourse?.taskId && vm.triviaList.length) {
        initialSelectionDone = true;
        if ((config.skipCompleted && Number(vm.currentCourse.studyState) === 2) || Number(vm.currentCourse.mediumType) !== 2) {
          const target = vm.triviaList.find(item => Number(item.mediumType) === 2 && (!config.skipCompleted || Number(item.studyState) !== 2));
          if (!target) {
            done = true; release();
            return setStatus('本课程没有待播放的视频；可取消“跳过已学完”后重新开始');
          }
          if (selectTask(vm, target)) return setStatus('已打开第一个未完成视频，等待播放器加载');
          initialSelectionDone = false;
          return setStatus('首个未完成视频尚未解锁，等待平台更新');
        }
      }
      if (vm?.currentCourse?.mediumType != null && Number(vm.currentCourse.mediumType) !== 2) return setStatus('当前小节不是视频，请手动完成该节后继续');
      const media = mediaIn();
      bindMedia(media);
      if (media?.ended) noteEnded(task);
      if (vm?.isVideoComplete === true || [...document.querySelectorAll('.videoCompletion')].some(visible)) {
        if (task && (!ending || ending.key !== task)) ending = { key: task, at: Date.now(), fromEvent: false };
      }
      if (ending?.key === task) return switchNext(vm);
      if (!current && !media && Date.now() - readyAt > 5000) {
        const first = rows().find(row => !row.locked && row.video && !row.complete);
        if (first && Date.now() - lastPlayAt > 10000) {
          lastPlayAt = Date.now();
          first.node.click();
          return setStatus('已打开第一个未完成视频');
        }
      }
      await ensurePlaying(media, vm);
    } catch (error) { setStatus('运行异常：' + error.message); }
  }
  async function diagnose() {
    const vm = courseVm();
    const media = mediaIn();
    const url = new URL(location.href);
    const data = {
      version: VERSION, platform: 'yunteacher', path: url.pathname,
      courseId: url.searchParams.get('courseId'), enabled: config.enabled, skipCompleted: config.skipCompleted, status,
      progressClock: config.progressClock, clockPatched: !!timing,
      backgroundPlayback: config.backgroundPlayback, hiddenPauseRemoved: !!visibilityPatch,
      pendingLearnTime: timing ? Number(timing.pending.toFixed(1)) : null,
      peakObservedRate: timing ? Number(timing.peakObservedRate.toFixed(2)) : null,
      discardedSdkSeconds: timing ? Number(timing.discardedSdkSeconds.toFixed(1)) : null,
      lastProgressCall: timing?.lastReport || null,
      skippedEmptyReports: timing?.skippedEmptyReports || 0,
      progressBlock, progressReceipts,
      progressIntervalMs: PROGRESS_INTERVAL, queuedProgressCount: progressQueue.length, progressTransportBusy,
      unconfirmedReports: timing?.reports.map(item => ({ taskId: item.taskId, learnTime: item.learnTime, state: item.state })) || [],
      taskId: task, vueDetected: !!vm, isVideoComplete: !!vm?.isVideoComplete,
      next: vm?.nextTrivia?.taskId == null ? null : { taskId: String(vm.nextTrivia.taskId), mediumType: vm.nextTrivia.mediumType, locked: Number(vm.nextTrivia.isLock) === 1 },
      videos: document.querySelectorAll('video').length,
      media: media ? { paused: media.paused, ended: media.ended, readyState: media.readyState, currentTime: Math.floor(media.currentTime || 0), duration: Number.isFinite(media.duration) ? Math.floor(media.duration) : null } : null,
      directory: rows().map(row => ({ index: row.index, active: row.active, locked: row.locked, video: row.video, complete: row.complete })),
      nextButtons: document.querySelectorAll('.nextSection_btn').length,
      dialog: blockingDialog(vm), logs: logs.slice(0, 10)
    };
    const text = JSON.stringify(data, null, 2);
    try { await navigator.clipboard.writeText(text); setStatus('诊断已复制'); }
    catch { window.prompt('复制诊断（不含 Cookie、视频地址或登录票据）', text); }
  }
  const muted = panel.querySelector('[data-muted]');
  muted.checked = config.muted;
  muted.addEventListener('change', () => {
    config.muted = muted.checked;
    write(CFG, config);
    const media = mediaIn();
    if (media) media.muted = config.muted;
  });
  const skip = panel.querySelector('[data-skip]');
  skip.checked = config.skipCompleted;
  skip.addEventListener('change', () => { config.skipCompleted = skip.checked; write(CFG, config); });
  const clock = panel.querySelector('[data-clock]');
  clock.checked = config.progressClock;
  clock.addEventListener('change', () => {
    config.progressClock = clock.checked;
    write(CFG, config);
    if (!config.progressClock) restoreTiming();
    else if (config.enabled) installTiming(courseVm());
  });
  const background = panel.querySelector('[data-background]');
  background.checked = config.backgroundPlayback;
  background.addEventListener('change', () => {
    config.backgroundPlayback = background.checked;
    write(CFG, config);
    if (!config.backgroundPlayback) restoreVisibility();
    else if (config.enabled) installVisibility(courseVm());
  });
  panel.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'toggle-panel') {
      const body = panel.querySelector('[data-body]');
      body.hidden = !body.hidden;
    }
    if (action === 'diagnose') void diagnose();
    if (action === 'stop') {
      config.enabled = false;
      write(CFG, config);
      release();
      try {
        const media = mediaIn();
        if (media) media.pause();
        else courseVm()?.player?.pause?.();
      } catch {
        // 平台在播放器加载/销毁期间可能保留失效的 SDK pause；仍须恢复补丁。
      } finally {
        try { restoreTiming(); } finally { restoreVisibility(); }
      }
      setStatus('已停止自动播放及切集' + (progressQueue.length || progressTransportBusy ? '；已观看的进度仍在排队确认，请保持页面打开' : ''));
    }
    if (action === 'start') {
      if (progressBlock) {
        setStatus('上次上报未确认：' + progressBlock.message + '；请先刷新页面核对平台进度，避免重复记账');
        return;
      }
      config.enabled = true;
      done = false;
      initialSelectionDone = false;
      switched = null;
      lastPlayAt = 0;
      write(CFG, config);
      setStatus('已启动，等待播放器');
      void tick();
    }
  });
  window.addEventListener('pagehide', () => {
    restoreTiming(); restoreVisibility(); release(true); detachMedia();
    if (XMLHttpRequest.prototype.open === observedOpen) XMLHttpRequest.prototype.open = originalXhrOpen;
    if (XMLHttpRequest.prototype.send === observedSend) XMLHttpRequest.prototype.send = originalXhrSend;
  });
  window.addEventListener('pageshow', () => {
    if (XMLHttpRequest.prototype.open === originalXhrOpen) XMLHttpRequest.prototype.open = observedOpen;
    if (XMLHttpRequest.prototype.send === originalXhrSend) XMLHttpRequest.prototype.send = observedSend;
    void tick();
  });
  window.addEventListener('beforeunload', event => {
    if (progressQueue.length || progressTransportBusy) { event.preventDefault(); event.returnValue = ''; }
  });
  setStatus(config.enabled ? '已启用自动播放及切集' : '已停止；点击开始启用');
  setInterval(() => void tick(), 700);
  void tick();
})();
