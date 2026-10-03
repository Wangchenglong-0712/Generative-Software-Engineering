/*!
 * podcast.js — 「讲义播客」引擎
 * ---------------------------------------------------------------
 * 把页面正文变成一档双人对谈播客，并用 TTS 念出来；播放进度会
 * 反向驱动页面（高亮当前章节 / 逐句高亮 / 自动滚动）。
 *
 * 设计原则：
 *  1. 零外部依赖，纯原生 JS，可离线运行。
 *  2. 不改动正文，只在运行时读取 DOM。
 *  3. 不支持的浏览器静默降级，不报错、不影响原有页面功能。
 *
 * 用法：
 *   Podcast.init({
 *     root: document,                       // 内容根节点
 *     tocSelector: '#toc a',                // 侧栏目录链接（用于高亮联动）
 *     mount: document.body,                 // 挂载播放器的容器
 *     hosts: [ {name:'甲', voice:'', rate:1}, ... ],
 *     storageKey: 'gse2-podcast'
 *   });
 * ---------------------------------------------------------------
 */
(function (global) {
  'use strict';

  /* ============ 小工具 ============ */
  /* 始终绑定到「页面所在的那个 document」，避免在特殊宿主环境里取错文档对象 */
  var DOC = global.document;
  var $ = function (sel, ctx) { return (ctx || DOC).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || DOC).querySelectorAll(sel)); };
  function create(tag, cls) { var el = DOC.createElement(tag); if (cls) el.className = cls; return el; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* 把一串文本按「句」切开——中文标点 + 英文标点 + 换行 */
  function splitSentences(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    // 只在句末标点处切；冒号、逗号不切，避免念出「……问题是：」这种半截话
    var parts = text.split(/(?<=[。！？!?…])|(?<=；)/);
    var out = [];
    parts.forEach(function (p) {
      p = p.replace(/^[，、,;；:：\s]+/, '').trim();   // 去掉切开后残留的领标点
      if (!p) return;
      // 太长的句子再按逗号切一刀，避免一次念太久
      if (p.length > 100) {
        p.split(/(?<=[，,、])/).forEach(function (q) {
          q = q.replace(/^[，、,;；:：\s]+/, '').trim();
          if (q && q.length > 2) out.push(q);
        });
      } else if (p.length > 2) {
        out.push(p);
      }
    });
    return out;
  }

  /* 清洗正文文本：去掉锚点 #、多余空白 */
  function cleanText(node) {
    if (!node) return '';
    var clone = node.cloneNode(true);
    $$('.ha, .anchor', clone).forEach(function (x) { x.parentNode && x.parentNode.removeChild(x); });
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /* ============ 音色库 ============ */
  /* 把系统 voice 分门别类，给用户一个「丰富音色」的选择空间 */
  function classifyVoices(voices) {
    var zh = [], other = [];
    voices.forEach(function (v) {
      var lang = (v.lang || '').toLowerCase();
      var name = (v.name || '').toLowerCase();
      var isZh = lang.indexOf('zh') === 0 || lang.indexOf('cmn') === 0 ||
                 /chinese|mandarin|普通话|中文|晓|云|小|婷|玲|欣|芳|静|美|琪|阳/.test(name);
      (isZh ? zh : other).push(v);
    });
    return { zh: zh, other: other, all: zh.concat(other) };
  }

  /* 音色「人设」标签：尽量从名字里猜出性别风格，猜不出就给个中性标签 */
  function voiceLabel(v) {
    var n = (v.name || '').toLowerCase();
    if (/female|女|晓晓|晓伊|晓萱|晓涵|晓墨|晓梦|xiaoxiao|xiaoyi|xiaomo|xiaorui/.test(n)) return '女声';
    if (/male|男|云希|云扬|云健|云枫|云皓|yunxi|yunyang|yunjian|yunfeng|yunhao/.test(n)) return '男声';
    if (/natural|neural|online/.test(n)) return '自然';
    return '音色';
  }

  /* ============ 正文 → 播客脚本 ============ */
  /**
   * 扫描内容区，按 section 抓成「章节」；每章再抽出关键句，
   * 由两位主播一问一答讲出来。目标是听起来像节目，而不是机器念经。
   */
  function buildScript(root, opt) {
    var hostA = opt.hosts[0], hostB = opt.hosts[1];
    var sections = $$('main section, .content section, section', root);
    if (!sections.length) sections = $$('main > *', root);

    var chapters = [];
    sections.forEach(function (sec) {
      var h2 = sec.querySelector('h2');
      if (!h2) return;
      var title = cleanText(h2);
      if (!title || /^目录$/.test(title)) return;
      if (/附录/.test(title)) return;             // 附录过长，不适合听

      // 正文文本：优先段落与列表，退化为整节
      var bodyText = '';
      var ps = $$('p, li', sec);
      ps.forEach(function (p) {
        if (p.closest('details')) return;
        var t = cleanText(p);
        if (t && t.length > 12 && !/^📷/.test(t)) bodyText += t + ' ';
      });
      if (bodyText.length < 30) {
        // 表格型章节（如「一页纸总结」）：把表格行拼成「要点：说明」
        var rows = $$('table tbody tr', sec);
        if (rows.length) {
          bodyText = '';
          rows.forEach(function (tr) {
            var tds = $$('td', tr);
            if (tds.length >= 2) {
              var k = cleanText(tds[0]), v = cleanText(tds[1]);
              if (k && v) bodyText += k + '——' + v + ' ';
            }
          });
        }
      }
      if (bodyText.length < 30) bodyText = cleanText(sec);

      var sentences = splitSentences(bodyText).filter(function (s) { return s.length > 10; });
      if (!sentences.length) return;

      var keyPoints = sentences.slice(0, opt.maxSentencesPerChapter || 6);

      var turns = [];
      turns.push({ sp: 0, text: '第 ' + (chapters.length + 1) + ' 部分，' + title + '。' });
      keyPoints.forEach(function (s, i) {
        if (i % 2 === 0) {
          turns.push({ sp: 0, text: s });
        } else {
          turns.push({ sp: 1, text: pickBridge(i) + s });
        }
      });
      if (turns.length > 2) {
        turns.push({ sp: 1, text: '好，这一部分我们先聊到这。' });
      }

      chapters.push({
        title: title,
        anchorId: h2.id || '',
        sentences: keyPoints,
        turns: turns
      });
    });

    // 片头：两位主播报幕
    if (chapters.length) {
      chapters.unshift({
        title: '节目开场',
        anchorId: '',
        sentences: [],
        turns: [
          { sp: 0, text: '欢迎收听《生成式软件工程》讲义播客。' },
          { sp: 1, text: '我们会用对谈的方式，把这一讲的内容讲给你听。' },
          { sp: 0, text: '如果听到感兴趣的地方，页面会跟着播客自动定位到对应的章节。' }
        ]
      });
    }
    return chapters;
  }

  var BRIDGES = ['那这里其实有个关键点，', '换个角度说，', '我补充一句，', '顺着刚才的话，', '这里要注意，', '有意思的是，'];
  function pickBridge(i) { return BRIDGES[i % BRIDGES.length]; }

  /* ============ 主控制器 ============ */
  function Podcast(options) {
    this.o = Object.assign({
      root: DOC,
      mount: DOC.body,
      tocSelector: '#toc a',
      triggerSelector: '',          // 外部触发按钮选择器，如 '#podcast-open'
      hosts: [{ name: '主讲' }, { name: '助教' }],
      storageKey: 'gse-podcast',
      maxSentencesPerChapter: 6,
      autoScroll: true
    }, options || {});

    this.synth = global.speechSynthesis;
    this.voices = [];
    this.chapters = [];
    this.playing = false;
    this.cursor = { ch: 0, turn: 0 };   // 当前读到第几章第几条
    this.utter = null;
    this.rate = 1;
    this._ignoreEnd = false;
    this.listeners = {};
    this._scrollLock = 0;
    this._buildUI();
    this._bindVoices();
  }

  Podcast.prototype = {

    /* ---- 事件 ---- */
    on: function (evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); return this; },
    emit: function (evt, data) {
      (this.listeners[evt] || []).forEach(function (fn) { try { fn(data); } catch (e) {} });
    },

    /* ---- 能力检测 ---- */
    supported: function () { return !!(this.synth && global.SpeechSynthesisUtterance); },

    /* ---- 音色 ---- */
    _bindVoices: function () {
      if (!this.synth) return;
      var self = this;
      var load = function () {
        self.voices = self.synth.getVoices() || [];
        if (self.voices.length) self._fillVoiceSelects();
      };
      load();
      if (this.synth.addEventListener) this.synth.addEventListener('voiceschanged', load);
      else this.synth.onvoiceschanged = load;
      // 有些浏览器延迟返回，轮询几次兜底
      var tries = 0;
      var timer = setInterval(function () {
        if (self.voices.length || ++tries > 10) { clearInterval(timer); return; }
        load();
      }, 300);
    },

    _fillVoiceSelects: function () {
      var self = this;
      var cls = classifyVoices(this.voices);
      var list = cls.all.length ? cls.all : this.voices;
      var used = {};                      // 已分配给前一位主播的音色，避免两人同声
      this.o.hosts.forEach(function (h, i) {
        var sel = $('#pod-voice-' + i, self.el);
        if (!sel) return;
        var cur = h.voice;
        sel.innerHTML = '';
        list.forEach(function (v) {
          var op = DOC.createElement('option');
          op.value = v.name;
          var tag = voiceLabel(v);
          op.textContent = v.name + '（' + tag + (v.lang ? ' · ' + v.lang : '') + '）';
          if (cur === v.name) op.selected = true;
          sel.appendChild(op);
        });
        if (!cur || !sel.value) {
          // 默认：两位主播尽量用不同音色，从第 i 个可用音色起挑，跳过已占用的
          var pick = null;
          for (var k = 0; k < list.length; k++) {
            var cand = list[(i + k) % list.length];
            if (!used[cand.name]) { pick = cand; break; }
          }
          if (!pick) pick = list[Math.min(i, list.length - 1)];
          if (pick) {
            sel.value = pick.name;
            h.voice = pick.name;
            used[pick.name] = true;
          }
        } else {
          used[h.voice] = true;
        }
      });
    },

    _voiceByName: function (name) {
      for (var i = 0; i < this.voices.length; i++) if (this.voices[i].name === name) return this.voices[i];
      return null;
    },

    /* ---- 构建 UI ---- */
    _buildUI: function () {
      var self = this;
      var wrap = DOC.createElement('div');
      wrap.className = 'pod';
      wrap.id = 'pod';
      wrap.innerHTML = [
        '<button class="pod-fab" id="pod-fab" type="button" aria-label="打开讲义播客">',
        '  <span class="pod-fab-ico">🎙</span><span class="pod-fab-tx">播客</span>',
        '</button>',

        '<div class="pod-bar" id="pod-bar" role="region" aria-label="播客播放条">',
        '  <button class="pod-btn pod-play" id="pod-play" type="button" aria-label="播放/暂停">▶</button>',
        '  <div class="pod-meta">',
        '    <div class="pod-title"><span class="pod-live"></span><span id="pod-cur-title">讲义播客</span></div>',
        '    <div class="pod-sub" id="pod-cur-sub">共 0 段 · 准备就绪</div>',
        '  </div>',
        '  <div class="pod-prog" id="pod-prog" title="点击跳转">',
        '    <div class="pod-prog-fill" id="pod-prog-fill"></div>',
        '  </div>',
        '  <button class="pod-btn" id="pod-prev" type="button" title="上一段">⏮</button>',
        '  <button class="pod-btn" id="pod-next" type="button" title="下一段">⏭</button>',
        '  <button class="pod-btn" id="pod-expand" type="button" title="展开面板">⤢</button>',
        '</div>',

        '<div class="pod-panel" id="pod-panel" hidden>',
        '  <div class="pod-panel-hd">',
        '    <b>🎙 讲义播客</b>',
        '    <button class="pod-x" id="pod-close" type="button" aria-label="收起">✕</button>',
        '  </div>',
        '  <div class="pod-voices" id="pod-voices"></div>',
        '  <div class="pod-opts">',
        '    <label class="pod-opt">语速 <input type="range" id="pod-rate" min="0.6" max="1.6" step="0.05" value="1"><span id="pod-rate-v">1.0×</span></label>',
        '    <label class="pod-opt pod-chk"><input type="checkbox" id="pod-follow" checked> 页面跟随播客</label>',
        '  </div>',
        '  <div class="pod-list" id="pod-list"></div>',
        '  <div class="pod-tip" id="pod-tip"></div>',
        '</div>'
      ].join('\n');

      this.o.mount.appendChild(wrap);
      this.el = wrap;

      // 两个主播的音色选择器
      var vbox = $('#pod-voices', wrap);
      if (vbox && typeof vbox.appendChild === 'function') {
        this.o.hosts.forEach(function (h, i) {
          var row = DOC.createElement('div');
          row.className = 'pod-voice-row';
          row.innerHTML = '<span class="pod-voice-name"><i class="pod-avatar av' + i + '">' +
            esc(h.name.slice(0, 1)) + '</i>' + esc(h.name) + '</span>' +
            '<select id="pod-voice-' + i + '" class="pod-select"></select>';
          vbox.appendChild(row);
        });
      }

      this._wire();
    },

    _wire: function () {
      var self = this;
      var fab = $('#pod-fab', this.el);
      var bar = $('#pod-bar', this.el);
      var panel = $('#pod-panel', this.el);

      if (fab) fab.addEventListener('click', function () { self.open(); });

      /* 外部触发按钮（如页面顶部“🎙 播客”）：由配置的 triggerSelector 绑定 */
      if (this.o.triggerSelector) {
        $$(this.o.triggerSelector).forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.preventDefault();
            self.open();
          });
        });
      }

      $('#pod-close', this.el).addEventListener('click', function () { self.close(); });
      $('#pod-expand', this.el).addEventListener('click', function () {
        panel.hidden = !panel.hidden;
        self.el.classList.toggle('pod-expand', !panel.hidden);
      });

      $('#pod-play', this.el).addEventListener('click', function () { self.toggle(); });
      $('#pod-prev', this.el).addEventListener('click', function () { self.prev(); });
      $('#pod-next', this.el).addEventListener('click', function () { self.next(); });

      $('#pod-prog', this.el).addEventListener('click', function (e) {
        if (!self.chapters.length) return;
        var r = this.getBoundingClientRect();
        var ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        var total = self.totalTurns();
        var target = Math.floor(ratio * total);
        self.seekTurn(target);
      });

      var rate = $('#pod-rate', this.el);
      rate.addEventListener('input', function () {
        self.rate = parseFloat(this.value);
        $('#pod-rate-v', self.el).textContent = self.rate.toFixed(1) + '×';
        self._persist();
      });

      $('#pod-follow', this.el).addEventListener('change', function () {
        self.o.autoScroll = this.checked;
        self._persist();
      });

      this.o.hosts.forEach(function (h, i) {
        var sel = $('#pod-voice-' + i, self.el);
        sel && sel.addEventListener('change', function () {
          h.voice = this.value;
          self._persist();
          self.emit('voicechange', { index: i, voice: this.value });
        });
      });

      var list = $('#pod-list', this.el);
      list.addEventListener('click', function (e) {
        var row = e.target.closest ? e.target.closest('.pod-ch') : null;
        if (!row) return;
        var idx = parseInt(row.getAttribute('data-ch'), 10);
        if (!isNaN(idx)) self.playChapter(idx);
      });

      // 页面左侧目录点击 → 播客跟着跳
      DOC.addEventListener('click', function (e) {
        var a = e.target.closest ? e.target.closest(self.o.tocSelector) : null;
        if (!a || !self.el.classList.contains('pod-open')) return;
        var id = decodeURIComponent((a.getAttribute('href') || '').slice(1));
        var ci = self.chapters.findIndex(function (c) { return c.anchorId === id; });
        if (ci >= 0 && self.playing) self.playChapter(ci);
      });

      // 空格键播放/暂停（输入框内不触发）
      DOC.addEventListener('keydown', function (e) {
        if (e.key !== ' ' || e.target.matches('input,textarea,select,[contenteditable]')) return;
        if (!self.el.classList.contains('pod-open') || !self.playing) return;
        e.preventDefault();
        self.toggle();
      });

      this._restore();
    },

    /* ---- 持久化 ---- */
    _persist: function () {
      try {
        localStorage.setItem(this.o.storageKey, JSON.stringify({
          voices: this.o.hosts.map(function (h) { return h.voice; }),
          rate: this.rate,
          follow: this.o.autoScroll
        }));
      } catch (e) {}
    },
    _restore: function () {
      var st;
      try { st = JSON.parse(localStorage.getItem(this.o.storageKey) || 'null'); } catch (e) {}
      if (!st) return;
      (st.voices || []).forEach(function (v, i) { if (v && this.o.hosts[i]) this.o.hosts[i].voice = v; }, this);
      if (st.rate) { this.rate = st.rate; $('#pod-rate', this.el).value = st.rate; $('#pod-rate-v', this.el).textContent = st.rate.toFixed(1) + '×'; }
      if (typeof st.follow === 'boolean') { this.o.autoScroll = st.follow; $('#pod-follow', this.el).checked = st.follow; }
    },

    /* ---- 准备脚本 ---- */
    prepare: function () {
      this.chapters = buildScript(this.o.root, {
        hosts: this.o.hosts,
        maxSentencesPerChapter: this.o.maxSentencesPerChapter
      });
      this._renderList();
      this._renderTip();
      this.emit('ready', this.chapters);
      return this.chapters.length;
    },

    totalTurns: function () {
      return this.chapters.reduce(function (n, c) { return n + c.turns.length; }, 0);
    },

    _renderList: function () {
      var list = $('#pod-list', this.el);
      if (!list) return;
      var self = this;
      list.innerHTML = this.chapters.map(function (c, i) {
        return '<button class="pod-ch" type="button" data-ch="' + i + '">' +
          '<span class="pod-ch-n">' + (i + 1) + '</span>' +
          '<span class="pod-ch-t">' + esc(c.title) + '</span>' +
          '<span class="pod-ch-d">' + c.turns.length + ' 句</span>' +
          '</button>';
      }).join('');
      var t = $('#pod-cur-sub', this.el);
      if (t) t.textContent = '共 ' + this.chapters.length + ' 章 · ' + this.totalTurns() + ' 段';
    },

    _renderTip: function () {
      var tip = $('#pod-tip', this.el);
      if (!tip) return;
      if (!this.supported()) {
        tip.innerHTML = '⚠️ 当前浏览器不支持语音合成（Web Speech API）。建议使用 <b>Edge / Chrome / Safari</b> 打开本页。';
        tip.classList.add('warn');
      } else if (this.voices.length <= 1) {
        tip.innerHTML = '💡 只检测到 ' + this.voices.length + ' 个系统音色。安装更多语音包（Windows：设置 → 时间和语言 → 语音）后可获得更丰富的主播音色。';
      } else {
        tip.innerHTML = '💡 已检测到 ' + this.voices.length + ' 个系统音色，可在上方为主讲与助教分别挑选。';
      }
    },

    /* ---- 播放控制 ---- */
    toggle: function () { this.playing ? this.pause() : this.play(); },

    /* 打开播放器（外部按钮/悬浮按钮都走这里） */
    open: function () {
      if (!this.chapters.length) this.prepare();
      if (!this.supported()) {                     // 不支持语音：仍然展开面板，显示提示
        this.el.classList.add('pod-open');
        var p0 = $('#pod-panel', this.el); if (p0) p0.hidden = false;
        this._renderTip();
        return;
      }
      this.el.classList.add('pod-open');
      $('#pod-bar', this.el).classList.add('on');
      var panel = $('#pod-panel', this.el);
      if (panel && panel.hidden) {                 // 首次打开时展开脚本列表
        panel.hidden = false;
        this.el.classList.add('pod-expand');
      }
      if (!this.chapters.length) return;
      this._updateProgress();
      this._highlightList();
    },

    close: function () {
      var panel = $('#pod-panel', this.el);
      if (panel) panel.hidden = true;
      this.el.classList.remove('pod-expand');
      this.el.classList.remove('pod-open');
      $('#pod-bar', this.el).classList.remove('on');
      this.pause();
    },

    play: function () {
      if (!this.supported()) { this.open(); return; }
      if (!this.chapters.length && !this.prepare()) return;
      this.el.classList.add('pod-open');
      $('#pod-bar', this.el).classList.add('on');
      this.playing = true;
      this._setPlayIcon(true);
      this._speakCurrent();
    },

    pause: function () {
      this.playing = false;
      this._setPlayIcon(false);
      if (this.synth) {
        try { this.synth.cancel(); } catch (e) {}
      }
      this._unhighlight();
    },

    stop: function () { this.pause(); this.cursor = { ch: 0, turn: 0 }; },

    next: function () {
      var seq = this._flat();
      var at = this._flatIndex();
      this._cancelSpeech();                 // 先掐掉在念的这句，否则它的 onend 会再推一格
      if (at >= seq.length - 1) { this.pause(); this._updateProgress(); return; }
      this._gotoFlat(at + 1, this.playing);
    },
    prev: function () {
      var at = this._flatIndex();
      this._cancelSpeech();
      this._gotoFlat(Math.max(0, at - 1), this.playing);
    },

    /* 取消当前朗读，并标记一个「忽略下一次 onend」的旗标 */
    _cancelSpeech: function () {
      this._ignoreEnd = true;
      if (this.synth) { try { this.synth.cancel(); } catch (e) {} }
    },

    playChapter: function (ci) {
      ci = Math.max(0, Math.min(this.chapters.length - 1, ci));
      this._cancelSpeech();
      this.cursor = { ch: ci, turn: 0 };
      if (this.playing) this._speakCurrent();
      else { this._updateProgress(); this._scrollToCurrent(); this._highlightList(); }
    },

    seekTurn: function (n) {
      this._cancelSpeech();
      this._gotoFlat(n, this.playing);
    },

    /* 把 (ch,turn) 展开成一维序号 */
    _flat: function () {
      var out = [];
      this.chapters.forEach(function (c, ci) {
        c.turns.forEach(function (t, ti) { out.push({ ch: ci, turn: ti }); });
      });
      return out;
    },
    _flatIndex: function () {
      var n = 0;
      for (var i = 0; i < this.cursor.ch; i++) n += this.chapters[i].turns.length;
      return n + this.cursor.turn;
    },
    _gotoFlat: function (flat, keepPlaying) {
      var seq = this._flat();
      if (!seq.length) return;
      flat = Math.max(0, Math.min(seq.length - 1, flat));
      var pos = seq[flat];
      this.cursor = { ch: pos.ch, turn: pos.turn };
      if (this.playing && !keepPlaying) { /* noop */ }
      if (keepPlaying) this._speakCurrent();
      else { this._updateProgress(); this._scrollToCurrent(); this._highlightList(); }
    },

    _setPlayIcon: function (playing) {
      var b = $('#pod-play', this.el);
      if (b) b.textContent = playing ? '⏸' : '▶';
      var lb = $('.pod-live', this.el);
      if (lb) lb.classList.toggle('on', playing);
    },

    /* ---- 朗读当前一句 ---- */
    _speakCurrent: function () {
      var self = this;
      if (!this.playing) return;
      var ch = this.chapters[this.cursor.ch];
      if (!ch) { this.pause(); return; }
      var turn = ch.turns[this.cursor.turn];
      if (!turn) { this.pause(); return; }

      var u = new global.SpeechSynthesisUtterance(turn.text);
      var host = this.o.hosts[turn.sp] || this.o.hosts[0];
      var v = this._voiceByName(host.voice);
      if (v) u.voice = v;
      u.lang = (v && v.lang) || 'zh-CN';
      u.rate = this.rate;
      u.pitch = turn.sp === 0 ? 1 : 1.12;   // 两个主播音高略作区分，更有「双人」感
      u.volume = 1;

      u.onstart = function () {
        self._updateProgress();
        self._highlightList();
        self._scrollToCurrent();
        self.emit('turnstart', { ch: self.cursor.ch, turn: self.cursor.turn, text: turn.text, speaker: turn.sp });
      };
      u.onend = function () {
        if (!self.playing) return;
        if (self._ignoreEnd) { self._ignoreEnd = false; return; }   // 被主动跳过，不推进
        // 推进到下一条
        var c = self.chapters[self.cursor.ch];
        if (self.cursor.turn + 1 < c.turns.length) {
          self.cursor.turn++;
        } else if (self.cursor.ch + 1 < self.chapters.length) {
          self.cursor = { ch: self.cursor.ch + 1, turn: 0 };
        } else {
          self.pause();
          self._updateProgress(1);
          self.emit('finish');
          return;
        }
        self._speakCurrent();
      };
      u.onerror = function (e) {
        // interrupted / canceled 是正常的（我们主动 cancel）
        if (e && (e.error === 'interrupted' || e.error === 'canceled')) return;
        self.emit('error', e);
      };

      this.utter = u;
      this._ignoreEnd = false;
      try {
        this.synth.cancel();     // 清掉可能的残留（随即被 _ignoreEnd/新 u 覆盖）
        this.synth.speak(u);
      } catch (err) { this.emit('error', err); }
    },

    /* ---- 进度与高亮 ---- */
    _progressRatio: function (override) {
      if (typeof override === 'number') return override;
      var seq = this._flat();
      if (!seq.length) return 0;
      return this._flatIndex() / seq.length;
    },
    _updateProgress: function (override) {
      var r = this._progressRatio(override);
      var fill = $('#pod-prog-fill', this.el);
      if (fill) fill.style.width = (r * 100).toFixed(2) + '%';
      var ch = this.chapters[this.cursor.ch];
      if (ch) {
        var t = $('#pod-cur-title', this.el);
        if (t) t.textContent = ch.title;
        var s = $('#pod-cur-sub', this.el);
        if (s && s.dataset.fixed !== '1') {
          var seq = this._flat();
          s.textContent = '第 ' + (this._flatIndex() + 1) + ' / ' + seq.length + ' 段 · ' +
            (this.playing ? '播放中' : '已暂停');
        }
      }
    },

    _highlightList: function () {
      $$('.pod-ch', this.el).forEach(function (b) {
        b.classList.toggle('on', parseInt(b.getAttribute('data-ch'), 10) === this.cursor.ch);
      }, this);
      var cur = $('.pod-ch.on', this.el);
      if (cur) {
        var box = $('#pod-list', this.el);
        if (box) {
          var top = cur.offsetTop - box.offsetTop;
          if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 40) {
            box.scrollTop = top - 20;
          }
        }
      }
    },

    /* 页面联动：滚动到当前章节 */
    _scrollToCurrent: function () {
      if (!this.o.autoScroll) return;
      var ch = this.chapters[this.cursor.ch];
      if (!ch || !ch.anchorId) return;
      var now = Date.now();
      if (now - this._scrollLock < 700) return;
      var h = DOC.getElementById(ch.anchorId);
      if (!h) return;
      this._scrollLock = now;
      var y = h.getBoundingClientRect().top + window.scrollY - 90;
      window.scrollTo({ top: y, behavior: 'smooth' });
      this.emit('scrollto', ch);
    },

    _unhighlight: function () {
      this.emit('stop');
    }
  };

  /* ============ 对外接口 ============ */
  var instance = null;
  global.Podcast = {
    /**
     * 初始化播客。任何异常都会被吞掉并返回 null——
     * 播客只是「附加功能」，绝不允许它影响讲义页本身。
     */
    init: function (opts) {
      try {
        instance = new Podcast(opts);
        // 预生成本地脚本（不发声），让入口按钮知道有没有内容
        instance.prepare();
        return instance;
      } catch (e) {
        if (global.console && console.warn) console.warn('[podcast] 初始化失败：', e);
        instance = null;
        return null;
      }
    },
    get: function () { return instance; },
    _internals: { splitSentences: splitSentences, buildScript: buildScript, classifyVoices: classifyVoices }
  };

})(typeof window !== 'undefined' ? window : this);
