/**
 * <mini-player> — 连环 悬浮歌条 / 唱片豆
 * 原生 Web Component，无依赖。<script src="mini-player.js"></script> 后直接用 <mini-player></mini-player>
 *
 * 三态：cd（旋转唱片＋进度环） ⇄ lyric（一整行歌词） ⇄ card（歌词＋封面／进度／关掉）
 * 手势：拖右侧横杠＝挪位子 · 左右滑＝切歌 · 下拉＝出详情 · 上推＝逐档收起 · 长按＝环填满才停播
 *      点豆子＝展开歌词条；只有展开后详情卡里那张方形封面 → 发 pickersong（去点歌页）
 * 关键约定：收起 ≠ 关掉。关掉后必须由宿主页面提供入口再调 open()（见 miniplayer:closed 事件）。
 *
 * API      player.setTrack({title,artist,cover,duration}) / setLyrics([{t,text}]) / setProgress(sec)
 *          player.playing = true|false   player.open() / close() / expand() / collapse()
 * 事件     miniplayer:play  pause  next  prev  seek{detail:{ratio}}  closed  opened  modechange{detail:{mode}}
 *          miniplayer:pickersong — 详情卡里那张方形封面被点（宿主据此打开点歌/搜歌页）
 * 位置记忆 localStorage['miniplayer:pos'] = {x,y,side,mode}
 */
(function () {
  /* 0906 接进连环时改的：原来这儿自造了一条 cubic-bezier(.34,1.32,.5,1)。
     连环的 Motion Spec 只有四条曲线（DESIGN.md：「别自己另起一套」），
     过冲 4% 那条就是 --spring-soft。读不到就退回原来那条，组件单独跑时行为不变。 */
  const SPRING = 'var(--spring-soft, cubic-bezier(.34,1.26,.64,1))';
  const H = { cd: 50, lyric: 42, card: 134 };
  const LS = 'lh.mp.pos';          /* 连环存在本机的 key 都是 lh.* 打头，跟着走 */

  class MiniPlayer extends HTMLElement {
    /* 0906 接进连环时加了两个：safe-top / safe-bottom。
       宿主是实测出来喂进来的（输入框在聊天页才显示、键盘会弹、底栏有没有 home indicator
       都不一样），所以这两个值会变。变了要重新把位置夹回界内 —— 见下面 attributeChangedCallback。 */
    static get observedAttributes() { return ['playing', 'safe-top', 'safe-bottom']; }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      const saved = this._load();
      this.state = {
        mode: saved.mode === 'card' ? 'lyric' : (saved.mode || 'cd'),
        x: saved.x != null ? saved.x : null,   // null = 首次，挂载后吸右边
        y: saved.y != null ? saved.y : 240,
        side: saved.side || 'right',
        p: 0, dx: 0, drag: false, hold: 0, closed: false, playing: false,
      };
      /* 0906：原来这儿写死一首「雾中人 / 李润 / 227s」当占位。连环里没放歌的时候
         不该凭空冒出一首没有的歌 —— 空着，宿主 setTrack 之前就是空条。 */
      this.track = { title: '', artist: '', cover: '', duration: 0 };
      this.lyrics = [{ t: 0, text: '' }];
      this.pos = 0;
      this._ratio = 0;
      this.shadowRoot.innerHTML = this._css() + this._html();
    }

    /* ─── 生命周期 ─── */
    connectedCallback() {
      const r = this.shadowRoot;
      this.$root = r.getElementById('root');
      this.$box = r.getElementById('box');
      this.$ring = r.getElementById('ring');
      this.$cover = r.getElementById('cover');
      this.$lyric = r.getElementById('lyric');
      this.$lyricHi = r.getElementById('lyricHi');
      this.$hint = r.getElementById('hint');
      this.$title = r.getElementById('title');
      this.$meta = r.getElementById('meta');
      this.$bar = r.getElementById('bar');
      this.$bubbles = r.getElementById('bubbles');
      this.$cardCover = r.getElementById('cardCover');

      if (this.state.x === null) this.state.x = this._maxX();
      this.$box.addEventListener('pointerdown', e => this._down(e));
      r.getElementById('btnClose').addEventListener('click', e => { e.stopPropagation(); this.close(); });
      r.getElementById('btnPrev').addEventListener('click', e => { e.stopPropagation(); this._emit('prev'); });
      r.getElementById('btnNext').addEventListener('click', e => { e.stopPropagation(); this._emit('next'); });
      r.getElementById('btnPlay').addEventListener('click', e => { e.stopPropagation(); this.playing = !this.state.playing; this._emit(this.state.playing ? 'play' : 'pause'); });
      this.$cardCover.addEventListener('click', e => {
        if (this.state.mode !== 'card') return;
        e.stopPropagation();
        this._emit('pickersong');
      });
      r.getElementById('track').addEventListener('pointerdown', e => {
        e.stopPropagation();
        const b = e.currentTarget.getBoundingClientRect();
        this._emit('seek', { ratio: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) });
      });
      this._onResize = () => this._clamp();
      window.addEventListener('resize', this._onResize);
      this._render();
    }

    disconnectedCallback() {
      window.removeEventListener('resize', this._onResize);
      cancelAnimationFrame(this._raf);
    }

    attributeChangedCallback(n, o, v) {
      if (n === 'playing') { this.playing = v !== null && v !== 'false'; return; }
      /* ★ 安全区变了。唱片态的位置**不会**自己回到界内 —— _render 里 cd 那一支用的是
         s.y 原值，只有 resize 和松手才夹一次。不夹的话，输入框一显示，
         豆子就正好压在发送键上（实测到的）。 */
      if (this.$root) { this._clamp(); this._render(); }
    }

    /* ─── 对外 API ─── */
    setTrack(t) { Object.assign(this.track, t || {}); this._render(); }
    setLyrics(l) { this.lyrics = (l && l.length) ? l.slice().sort((a, b) => a.t - b.t) : [{ t: 0, text: '' }]; this._render(); }
    setProgress(sec) {
      this.pos = sec || 0;
      this._ratio = this.track.duration ? Math.max(0, Math.min(1, this.pos / this.track.duration)) : 0;
      this._render();
    }
    set playing(v) { this.state.playing = !!v; this._render(); }
    get playing() { return this.state.playing; }
    get mode() { return this.state.mode; }

    open() {
      this.state.closed = false;
      this.state.mode = 'cd';
      this.state.p = 0; this.state.dx = 0; this.state.hold = 0;
      this.state.x = this.state.side === 'left' ? this._minX() : this._maxX();
      this._save(); this._render(); this._emit('opened');
    }
    close() {
      this.state.closed = true; this.state.mode = 'cd'; this.state.p = 0; this.state.hold = 0;
      this._save(); this._render(); this._emit('closed');
    }
    expand() { this.state.mode = 'card'; this.state.p = 1; this._render(); this._emit('modechange', { mode: 'card' }); }
    collapse() {
      const m = this.state.mode === 'card' ? 'lyric' : 'cd';
      this.state.mode = m; this.state.p = 0;
      this.state.x = this.state.side === 'left' ? this._minX() : this._maxX();
      this._save(); this._render(); this._emit('modechange', { mode: m });
    }

    /* ─── 手势 ─── */
    _down(e) {
      if (e.target.closest('button') || e.target.closest('#track')) return;
      const s = this.state;
      const grip = !!e.target.closest('#grip');
      this.$box.setPointerCapture(e.pointerId);
      this.d = { sx: e.clientX, sy: e.clientY, x0: s.x, y0: s.y, p0: s.p, grip, axis: null, moved: false, lastDx: 0 };
      s.drag = true;

      // 长按：环从当前进度往满走，填满才真停播（中途松手＝反悔）
      if (!grip) {
        const t0 = performance.now();
        this._holding = true;
        const tick = () => {
          if (!this._holding) return;
          const p = Math.min(1, (performance.now() - t0) / 780);
          this.state.hold = p; this._render();
          if (p >= 1) { this._holding = false; this._fired = true; this.state.hold = 0; this.close(); }
          else this._raf = requestAnimationFrame(tick);
        };
        this._raf = requestAnimationFrame(tick);
      }

      const mv = ev => {
        if (!this.d) return;
        const dx = ev.clientX - this.d.sx, dy = ev.clientY - this.d.sy;
        this.d.lastDx = dx;
        if (this.d.grip) {                          // 把手：只挪位子
          this.d.moved = true;
          this.state.y = this._clampY(this.d.y0 + dy);
          this.state.x = Math.max(this._minX(), Math.min(this._maxX(), this.d.x0 + dx));
          return this._render();
        }
        if (!this.d.moved && Math.abs(dx) + Math.abs(dy) > 5) {
          this.d.moved = true; this._holding = false; this.state.hold = 0;
          this.d.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        }
        if (!this.d.moved) return;
        if (this.state.mode === 'cd') {
          this.state.x = Math.max(this._minX(), Math.min(this._maxX(), this.d.x0 + dx));
          this.state.y = this._clampY(this.d.y0 + dy);
        } else if (this.d.axis === 'x') {
          this.state.dx = dx;                       // 跟手切歌
        } else {
          this.state.p = Math.max(-1, Math.min(1, this.d.p0 + dy / 140));
        }
        this._render();
      };

      const up = () => {
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        this._holding = false;
        if (!this.d) return;
        const s2 = this.state, d = this.d;
        this.d = null; s2.drag = false;

        if (this._fired) { this._fired = false; return this._render(); }
        if (d.grip) { this._snapSide(); return; }

        if (!d.moved) {                              // 点一下：换一档，回原本那条边
          s2.mode = s2.mode === 'cd' ? 'lyric' : (s2.mode === 'lyric' ? 'cd' : 'lyric');
          s2.p = 0; s2.dx = 0; s2.hold = 0;
          if (s2.mode === 'cd') s2.x = s2.side === 'left' ? this._minX() : this._maxX();
          this._save(); this._render();
          return this._emit('modechange', { mode: s2.mode });
        }
        if (s2.mode === 'cd') return this._snapSide();

        if (d.axis === 'x') {                        // 轻滑即切歌（34px）
          if (Math.abs(s2.dx) > 34) {
            const dir = s2.dx > 0 ? -1 : 1;
            s2.dx = s2.dx > 0 ? 210 : -210; this._render();
            setTimeout(() => { s2.dx = 0; this._render(); this._emit(dir > 0 ? 'next' : 'prev'); }, 150);
          } else { s2.dx = 0; this._render(); }
          return;
        }
        const p = s2.p;                              // 上下：逐档
        if (s2.mode === 'card') { s2.mode = p < 0.5 ? 'lyric' : 'card'; s2.p = p < 0.5 ? 0 : 1; }
        else if (p > 0.45) { s2.mode = 'card'; s2.p = 1; }
        else if (p < -0.45) {                        // 上推带方向 → 停那一边
          s2.mode = 'cd'; s2.p = 0; s2.dx = 0;
          s2.side = d.lastDx < -24 ? 'left' : (d.lastDx > 24 ? 'right' : s2.side);
          s2.x = s2.side === 'left' ? this._minX() : this._maxX();
        } else s2.p = 0;
        this._clamp(); this._save(); this._render();
        this._emit('modechange', { mode: s2.mode });
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
      /* ★ 0906 修的一个真 bug：原来只挂 pointerup。iOS 上系统手势（边缘返回、
         通知中心下拉、来电）会直接发 pointercancel 而**没有** pointerup ——
         那样 up() 永远不跑，_holding 一直是 true，780ms 那个 rAF 环照样走满，
         走满就调 close()：播放器自己关掉并停播，人还找不回来。
         这正是这个组件要治的那个病，不能自己再犯一次。 */
      window.addEventListener('pointercancel', up);
      this._render();
    }

    /* ─── 几何 ─── */
    _vw() { return this.offsetWidth || window.innerWidth; }
    _vh() { return this.offsetHeight || window.innerHeight; }
    _pad() { return +(this.getAttribute('edge-pad') || 12); }
    _minX() { return 0; }
    _maxX() { return this._vw() - this._pad() * 2 - 50; }
    _h() { const s = this.state; return s.mode === 'cd' ? H.cd : H.lyric + Math.max(0, s.p) * (H.card - H.lyric); }
    _clampY(y) { return Math.max(this._safeTop(), Math.min(this._vh() - this._safeBottom() - this._h(), y)); }
    _safeTop() { return +(this.getAttribute('safe-top') || 96); }
    _safeBottom() { return +(this.getAttribute('safe-bottom') || 150); }
    _clamp() { this.state.y = this._clampY(this.state.y); }
    _snapSide() {
      const s = this.state, mid = this._vw() / 2;
      s.side = s.x + 25 < mid ? 'left' : 'right';
      if (s.mode === 'cd') s.x = s.side === 'left' ? this._minX() : this._maxX();
      this._clamp(); this._save(); this._render();
    }

    /* ─── 存取 ─── */
    _load() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } }
    _save() {
      const s = this.state;
      try { localStorage.setItem(LS, JSON.stringify({ x: s.x, y: s.y, side: s.side, mode: s.mode })); } catch (e) {}
    }
    _emit(n, d) { this.dispatchEvent(new CustomEvent('miniplayer:' + n, { detail: d || {}, bubbles: true, composed: true })); }

    _line() {
      let cur = this.lyrics[0] || { text: '' };
      for (const l of this.lyrics) { if (l.t <= this.pos) cur = l; else break; }
      return cur.text || '';
    }

    /* ★ 0907 · 当前这一句的起止。
       原来那道高亮是 `animation:mpkara 4.2s linear infinite` —— 4.2 秒是写死的，
       **跟这句词多长、唱到哪儿毫无关系，只是在匀速刷**：短句会「唱」得比长句慢。
       跟那张一直在转的碟是同一种病：
       看着像状态指示，实际不读状态。而数据一直就在手上 —— setLyrics 收的 [{t,text}]。 */
    _lineSpan() {
      const L = this.lyrics || [];
      let i = -1;
      for (let k = 0; k < L.length; k++) { if (L[k].t <= this.pos) i = k; else break; }
      if (i < 0) return null;
      const start = L[i].t || 0;
      const end = (i + 1 < L.length) ? L[i + 1].t
                : (this.track.duration || (start + 4));    /* 最后一句唱到歌尾 */
      return { i, start, dur: Math.max(0.4, end - start) };
    }

    /* ─── 渲染（只改 style/text，不重建 DOM，动画不断） ─── */
    _render() {
      if (!this.$root) return;
      const s = this.state, cd = s.mode === 'cd';
      const ze = Math.max(0, s.p), zt = Math.max(0, -s.p);
      const h = this._h();
      const y = cd ? s.y : Math.max(this._safeTop(), Math.min(this._vh() - this._safeBottom() - h, s.y));
      const barW = this._vw() - 24;
      const tr = s.drag ? 'none'
        : `transform .46s ${SPRING}, width .46s ${SPRING}, height .44s ${SPRING}, border-radius .3s ease, opacity .26s ease`;

      this.$root.style.display = s.closed ? 'none' : 'block';
      this.$root.style.transform = `translate(${cd ? s.x : 0}px, ${y}px)`;
      this.$root.style.transition = tr;

      this.$box.style.width = (cd ? 50 : Math.round(barW - zt * (barW - 50))) + 'px';
      this.$box.style.height = Math.round(h) + 'px';
      /* 0906：原来这儿每帧写死 25/18~25px。展开态的圆角交给 CSS 的 var(--r)，
         这样换皮自己跟上；唱片态仍要正圆，用百分比而不是写死的 25px。 */
      this.$box.style.borderRadius = cd ? '50%' : '';
      this.$box.style.transform = `translateX(${cd ? 0 : s.dx}px)`;
      this.$box.style.transition = tr;
      this.$box.style.cursor = s.drag ? 'grabbing' : 'pointer';

      const ring = s.hold > 0.02 ? s.hold : this._ratio;
      this.$ring.style.background = `conic-gradient(var(--mp-accent) ${(ring * 100).toFixed(1)}%, var(--mp-track) 0)`;
      this.$cover.style.animationPlayState = s.playing ? 'running' : 'paused';
      /* 0906：波纹跟着播放状态走 —— 暂停了还在跳，看着像在放，是假信号 */
      this.shadowRoot.getElementById('wave').classList.toggle('paused', !s.playing);
      if (this.track.cover) {
        this.$cover.style.backgroundImage = `url("${this.track.cover}")`;
        this.$cardCover.style.backgroundImage = `url("${this.track.cover}")`;
      }

      const lop = cd ? 0 : Math.max(0, (1 - zt * 1.5) * (1 - Math.abs(s.dx) / 120));
      const line = this._line();
      this.$lyric.textContent = line; this.$lyricHi.textContent = line;
      /* ★ 0907 · 让那道高亮真的跟着这一句走。
         ★ 只在**换句**时重设动画（_render 每 250ms 就来一次，每次重设等于永远从头播）。
         ★ 用负的 animation-delay 跳到这句已经唱掉的那一段 ——
           这样就算中途拖进度条、或者刚开页，也是对齐的。
         ★ 播放/暂停靠 animation-play-state，不重设动画，暂停在哪儿就停在哪儿。 */
      const span = this._lineSpan();
      const hi = this.$lyricHi;
      if (!span || !line) {
        hi.style.animation = 'none';
      } else {
        if (this._karaLine !== span.i || this._karaDur !== span.dur) {
          this._karaLine = span.i; this._karaDur = span.dur;
          const been = Math.max(0, this.pos - span.start);
          hi.style.animation = 'none';
          void hi.offsetWidth;                       /* 强制重排，不然同一个动画不会重新起跑 */
          hi.style.animation = `mpkara ${span.dur}s linear -${been}s 1 forwards`;
        }
        hi.style.animationPlayState = s.playing ? 'running' : 'paused';
      }
      this.shadowRoot.querySelectorAll('[data-fade]').forEach(el => { el.style.opacity = lop; });

      const cop = Math.max(0, Math.min(1, (ze - 0.12) / 0.5));
      const card = this.shadowRoot.getElementById('card');
      card.style.opacity = cop;
      card.style.transform = `translateY(${Math.round((1 - ze) * 18)}px)`;
      card.style.pointerEvents = cop > 0.6 ? 'auto' : 'none';
      this.$title.textContent = `${this.track.title} · ${this.track.artist}`;
      this.$meta.textContent = `${fmt(this.pos)} / ${fmt(this.track.duration)}`;
      this.$bar.style.width = (this._ratio * 100).toFixed(1) + '%';

      // 泡泡键：上半屏往下浮，下半屏往上浮
      const down = y < this._vh() / 2;
      this.$bubbles.style.display = (!cd && ze > 0.02) ? 'flex' : 'none';
      this.$bubbles.style.opacity = cop;
      this.$bubbles.style.top = down ? '100%' : 'auto';
      this.$bubbles.style.bottom = down ? 'auto' : '100%';
      this.$bubbles.style.margin = down ? '12px 0 0' : '0 0 12px';
      this.$bubbles.style.transform = `translateY(${Math.round((1 - ze) * (down ? -14 : 14))}px)`;
      this.$bubbles.style.transition = tr;
      this.shadowRoot.getElementById('iconPlay').innerHTML = s.playing ? ICON.pause : ICON.play;

      /* ★ 0906：把那行说明书去掉 —— 拖动挪位子、切歌这类提示词都不要。
         ★ 只留**拖动过程中**那一句 —— 那不是说明书，是「你现在松手会发生什么」的实时反馈，
           属于 Motion Spec 说的 feedback，手一松就没。平时一个字不显示。 */
      this.$hint.style.display = (s.drag && !cd && ze < 0.1) ? 'block' : 'none';
      this.$hint.textContent = s.drag
        ? (ze > 0.45 ? '松手展开详情' : (zt > 0.45 ? '松手收成唱片' : '往下拉出详情'))
        : '';
    }

    _html() {
      return `
<div id="root">
  <div id="box">
    <div id="head">
      <div id="ring"><div id="cover"></div></div>
      <div id="lyricWrap" data-fade><div id="lyric"></div><div id="lyricHi"></div></div>
      <div id="wave" data-fade><i></i><i></i><i></i></div>
      <div id="grip" data-fade title="拖我挪位子"><b></b><b></b></div>
    </div>
    <div id="card">
      <div id="cardRow">
        <div id="cardCover"></div>
        <div id="cardText"><div id="title"></div><div id="meta"></div></div>
        <button id="btnClose" title="关掉（停播）">${ICON.close}</button>
      </div>
      <div id="track"><div id="bar"></div></div>
    </div>
  </div>
  <div id="bubbles">
    <button id="btnPrev" class="bub" title="上一首">${ICON.prev}</button>
    <button id="btnPlay" class="bub main"><span id="iconPlay">${ICON.play}</span></button>
    <button id="btnNext" class="bub" title="下一首">${ICON.next}</button>
  </div>
  <div id="hint"></div>
</div>`;
    }

    _css() {
      return `<style>
/* ★ 0906 接进连环，这一段改了四件事：
   ① position:fixed → absolute。连环宽屏时整个 app 是一条 max-width:440 的框
      （.app），fixed 会让歌条飘到框外面去。挂到 .app 上用 absolute 才待在框里。
   ② z-index 60 → 11。60 是 .callscreen（打电话那一屏）占着的，撞上就会有条歌
      漂在脸上。11 的位置：底栏 10 之上、popmenu 12 之下。
   ③ 删掉 font-family。仓库里 0 处用 Noto Sans SC，继承宿主那串就对了。
   ④ 七个写死的颜色换成连环的 token。★ 只换这七行的值，组件内部引用 --mp-*
      的地方一个字都不用改 —— 自定义属性会穿透 Shadow DOM 继承下来，
      于是暗色、三套皮、用户换的 12 个重点色，全都自动跟上。
      括号里留着原值当兜底：组件单独跑（demo.html）时长相跟交接时一模一样。 */
:host{position:absolute;inset:0;pointer-events:none;z-index:11;
  --mp-surface:var(--card,#fff); --mp-ink:var(--ink,#33302c); --mp-sub:var(--sub,#6b645e);
  --mp-accent:var(--maple,#a85434); --mp-track:var(--line,#e3dad2);
  --mp-tint:var(--maple-soft,#ecd5c9); --mp-line:var(--line,#eee6de);
  --mp-shadow:var(--shadow-lift, 0 8px 26px rgba(120,86,64,.2))}
#root{position:absolute;top:0;left:12px;pointer-events:none}
#box,#bubbles,#hint{pointer-events:auto}
/* 圆角交给 CSS（跟着 --r 走：纸皮 16、性冷淡 5、苹果 14）；
   唱片态那个正圆由 JS 覆盖成 50%，见 _render()。
   ★ -webkit-touch-callout / user-select：不关掉的话 iOS 长按会弹选择放大镜，
     还会顺手发一个 pointercancel 把长按打断。 */
#box{background:var(--mp-surface);box-shadow:var(--mp-shadow);overflow:hidden;box-sizing:border-box;
  touch-action:none;border-radius:var(--r,18px);
  -webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
#head{display:flex;align-items:center;gap:10px;height:42px;padding:0 8px 0 5px;box-sizing:border-box}
/* ★ 0907：豆子外面那层白圈，跟唱片圆不居中。
   那圈是进度环（下面 _render 里的 conic-gradient），本身是同心的 ——
   歪的是 padding 那个**半像素**（2.5px）：3x 屏上是 7.5 物理像素，
   左右各舍一次就成了 2 和 3，唱片整个偏一边。改成整数就正了。 */
#ring{width:40px;height:40px;border-radius:50%;padding:3px;box-sizing:border-box;flex:none}
/* 没有封面时的底：原来是写死的暖褐渐变，换成重点色的深浅两档，跟着用户换的色走 */
#cover{width:100%;height:100%;border-radius:50%;animation:mpspin 14s linear infinite;
  background:linear-gradient(135deg,var(--mp-tint),var(--mp-accent)) center/cover}
#lyricWrap{flex:1;min-width:0;position:relative;white-space:nowrap;overflow:hidden;height:18px}
#lyric{font-size:12.5px;line-height:18px;color:var(--mp-sub)}
/* ★ 0907：这儿原来写死了 mpkara 4.2s linear infinite —— 跟真歌词无关。
   现在动画由 _render 按当前这句的起止时间现设（见 _lineSpan），这儿只留初始的裁切。 */
#lyricHi{position:absolute;left:0;top:0;font-size:12.5px;line-height:18px;color:var(--mp-accent);clip-path:inset(0 100% 0 0)}
#wave{display:flex;align-items:flex-end;gap:2px;height:12px;flex:none}
/* ★ 0906 傍晚我按 DESIGN §12.2「装饰不上重点色」把这三根改成了次级色，
   后来发现它是会动的、像音频频谱那样 —— 要看得见。改回重点色。
   ★ 这不算破规矩：它不是纯装饰，是「正在放」的状态指示，
     跟播放/暂停一样属于 state indication。而且只有三根 2px 的线，不占版面。 */
#wave i{width:2px;height:12px;border-radius:1px;background:var(--mp-accent);animation:mpwave 1s ease-in-out infinite}
/* 暂停的时候别装作在放 —— 停在半高不动 */
#wave.paused i{animation-play-state:paused}
/* DESIGN §12.2：装饰不上重点色，整页拿重点色做底的地方要 ≤2 处。
   三根小波纹是装饰，原来一根重点色两根写死的暖褐 —— 全部改成次级字色。 */
#wave i:nth-child(2){animation-delay:.16s}
#wave i:nth-child(3){animation-delay:.32s}
#grip{width:34px;height:36px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;flex:none;cursor:grab;position:relative}
#grip::after{content:'';position:absolute;top:50%;left:50%;width:44px;height:44px;transform:translate(-50%,-50%)}
#grip b{width:22px;height:2.5px;border-radius:2px;background:var(--mp-line)}
#card{padding:4px 14px 14px;display:flex;flex-direction:column;gap:12px}
#cardRow{display:flex;align-items:center;gap:12px}
#cardCover{width:56px;height:56px;border-radius:var(--r,14px);flex:none;cursor:pointer;
  background:linear-gradient(135deg,var(--mp-tint),var(--mp-accent)) center/cover}
#cardText{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
#title{font-size:15px;font-weight:600;color:var(--mp-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#meta{font-size:12px;color:var(--mp-sub)}
#track{height:4px;border-radius:2px;background:var(--mp-track);cursor:pointer}
#bar{height:4px;border-radius:2px;background:var(--mp-accent);transition:width .2s linear}
/* 看着 30，手指点的是 44 —— 全家都是这么干的（.qbar .qx、书房那条引用条） */
#btnClose{width:30px;height:30px;border-radius:50%;border:1px solid var(--mp-line);background:transparent;color:var(--mp-sub);display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;position:relative}
#btnClose::after{content:'';position:absolute;top:50%;left:50%;width:44px;height:44px;transform:translate(-50%,-50%)}
#btnClose:hover{border-color:var(--mp-tint);color:var(--mp-accent)}
#bubbles{position:absolute;left:0;right:0;display:flex;justify-content:center;gap:16px}
.bub{width:44px;height:44px;border-radius:50%;border:0;background:var(--mp-surface);color:var(--mp-sub);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:var(--mp-shadow)}
.bub:hover{color:var(--mp-accent)}
/* 浅底配重点色的字。★ 不能用 --on-maple —— 那个是给「重点色**实底**」上的字准备的，
   这里底是 --maple-soft（浅），配深色的重点色本身才对。 */
.bub.main{width:52px;height:52px;background:var(--mp-tint);color:var(--mp-accent);box-shadow:var(--mp-shadow)}
/* 小标签的规格全家统一：10.5px / var(--sub) / letter-spacing .17em（DESIGN 定的） */
#hint{margin-top:8px;text-align:center;font-size:10.5px;color:var(--mp-sub);letter-spacing:.17em}
button:focus-visible,#grip:focus-visible{outline:2px solid var(--mp-accent);outline-offset:2px}
@keyframes mpspin{to{transform:rotate(360deg)}}
@keyframes mpkara{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}   /* 0907：92% 那个折点是配合写死 4.2s 的，现在时长是真的，匀速到底 */
@keyframes mpwave{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
/* ★ README 里说 reduced-motion「已内置」，其实只关了三个 keyframes ——
   真正晃眼的是 .46s 的形变过渡，那个还在跑。这儿一起降到 0。 */
@media (prefers-reduced-motion:reduce){
  #cover,#lyricHi,#wave i{animation:none}
  #root,#box,#bubbles{transition-duration:.01ms !important}
}
</style>`;
    }
  }

  const ICON = {
    play: '<svg width="19" height="19" viewBox="0 0 16 16"><path d="M5 2.5l8 5.5-8 5.5z" fill="currentColor"/></svg>',
    pause: '<svg width="19" height="19" viewBox="0 0 16 16"><rect x="4.6" y="3" width="2.6" height="10" rx="1.1" fill="currentColor"/><rect x="9" y="3" width="2.6" height="10" rx="1.1" fill="currentColor"/></svg>',
    prev: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M13 3l-7 5 7 5z" fill="currentColor"/><rect x="3" y="3" width="1.6" height="10" fill="currentColor"/></svg>',
    next: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 3l7 5-7 5z" fill="currentColor"/><rect x="11.4" y="3" width="1.6" height="10" fill="currentColor"/></svg>',
    close: '<svg width="12" height="12" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  };
  const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  if (!customElements.get('mini-player')) customElements.define('mini-player', MiniPlayer);
})();
