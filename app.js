/* =========================================================
 * UTAGE — YouTubeカラオケ  フロントエンド (app.js)
 *  ※ GAS_URL は config.js、画面バージョンは index.html の meta で管理
 * ========================================================= */
'use strict';

// GAS_URL などの環境設定は config.js（window.APP_CONFIG）で管理
const CONFIG = Object.assign({
  GAS_URL: '',
  STORAGE_KEY: 'utage_session_v1',
  PREF_KEY: 'utage_prefs_v1',
  HOWL_KEY: 'utage_howl_ok',
  AI_TIMEOUT_MS: 25000,
  VOICE_THRESHOLD: 0.02,
}, window.APP_CONFIG || {});

// 画面側のバージョンは index.html の <meta name="app-version"> から読む
const VERSION_META = document.querySelector('meta[name="app-version"]');
const APP_VERSION = VERSION_META?.content || '不明';
const APP_UPDATED = VERSION_META?.dataset.updated || '';

const CHARACTERS = {
  mama: { name: 'スナックのママ・百合子', avatar: '💄', pitch: 0.75, rate: 0.92,
    welcome: 'いらっしゃい。今夜は何を歌うの？ゆっくりしていってちょうだいね。' },
  dj:   { name: '熱血ライブDJ・ジョー', avatar: '🎧', pitch: 1.35, rate: 1.3,
    welcome: 'Yeah!! ようこそUTAGEへ！今夜もボルテージ上げていこうぜ！' },
  pro:  { name: '辛口AIプロデューサー・K-01', avatar: '🎛️', pitch: 1.0, rate: 1.08,
    welcome: 'ログインを確認しました。本日の目標は85点以上です。' },
};

// 通信失敗・タイムアウト時に使うセリフ
const FALLBACK = {
  mama: {
    intro: 'あら、いい選曲ねぇ。肩の力を抜いて、気持ちよく歌ってちょうだい。',
    interlude: 'いいわよぉ、その調子！',
    outro: 'お疲れさま。あなたの歌、ちゃんと心に届いたわよ。',
    outroNoMic: '聴かせてもらったわ。次はマイクを入れて歌ってみて？',
    chat: '今夜はゆっくりしていってね。',
  },
  dj: {
    intro: 'Yeah!! 神曲キター！最初から全開でぶっ飛ばしていこうぜ！',
    interlude: 'まだまだイケるぜ！',
    outro: '最高だったぜ！このまま次の曲もアゲていこう！',
    outroNoMic: 'いい曲だったな！次はマイクONで声を聞かせてくれよ！',
    chat: 'テンション上げていこうぜ！',
  },
  pro: {
    intro: '準備はいいですか。リズムのキープを意識してください。',
    interlude: 'テンポ、維持できています。',
    outro: 'お疲れさまでした。次はブレスの位置を意識しましょう。',
    outroNoMic: '採点にはマイクが必要です。次はマイクをONにしてください。',
    chat: '練習を始めましょう。',
  },
};

const PRESETS = {
  bath:    { time: 0.10, feedback: 0.30, echoMix: 0.35, reverbMix: 0.65, reverbSec: 1.3, tone: 5200 },
  room:    { time: 0.20, feedback: 0.38, echoMix: 0.45, reverbMix: 0.30, reverbSec: 1.6, tone: 3800 },
  stadium: { time: 0.38, feedback: 0.52, echoMix: 0.50, reverbMix: 0.55, reverbSec: 3.8, tone: 2600 },
  off:     { time: 0.20, feedback: 0.00, echoMix: 0.00, reverbMix: 0.00, reverbSec: 1.0, tone: 6000 },
};

const TRIGGER_WORDS = /(行こう|いこう|イコウ|いこー|行こー)/;
const YT_STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 };

const state = {
  token: null,
  profile: null,
  character: 'mama',
  ttsMode: 'gemini',
  musicVol: 80,
  preset: 'room',
  favorites: [],
  favFilter: 'all',
  searchResults: [],
  aiResults: [],
  resultMode: 'none',  // 'youtube' | 'ai'
  aiCondition: '',
  dictating: false,
  dictRecog: null,
  suggestions: [],
  song: null,          // {videoId,title,artist,keyShift,memo,favId}
  player: null,
  playerReady: false,
  playerState: -1,
  pendingVideo: null,
  session: null,       // 1曲ぶんの歌唱記録
  prefetch: {},
  seeking: false,
  listening: false,
  recog: null,
  recogRunning: false,
  busyOuting: false,
  lastTrigger: 0,
  telopTimer: null,
  keySaveTimer: null,
};

/* ---------------------------------------------------------
 * ユーティリティ
 * ------------------------------------------------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function fmtKey(k) {
  k = Number(k) || 0;
  return k === 0 ? '原曲キー' : (k > 0 ? `+${k}` : `−${Math.abs(k)}`);
}
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('時間切れです')), ms))]);
}
function toast(msg, type = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.dataset.type = type;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, type === 'error' ? 5200 : 3200);
}
function parseYouTubeId(s) {
  const m = String(s).match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}
function setBusy(form, busy, label) {
  const btn = form.querySelector('[type="submit"]');
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.textContent; btn.textContent = label || '処理中…'; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ---------------------------------------------------------
 * API
 * ------------------------------------------------------- */
async function api(action, payload = {}) {
  if (!isGasConfigured()) throw new Error('config.js の GAS_URL を設定してください');
  let res;
  try {
    res = await fetch(CONFIG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: state.token, ...payload }),
    });
  } catch {
    throw new Error('サーバーに接続できません。通信環境を確認してください');
  }
  let data;
  try { data = await res.json(); } catch { throw new Error('サーバーの応答を読み取れません'); }
  if (!data.ok) {
    if (data.code === 'SESSION_EXPIRED') forceLogout(data.error);
    const e = new Error(data.error || 'エラーが発生しました');
    e.code = data.code;
    throw e;
  }
  return data;
}

function isGasConfigured() {
  return !!CONFIG.GAS_URL && !CONFIG.GAS_URL.includes('XXXX') && /^https:\/\/script\.google\.com\//.test(CONFIG.GAS_URL);
}

/* ---------------------------------------------------------
 * バージョン情報
 * ------------------------------------------------------- */
const versionInfo = { server: null, serverUpdated: '', error: '' };

function renderVersion() {
  const front = `画面 v${APP_VERSION}${APP_UPDATED ? `（${APP_UPDATED}）` : ''}`;
  let server;
  if (versionInfo.server) server = `サーバー v${versionInfo.server}${versionInfo.serverUpdated ? `（${versionInfo.serverUpdated}）` : ''}`;
  else if (versionInfo.error) server = `サーバー：${versionInfo.error}`;
  else server = 'サーバー：確認中…';

  let warn = '';
  const minor = v => String(v).split('.').slice(0, 2).join('.');
  if (versionInfo.server && minor(versionInfo.server) !== minor(APP_VERSION)) {
    warn = `<span class="ver-warn">画面とサーバーのバージョンが違います。GASを「新バージョン」で再デプロイしたか、ブラウザの再読み込みで最新の画面になっているか確認してください。</span>`;
  }
  $$('[data-version]').forEach(el => {
    el.innerHTML = `UTAGE　${esc(front)}　／　${esc(server)}${warn}`;
  });
}

async function loadVersion() {
  renderVersion();
  if (!isGasConfigured()) {
    versionInfo.error = 'config.js の GAS_URL が未設定です';
    renderVersion();
    return;
  }
  try {
    const r = await withTimeout(api('version'), 15000);
    versionInfo.server = r.version;
    versionInfo.serverUpdated = r.updated || '';
  } catch (err) {
    versionInfo.error = '接続できません';
    console.warn('version', err);
  }
  renderVersion();
}

/* ---------------------------------------------------------
 * 設定の保存
 * ------------------------------------------------------- */
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(CONFIG.PREF_KEY)) || {}; } catch { return {}; }
}
let prefsTimer = null;
function savePrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    localStorage.setItem(CONFIG.PREF_KEY, JSON.stringify({
      ttsMode: state.ttsMode, musicVol: state.musicVol, preset: state.preset, fx: MicFx.p,
      goEra: $('#sel-go-era')?.value || '', goVocal: $('#sel-go-vocal')?.value || '',
    }));
  }, 300);
}

/* ---------------------------------------------------------
 * 認証
 * ------------------------------------------------------- */
const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

function setupPwToggles() {
  $$('.pw-toggle').forEach(btn => {
    btn.innerHTML = EYE;
    btn.addEventListener('click', () => {
      const inp = btn.parentElement.querySelector('input');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.innerHTML = show ? EYE_OFF : EYE;
      btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
    });
  });
}

function showAuth(viewId) {
  $('#auth').hidden = false;
  $('#app').hidden = true;
  $$('.view').forEach(v => { v.hidden = v.id !== viewId; });
  const first = $(`#${viewId} input`);
  if (first) setTimeout(() => first.focus(), 50);
}

function saveSession() {
  localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({ token: state.token, profile: state.profile }));
}
function clearSession() {
  localStorage.removeItem(CONFIG.STORAGE_KEY);
  state.token = null;
  state.profile = null;
}

function forceLogout(msg) {
  stopEverything();
  clearSession();
  showAuth('view-login');
  if (msg) toast(msg, 'error');
}

function stopEverything() {
  Voice.stop();
  if (MicFx.enabled) MicFx.disable();
  setListening(false);
  if (state.playerReady) { try { state.player.stopVideo(); } catch {} }
  state.session = null;
}

function bindAuth() {
  $$('[data-go]').forEach(b => b.addEventListener('click', () => showAuth(b.dataset.go)));

  $('#form-login').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const email = f.email.value.trim();
    const password = f.password.value;
    if (!email || !password) return toast('メールアドレスとパスワードを入力してください', 'error');
    setBusy(f, true, 'ログイン中…');
    try {
      const r = await api('login', { email, password });
      state.token = r.token;
      state.profile = r.profile;
      saveSession();
      f.password.value = '';
      if (r.mustReset) { showAuth('view-reset'); toast('新しいパスワードを設定してください'); }
      else enterApp();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(f, false);
    }
  });

  $('#form-register').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const email = f.email.value.trim();
    const nickname = f.nickname.value.trim();
    if (!nickname || !email) return toast('ニックネームとメールアドレスを入力してください', 'error');
    setBusy(f, true, '送信中…');
    try {
      const r = await api('register', { email, nickname });
      toast(r.message);
      showAuth('view-login');
      $('#form-login').email.value = email;
      $('#form-login').password.focus();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(f, false);
    }
  });

  $('#form-forgot').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const email = f.email.value.trim();
    if (!email) return toast('メールアドレスを入力してください', 'error');
    setBusy(f, true, '送信中…');
    try {
      const r = await api('forgotPassword', { email });
      toast(r.message);
      showAuth('view-login');
      $('#form-login').email.value = email;
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(f, false);
    }
  });

  $('#form-reset').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const pw1 = f.pw1.value, pw2 = f.pw2.value;
    if (pw1 !== pw2) return toast('2つのパスワードが一致しません', 'error');
    if (pw1.length < 8 || !/[A-Za-z]/.test(pw1) || !/\d/.test(pw1)) {
      return toast('英字と数字を含む8文字以上にしてください', 'error');
    }
    setBusy(f, true, '設定中…');
    try {
      const r = await api('setPassword', { newPassword: pw1 });
      state.profile = r.profile;
      saveSession();
      f.reset();
      toast('パスワードを設定しました');
      enterApp();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(f, false);
    }
  });

  $('#btn-reset-cancel').addEventListener('click', logout);
}

async function logout() {
  try { if (state.token) await api('logout'); } catch {}
  stopEverything();
  clearSession();
  showAuth('view-login');
}

function enterApp() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#nick').textContent = state.profile?.nickname ? `${state.profile.nickname} さん` : '';
  state.character = state.profile?.character || 'mama';
  $('#sel-character').value = state.character;
  renderCharacter();
  showLine(CHARACTERS[state.character].welcome);
  loadFavorites();
}

/* ---------------------------------------------------------
 * AudioContext（全体で1つ）
 * ------------------------------------------------------- */
const AC = {
  ctx: null,
  get() {
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      this.ctx = new C({ latencyHint: 'interactive' });
    }
    return this.ctx;
  },
  async resume() {
    const c = this.get();
    if (c.state === 'suspended') await c.resume();
    return c;
  },
};

function makeImpulse(ctx, seconds, decay = 2.4) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

/* ---------------------------------------------------------
 * マイク・エコー（Web Audio API）
 *  mic → HPF → 音量 ┬→ ドライ ───────────────┐
 *                   ├→ Delay ⇄ (LPF→Feedback) → エコー量 ┤→ マスター → リミッター → スピーカー
 *                   ├→ Convolver(残響) → 残響量 ──┘
 *                   └→ Analyser（メーター・採点）
 * ------------------------------------------------------- */
const MicFx = {
  enabled: false,
  stream: null,
  n: null,
  p: { micVol: 1.0, time: 0.20, feedback: 0.38, echoMix: 0.45, reverbMix: 0.30, reverbSec: 1.6, tone: 3800 },
  _tbuf: null,
  _fbuf: null,

  async enable() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザはマイク入力に対応していません');
    const ctx = await AC.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const n = {};
    n.src = ctx.createMediaStreamSource(this.stream);
    n.hp = ctx.createBiquadFilter(); n.hp.type = 'highpass'; n.hp.frequency.value = 100;
    n.mic = ctx.createGain();
    n.analyser = ctx.createAnalyser(); n.analyser.fftSize = 1024; n.analyser.smoothingTimeConstant = 0.6;
    n.dry = ctx.createGain(); n.dry.gain.value = 1;
    n.delay = ctx.createDelay(1.0);
    n.fbFilter = ctx.createBiquadFilter(); n.fbFilter.type = 'lowpass';
    n.fb = ctx.createGain();
    n.echoWet = ctx.createGain();
    n.conv = ctx.createConvolver();
    n.revWet = ctx.createGain();
    n.master = ctx.createGain();
    n.limiter = ctx.createDynamicsCompressor();
    n.limiter.threshold.value = -6; n.limiter.knee.value = 0; n.limiter.ratio.value = 20;
    n.limiter.attack.value = 0.003; n.limiter.release.value = 0.1;

    n.src.connect(n.hp).connect(n.mic);
    n.mic.connect(n.analyser);
    n.mic.connect(n.dry).connect(n.master);
    n.mic.connect(n.delay);
    n.delay.connect(n.fbFilter);
    n.fbFilter.connect(n.fb);
    n.fb.connect(n.delay);
    n.fbFilter.connect(n.echoWet).connect(n.master);
    n.mic.connect(n.conv);
    n.conv.connect(n.revWet).connect(n.master);
    n.master.connect(n.limiter).connect(ctx.destination);

    n.conv.buffer = makeImpulse(ctx, this.p.reverbSec);
    this.n = n;
    this.enabled = true;
    this.apply(true);
    this.stream.getAudioTracks()[0].addEventListener('ended', () => { this.disable(); renderMicUI(); });
  },

  disable() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.n) Object.values(this.n).forEach(node => { try { node.disconnect(); } catch {} });
    this.stream = null;
    this.n = null;
    this.enabled = false;
  },

  apply(instant = false) {
    if (!this.n) return;
    const t = AC.ctx.currentTime;
    const tc = instant ? 0.001 : 0.05;
    const n = this.n, p = this.p;
    n.mic.gain.setTargetAtTime(p.micVol, t, tc);
    n.delay.delayTime.setTargetAtTime(p.time, t, tc);
    n.fb.gain.setTargetAtTime(Math.min(p.feedback, 0.85), t, tc);
    n.fbFilter.frequency.setTargetAtTime(p.tone, t, tc);
    n.echoWet.gain.setTargetAtTime(p.echoMix, t, tc);
    n.revWet.gain.setTargetAtTime(p.reverbMix, t, tc);
  },

  set(key, value) {
    this.p[key] = value;
    this.apply();
  },

  preset(name) {
    const pr = PRESETS[name];
    if (!pr) return;
    const prevSec = this.p.reverbSec;
    Object.assign(this.p, pr);
    if (this.n && prevSec !== pr.reverbSec) this.n.conv.buffer = makeImpulse(AC.ctx, pr.reverbSec);
    this.apply();
  },

  rms() {
    if (!this.n) return 0;
    const an = this.n.analyser;
    if (!this._tbuf) this._tbuf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(this._tbuf);
    let s = 0;
    for (let i = 0; i < this._tbuf.length; i++) s += this._tbuf[i] * this._tbuf[i];
    return Math.sqrt(s / this._tbuf.length);
  },
};

const SLIDERS = [
  { key: 'micVol',    el: '#sl-mic',  out: '#out-mic',  fmt: v => `${Math.round(v * 100)}%` },
  { key: 'feedback',  el: '#sl-fb',   out: '#out-fb',   fmt: v => `${Math.round(v / 0.85 * 100)}%` },
  { key: 'time',      el: '#sl-time', out: '#out-time', fmt: v => `${v.toFixed(2)}秒` },
  { key: 'reverbMix', el: '#sl-rev',  out: '#out-rev',  fmt: v => `${Math.round(v * 100)}%` },
];

function syncSliders() {
  SLIDERS.forEach(s => {
    const v = MicFx.p[s.key];
    $(s.el).value = v;
    $(s.out).textContent = s.fmt(v);
  });
  $$('.preset').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset)));
}

function renderMicUI() {
  const on = MicFx.enabled;
  $('#btn-mic').setAttribute('aria-pressed', String(on));
  $('#btn-mic').textContent = on ? 'マイクをOFFにする' : 'マイクをONにする';
  $('#mic-state').textContent = on ? 'ON' : 'OFF';
  $('#mic-state').classList.toggle('is-on', on);
  if (!on) drawMeter();
}

function bindMic() {
  $('#btn-mic').addEventListener('click', async () => {
    if (MicFx.enabled) { MicFx.disable(); renderMicUI(); return; }
    if (localStorage.getItem(CONFIG.HOWL_KEY) !== '1') {
      const dlg = $('#dlg-howl');
      dlg.returnValue = '';
      dlg.showModal();
      const result = await new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
      if (result !== 'ok') return;
      if ($('#howl-skip').checked) localStorage.setItem(CONFIG.HOWL_KEY, '1');
    }
    try {
      await MicFx.enable();
      renderMicUI();
      meterLoop();
      toast('マイクをONにしました。音量は小さめから上げてください');
    } catch (err) {
      console.error(err);
      const msg = err.name === 'NotAllowedError'
        ? 'マイクの使用が許可されていません。アドレスバーの鍵マークからマイクを「許可」にしてください'
        : (err.message || 'マイクを開始できませんでした');
      toast(msg, 'error');
      MicFx.disable();
      renderMicUI();
    }
  });

  $$('.preset').forEach(b => b.addEventListener('click', () => {
    state.preset = b.dataset.preset;
    MicFx.preset(state.preset);
    syncSliders();
    savePrefs();
  }));

  SLIDERS.forEach(s => {
    $(s.el).addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      MicFx.set(s.key, v);
      // オフ状態から深さを動かしたらエコーを戻す
      if (s.key === 'feedback' && MicFx.p.echoMix === 0 && v > 0) MicFx.set('echoMix', 0.45);
      $(s.out).textContent = s.fmt(v);
      if (s.key !== 'micVol') {
        state.preset = 'custom';
        $$('.preset').forEach(btn => btn.setAttribute('aria-pressed', 'false'));
      }
      savePrefs();
    });
  });
}

function drawMeter() {
  const cv = $('#meter');
  const g = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const bars = 28, seg = 10, gap = 3, pad = 8;
  const bw = (w - pad * 2 - gap * (bars - 1)) / bars;
  const sh = (h - pad * 2 - gap * (seg - 1)) / seg;
  let bins = null;
  if (MicFx.enabled && MicFx.n) {
    const an = MicFx.n.analyser;
    if (!MicFx._fbuf) MicFx._fbuf = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(MicFx._fbuf);
    bins = MicFx._fbuf;
  }
  for (let i = 0; i < bars; i++) {
    let lit = 0;
    if (bins) {
      const idx = Math.min(bins.length - 1, Math.floor(Math.pow(i / bars, 1.6) * bins.length * 0.55) + 1);
      lit = Math.round((bins[idx] / 255) * seg);
    }
    for (let s = 0; s < seg; s++) {
      const on = s < lit;
      g.fillStyle = on ? (s >= seg - 2 ? '#E85D8E' : s >= seg - 4 ? '#F4B942' : '#7BE6EE') : 'rgba(246,234,219,0.06)';
      g.fillRect(pad + i * (bw + gap), h - pad - (s + 1) * sh - s * gap, bw, sh);
    }
  }
}
function meterLoop() {
  drawMeter();
  if (MicFx.enabled) requestAnimationFrame(meterLoop);
}

/* ---------------------------------------------------------
 * ボイス（Gemini TTS / ブラウザ音声）
 * ------------------------------------------------------- */
let jaVoice = null;
function pickJaVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = speechSynthesis.getVoices().filter(v => /ja[-_]JP/i.test(v.lang));
  jaVoice = vs.find(v => /Google/.test(v.name)) || vs[0] || null;
  return jaVoice;
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = pickJaVoice;

const Voice = {
  speaking: false,
  source: null,
  token: 0,

  async say(text, audio) {
    if (!text) return;
    const my = ++this.token;
    this.stop(true);
    this.speaking = true;
    showLine(text);
    $('#navi').classList.add('is-speaking');
    duck(true);
    updateListening();
    try {
      if (audio && audio.data) await this.playPcm(text, audio);
      else await this.browser(text);
    } catch (err) {
      console.warn('voice', err);
      if (my === this.token) { try { await this.browser(text); } catch {} }
    } finally {
      if (my === this.token) {
        this.speaking = false;
        $('#navi').classList.remove('is-speaking');
        duck(false);
        updateListening();
      }
    }
  },

  async playPcm(text, audio) {
    const ctx = await AC.resume();
    const bytes = b64ToBytes(audio.data);
    const mime = String(audio.mimeType || '').toLowerCase();
    let buffer;
    if (mime.includes('l16') || mime.includes('pcm')) {
      const rate = parseInt((mime.match(/rate=(\d+)/) || [])[1] || '24000', 10);
      const samples = bytes.length >> 1;
      buffer = ctx.createBuffer(1, samples, rate);
      const ch = buffer.getChannelData(0);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < samples; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
    } else {
      buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = 1.0;
    src.connect(g).connect(ctx.destination);
    this.source = src;
    telop(text, buffer.duration);
    await new Promise(res => { src.onended = res; src.start(); });
    this.source = null;
  },

  browser(text) {
    return new Promise(resolve => {
      const c = CHARACTERS[state.character];
      const est = (text.length * 0.14) / c.rate;
      telop(text, est);
      if (!('speechSynthesis' in window)) { setTimeout(resolve, est * 1000); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      u.pitch = c.pitch;
      u.rate = c.rate;
      const v = jaVoice || pickJaVoice();
      if (v) u.voice = v;
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      u.onend = fin;
      u.onerror = fin;
      setTimeout(fin, est * 1000 + 5000);
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  },

  stop(keepFlag = false) {
    if (this.source) { try { this.source.stop(); } catch {} this.source = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (!keepFlag) {
      this.token++;
      this.speaking = false;
      $('#navi')?.classList.remove('is-speaking');
      duck(false);
    }
  },
};

function duck(on) {
  if (!state.playerReady) return;
  try { state.player.setVolume(on ? Math.round(state.musicVol * 0.3) : state.musicVol); } catch {}
}

function showLine(text) { $('#navi-bubble').textContent = text; }

function telop(text, sec) {
  const el = $('#telop');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'telop-text is-wipe';
  span.textContent = text;
  span.dataset.text = text;
  span.style.setProperty('--dur', `${Math.max(1, sec).toFixed(2)}s`);
  el.appendChild(span);
  el.hidden = false;
  clearTimeout(state.telopTimer);
  state.telopTimer = setTimeout(() => { el.hidden = true; }, (Math.max(1, sec) + 1.8) * 1000);
}

function setNavi(busy, text = '') {
  $('#navi').classList.toggle('is-busy', busy);
  $('#navi-status').textContent = busy ? text : '';
}

function renderCharacter() {
  const c = CHARACTERS[state.character];
  $('#navi').dataset.character = state.character;
  $('#navi-avatar').textContent = c.avatar;
  $('#navi-name').textContent = c.name;
}

function fallbackLine(scene, extra = {}) {
  const f = FALLBACK[state.character] || FALLBACK.mama;
  if (scene === 'outro' && (extra.score === null || extra.score === undefined)) return f.outroNoMic;
  return f[scene] || f.chat;
}

/** セリフ（＋音声）を取得。失敗時はフォールバックのセリフを返す */
function fetchLine(scene, extra = {}) {
  const s = state.song;
  const payload = {
    scene,
    character: state.character,
    withAudio: state.ttsMode === 'gemini',
    song: s ? { title: s.title, artist: s.artist, keyShift: s.keyShift, memo: s.memo } : null,
    ...extra,
  };
  return withTimeout(api('aiSpeak', payload), CONFIG.AI_TIMEOUT_MS)
    .then(r => {
      if (r.ttsError) console.warn('TTS:', r.ttsError);
      return { text: r.text, audio: r.audio };
    })
    .catch(err => {
      console.warn('aiSpeak', err);
      return { text: fallbackLine(scene, extra), audio: null };
    });
}

/* ---------------------------------------------------------
 * YouTube プレイヤー
 * ------------------------------------------------------- */
window.onYouTubeIframeAPIReady = function () {
  state.player = new YT.Player('yt-player', {
    width: '100%',
    height: '100%',
    playerVars: { playsinline: 1, rel: 0, modestbranding: 1, fs: 1 },
    events: {
      onReady: () => {
        state.playerReady = true;
        state.player.setVolume(state.musicVol);
        if (state.pendingVideo) { state.player.cueVideoById(state.pendingVideo); state.pendingVideo = null; }
      },
      onStateChange: onPlayerState,
      onError: e => {
        const msg = (e.data === 101 || e.data === 150)
          ? 'この動画は外部サイトでの再生が許可されていません。別の動画を選んでください'
          : 'この動画を再生できませんでした。別の動画を選んでください';
        toast(msg, 'error');
      },
    },
  });
};

function onPlayerState(e) {
  state.playerState = e.data;
  $('#btn-play').classList.toggle('is-playing', e.data === YT_STATE.PLAYING);
  $('#btn-play').setAttribute('aria-label', e.data === YT_STATE.PLAYING ? '一時停止' : '再生');

  if (e.data === YT_STATE.PLAYING) {
    if (!state.session) startSession();
    state.session.playing = true;
    if (state.song && !state.song.title) {
      const d = state.player.getVideoData?.();
      if (d?.title) { state.song.title = d.title; renderNow(); }
    }
  } else if (e.data === YT_STATE.PAUSED) {
    if (state.session) state.session.playing = false;
  } else if (e.data === YT_STATE.ENDED) {
    finishSong();
  }
  updateListening();
}

function setSong(song) {
  Voice.stop();
  state.song = {
    videoId: song.videoId,
    title: song.title || '',
    artist: song.artist || '',
    keyShift: Number(song.keyShift) || 0,
    memo: song.memo || '',
    favId: song.favId || song.id || null,
  };
  // マイリストにあれば情報を引き継ぐ
  const fav = state.favorites.find(f => f.videoId === state.song.videoId);
  if (fav) Object.assign(state.song, { title: fav.title, artist: fav.artist, keyShift: fav.keyShift, memo: fav.memo, favId: fav.id });

  state.session = null;
  state.prefetch = { intro: fetchLine('intro') };
  $('#score-card').hidden = true;
  $('#screen-empty').hidden = true;
  if (state.playerReady) state.player.cueVideoById(state.song.videoId);
  else state.pendingVideo = state.song.videoId;
  renderNow();
}

async function startWithIntro() {
  if (!state.song) return toast('先に曲を選んでください', 'error');
  await AC.resume().catch(() => {});
  if (state.playerState === YT_STATE.PLAYING) state.player.pauseVideo();
  setNavi(true, '曲紹介を準備中');
  $('#btn-intro').disabled = true;
  const line = await (state.prefetch.intro || fetchLine('intro'));
  state.prefetch.intro = null;
  setNavi(false);
  $('#btn-intro').disabled = false;
  await Voice.say(line.text, line.audio);
  if (state.playerReady) state.player.playVideo();
}

function renderNow() {
  const s = state.song;
  const has = !!s;
  $('#now-title').textContent = has ? (s.title || '（曲名を取得中）') : '曲が選ばれていません';
  $('#now-artist').textContent = has ? s.artist : '';
  $('#now-key').textContent = has ? fmtKey(s.keyShift) : '原曲キー';
  $('#now-memo').hidden = !(has && s.memo);
  $('#now-memo').textContent = has && s.memo ? `練習メモ：${s.memo}` : '';
  ['#btn-restart', '#btn-back10', '#btn-play', '#btn-intro', '#seek', '#key-down', '#key-up', '#btn-fav-now']
    .forEach(id => { $(id).disabled = !has; });
  $('#btn-fav-now').textContent = has && s.favId ? 'マイリストを編集' : 'マイリストに保存';
}

function bindPlayer() {
  $('#btn-play').addEventListener('click', () => {
    if (!state.playerReady || !state.song) return;
    AC.resume().catch(() => {});
    if (state.playerState === YT_STATE.PLAYING) state.player.pauseVideo();
    else state.player.playVideo();
  });
  $('#btn-restart').addEventListener('click', () => {
    if (!state.playerReady) return;
    state.session = null;
    $('#score-card').hidden = true;
    state.player.seekTo(0, true);
    state.player.playVideo();
  });
  $('#btn-back10').addEventListener('click', () => {
    if (!state.playerReady) return;
    state.player.seekTo(Math.max(0, state.player.getCurrentTime() - 10), true);
  });
  $('#btn-intro').addEventListener('click', startWithIntro);

  const seek = $('#seek');
  seek.addEventListener('input', () => {
    state.seeking = true;
    const d = state.player?.getDuration?.() || 0;
    $('#t-cur').textContent = fmtTime(d * seek.value / 1000);
  });
  seek.addEventListener('change', () => {
    const d = state.player?.getDuration?.() || 0;
    if (d) state.player.seekTo(d * seek.value / 1000, true);
    state.seeking = false;
  });

  const vol = $('#vol');
  vol.value = state.musicVol;
  vol.addEventListener('input', () => {
    state.musicVol = Number(vol.value);
    if (state.playerReady && !Voice.speaking) state.player.setVolume(state.musicVol);
    savePrefs();
  });

  $('#key-down').addEventListener('click', () => changeKey(-1));
  $('#key-up').addEventListener('click', () => changeKey(1));
  $('#btn-fav-now').addEventListener('click', () => {
    if (!state.song) return;
    const fav = state.favorites.find(f => f.id === state.song.favId);
    openFavDialog(fav || { ...state.song, isOhako: false });
  });

  setInterval(() => {
    if (!state.playerReady || state.seeking || !state.player.getDuration) return;
    const d = state.player.getDuration() || 0;
    const c = state.player.getCurrentTime() || 0;
    $('#seek').value = d ? Math.round(c / d * 1000) : 0;
    $('#t-cur').textContent = fmtTime(c);
    $('#t-dur').textContent = fmtTime(d);
  }, 500);

  setInterval(tick, 100);
}

function changeKey(delta) {
  if (!state.song) return;
  state.song.keyShift = Math.max(-12, Math.min(12, (state.song.keyShift || 0) + delta));
  renderNow();
  if (state.song.favId) {
    clearTimeout(state.keySaveTimer);
    state.keySaveTimer = setTimeout(async () => {
      const fav = state.favorites.find(f => f.id === state.song.favId);
      if (!fav) return;
      try {
        const r = await api('saveFavorite', { fav: { ...fav, keyShift: state.song.keyShift } });
        upsertFav(r.fav);
      } catch (err) { toast(err.message, 'error'); }
    }, 900);
  }
}

/* ---------------------------------------------------------
 * 歌唱セッション（間奏の合いの手・簡易採点）
 * ------------------------------------------------------- */
function startSession() {
  state.session = {
    playing: true, playMs: 0, frames: 0, voiced: 0, sum: 0, sumSq: 0, silentMs: 0,
    interludeDone: false, micUsed: MicFx.enabled,
  };
  $('#score-card').hidden = true;
  state.prefetch.interlude = fetchLine('interlude');
}

function tick() {
  const s = state.session;
  if (!s || !s.playing) return;
  s.playMs += 100;
  if (MicFx.enabled) {
    s.micUsed = true;
    const r = MicFx.rms();
    s.frames++;
    if (r > CONFIG.VOICE_THRESHOLD) {
      s.voiced++; s.sum += r; s.sumSq += r * r; s.silentMs = 0;
    } else {
      s.silentMs += 100;
    }
  }
  if (s.interludeDone || Voice.speaking || !state.playerReady) return;
  const cur = state.player.getCurrentTime(), dur = state.player.getDuration();
  if (!dur) return;
  const inWindow = s.playMs > 40000 && cur < dur - 25;
  const micTrigger = MicFx.enabled && s.voiced > 50 && s.silentMs >= 7000; // しばらく歌ってから7秒の無音＝間奏
  const timeTrigger = cur >= dur * 0.55;                                  // マイクなし・検知できない時の保険
  if (inWindow && (micTrigger || timeTrigger)) {
    s.interludeDone = true;
    doInterlude();
  }
}

async function doInterlude() {
  const line = await (state.prefetch.interlude || fetchLine('interlude'));
  state.prefetch.interlude = null;
  if (state.playerState !== YT_STATE.PLAYING) return;
  Voice.say(line.text, line.audio);
}

function computeScore(s) {
  if (!s || !s.micUsed || s.frames < 100) return null;
  if (s.voiced < 20) return { score: 60, voicedPct: Math.round(s.voiced / s.frames * 100), stability: 'ほぼ無音' };
  const ratio = s.voiced / s.frames;
  const mean = s.sum / s.voiced;
  const variance = Math.max(0, s.sumSq / s.voiced - mean * mean);
  const cv = Math.sqrt(variance) / mean;
  const ratioPt = 15 * (1 - Math.min(1, Math.abs(ratio - 0.55) / 0.55));
  const stabPt = 10 * (1 - Math.min(1, cv / 1.2));
  const lenPt = Math.min(5, (s.voiced / 600) * 5);
  const score = Math.min(100, 70 + ratioPt + stabPt + lenPt);
  return {
    score: Math.round(score * 1000) / 1000,
    voicedPct: Math.round(ratio * 100),
    stability: cv < 0.45 ? 'とても安定' : cv < 0.75 ? '安定' : cv < 1.0 ? 'やや不安定' : '不安定',
  };
}

async function finishSong() {
  const s = state.session;
  state.session = null;
  if (!s) return;
  const result = computeScore(s);
  const card = $('#score-card');
  card.hidden = false;
  $('#score-num').textContent = result ? '…' : '--';
  $('#score-detail').textContent = result ? '採点中' : 'マイクOFFのため採点なし';
  setNavi(true, '講評を考え中');
  const line = await fetchLine('outro', {
    score: result ? result.score : null,
    stats: result ? { voicedPct: result.voicedPct, stability: result.stability } : null,
  });
  setNavi(false);
  if (result) {
    $('#score-num').textContent = result.score.toFixed(3);
    $('#score-detail').textContent = `歌っていた割合 ${result.voicedPct}%／声量の安定感：${result.stability}`;
  }
  await Voice.say(line.text, line.audio);
}

/* ---------------------------------------------------------
 * 曲さがし（AI選曲・YouTube検索・音声入力）
 * ------------------------------------------------------- */
const normKey = (title, artist) => `${title}|${artist}`.replace(/[\s　]/g, '').toLowerCase();

function isInMylist(song) {
  const k = normKey(song.title, song.artist);
  return state.favorites.some(f => normKey(f.title, f.artist) === k || (song.videoId && f.videoId === song.videoId));
}

function bindSearch() {
  const form = $('#form-search');

  // Enter・「AIで選曲」ボタン：URLならそのままセット、それ以外はAI選曲
  form.addEventListener('submit', e => {
    e.preventDefault();
    const q = form.q.value.trim();
    const id = parseYouTubeId(q);
    if (id) {
      setSong({ videoId: id });
      toast('動画をセットしました');
      return;
    }
    runAiPick();
  });

  $('#btn-yt-search').addEventListener('click', () => runYouTubeSearch(form.q.value.trim()));
  $('#btn-dictate').addEventListener('click', toggleDictation);

  $('#search-results').addEventListener('click', async e => {
    const li = e.target.closest('li[data-idx]');
    if (!li) return;
    const idx = Number(li.dataset.idx);

    if (state.resultMode === 'ai') {
      const cb = e.target.closest('input[type="checkbox"]');
      if (cb) {
        state.aiResults[idx].checked = cb.checked;
        li.classList.toggle('is-checked', cb.checked);
        renderPickBar();
        return;
      }
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const song = state.aiResults[idx];
      if (btn.dataset.act === 'sing' || btn.dataset.act === 'set') {
        const ok = await ensureVideo(song, btn);
        if (!ok) return;
        setSong({ videoId: song.videoId, title: song.title, artist: song.artist });
        if (btn.dataset.act === 'sing') startWithIntro(); else toast('セットしました');
      }
      return;
    }

    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const item = state.searchResults[idx];
    if (!item) return;
    if (btn.dataset.act === 'set') { setSong({ videoId: item.videoId, title: item.title }); toast('セットしました。「曲紹介から歌う」で始めましょう'); }
    if (btn.dataset.act === 'fav') openFavDialog({ videoId: item.videoId, title: item.title, artist: '', keyShift: 0, memo: '', isOhako: false });
  });

  $('#chk-pick-all').addEventListener('change', e => {
    state.aiResults.forEach(s => { if (!s.registered) s.checked = e.target.checked; });
    renderSearch();
  });
  $('#btn-pick-add').addEventListener('click', registerChecked);
}

async function runAiPick() {
  const form = $('#form-search');
  const keyword = form.q.value.trim();
  const era = $('#sel-era').value;
  const vocal = $('#sel-vocal').value;
  if (!keyword && !era && !vocal) {
    toast('キーワードを入れるか、年代・ボーカルを選んでください', 'error');
    return;
  }
  const list = $('#search-results');
  $('#pick-bar').hidden = true;
  $('#result-head').hidden = true;
  list.innerHTML = '<li class="empty">AIが選曲しています…</li>';
  setBusy(form, true, '選曲中…');
  try {
    const r = await withTimeout(api('aiPickSongs', { keyword, era, vocal, count: 10 }), 45000);
    state.aiCondition = r.condition || '';
    state.aiResults = (r.songs || []).map(s => ({ ...s, checked: false, registered: isInMylist(s), videoId: '' }));
    state.resultMode = 'ai';
    renderSearch();
  } catch (err) {
    list.innerHTML = `<li class="empty">${esc(err.message)}</li>`;
  } finally {
    setBusy(form, false);
  }
}

async function runYouTubeSearch(q) {
  if (!q) { toast('検索ワードを入力してください', 'error'); return; }
  const id = parseYouTubeId(q);
  if (id) { setSong({ videoId: id }); toast('動画をセットしました'); return; }
  const btn = $('#btn-yt-search');
  const list = $('#search-results');
  $('#pick-bar').hidden = true;
  $('#result-head').hidden = true;
  list.innerHTML = '<li class="empty">検索中…</li>';
  btn.disabled = true;
  try {
    const r = await api('searchVideos', { q, karaoke: $('#chk-karaoke').checked });
    state.searchResults = r.items;
    state.resultMode = 'youtube';
    renderSearch();
  } catch (err) {
    list.innerHTML = `<li class="empty">${esc(err.message)}</li>`;
  } finally {
    btn.disabled = false;
  }
}

/** AI選曲の曲にYouTube動画IDが無ければ探す */
async function ensureVideo(song, btn) {
  if (song.videoId) return true;
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '動画を探し中…'; }
  try {
    const r = await api('resolveVideos', { songs: [{ title: song.title, artist: song.artist }] });
    const v = r.songs?.[0]?.videoId;
    if (!v) { toast('カラオケ動画が見つかりませんでした。「YouTubeで検索」も試してください', 'error'); return false; }
    song.videoId = v;
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

function renderSearch() {
  const list = $('#search-results');
  const head = $('#result-head');

  if (state.resultMode === 'ai') {
    head.hidden = false;
    head.innerHTML = `AI選曲 <strong>${state.aiResults.length}曲</strong>${state.aiCondition ? `　条件：${esc(state.aiCondition)}` : ''}`;
    if (!state.aiResults.length) {
      list.innerHTML = '<li class="empty">条件に合う曲が見つかりませんでした。キーワードや条件を変えてみてください。</li>';
      $('#pick-bar').hidden = true;
      return;
    }
    list.innerHTML = state.aiResults.map((s, i) => `
      <li class="song-row ai-row${s.checked ? ' is-checked' : ''}" data-idx="${i}">
        <label class="pick">
          <input type="checkbox" ${s.checked ? 'checked' : ''} ${s.registered ? 'disabled' : ''} aria-label="${esc(s.title)}を選ぶ">
        </label>
        <div class="song-meta">
          <p class="song-title">${esc(s.title)}</p>
          <p class="song-sub">${esc(s.artist)}${s.year ? `<span>${esc(s.year)}年</span>` : ''}${s.vocal ? `<span class="vocal-chip">${esc(s.vocal)}</span>` : ''}${s.registered ? '<span class="done-chip">登録済み</span>' : ''}</p>
          ${s.reason ? `<p class="song-reason">${esc(s.reason)}</p>` : ''}
          <div class="song-actions" style="margin-top:8px">
            <button class="btn btn-sm btn-primary" data-act="sing">曲紹介から歌う</button>
            <button class="btn btn-sm" data-act="set">セットだけ</button>
          </div>
        </div>
      </li>`).join('');
    renderPickBar();
    return;
  }

  $('#pick-bar').hidden = true;
  head.hidden = true;
  if (!state.searchResults.length) {
    list.innerHTML = '<li class="empty">見つかりませんでした。曲名と歌手名を組み合わせて検索してみてください。</li>';
    return;
  }
  list.innerHTML = state.searchResults.map((it, i) => `
    <li class="song-row" data-idx="${i}">
      <img src="https://i.ytimg.com/vi/${esc(it.videoId)}/mqdefault.jpg" alt="" loading="lazy">
      <div class="song-meta">
        <p class="song-title">${esc(it.title)}</p>
        <p class="song-sub">${esc(it.channel)}</p>
      </div>
      <div class="song-actions">
        <button class="btn btn-sm btn-primary" data-act="set">セットする</button>
        <button class="btn btn-sm" data-act="fav">マイリストへ</button>
      </div>
    </li>`).join('');
}

/** 選択バー（AI選曲・お出かけ共通） */
function updatePickBar(list, { bar, btn, all, visible }) {
  const selectable = list.filter(s => !s.registered);
  const n = list.filter(s => s.checked && !s.registered).length;
  $(bar).hidden = !visible || !list.length;
  const b = $(btn);
  if (!b.dataset.busy) {
    b.disabled = n === 0;
    b.textContent = n ? `チェックした${n}曲をマイリストに登録` : 'チェックした曲をマイリストに登録';
  }
  const a = $(all);
  a.disabled = selectable.length === 0;
  a.checked = selectable.length > 0 && n === selectable.length;
}

function renderPickBar() {
  updatePickBar(state.aiResults, { bar: '#pick-bar', btn: '#btn-pick-add', all: '#chk-pick-all', visible: state.resultMode === 'ai' });
}
function renderGoPickBar() {
  updatePickBar(state.suggestions, { bar: '#go-pick-bar', btn: '#btn-go-pick-add', all: '#chk-go-pick-all', visible: true });
}

/** チェックした曲をまとめてマイリストに登録 */
async function registerSongs(list, btnSel, rerender) {
  const targets = list.filter(s => s.checked && !s.registered);
  if (!targets.length) return;
  const btn = $(btnSel);
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.textContent = `${targets.length}曲を登録中…`;
  try {
    const r = await withTimeout(api('addSongsToMylist', {
      items: targets.map(s => ({ title: s.title, artist: s.artist, videoId: s.videoId })),
    }), 60000);
    const byKey = new Map(targets.map(s => [normKey(s.title, s.artist), s]));
    (r.added || []).forEach(fav => {
      upsertFav(fav);
      const s = byKey.get(normKey(fav.title, fav.artist));
      if (s) { s.registered = true; s.checked = false; s.videoId = fav.videoId; }
    });
    const notFound = [];
    (r.skipped || []).forEach(sk => {
      const s = byKey.get(normKey(sk.title, sk.artist));
      if (!s) return;
      if (sk.reason === '登録済み') { s.registered = true; s.checked = false; }
      else notFound.push(`${sk.title}（${sk.reason}）`);
    });
    const msg = `${(r.added || []).length}曲をマイリストに登録しました`
      + (notFound.length ? `。登録できなかった曲：${notFound.join('、')}` : '');
    toast(msg, notFound.length ? 'error' : 'info');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    delete btn.dataset.busy;
    rerender();
  }
}

function registerChecked() {
  return registerSongs(state.aiResults, '#btn-pick-add', renderSearch);
}

/* 音声入力（話し終わったらAI選曲を自動実行） */
function toggleDictation() {
  if (state.dictating) {
    try { state.dictRecog?.stop(); } catch {}
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('このブラウザは音声入力に対応していません（Chrome・Safariの最新版をお使いください）', 'error'); return; }

  const input = $('#form-search').q;
  const stateEl = $('#dictate-state');
  const r = new SR();
  r.lang = 'ja-JP';
  r.continuous = false;
  r.interimResults = true;
  r.maxAlternatives = 1;
  let finalText = '';

  r.onstart = () => {
    stateEl.hidden = false;
    stateEl.textContent = '聞いています…話し終わると自動で選曲します';
  };
  r.onresult = ev => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) finalText += t; else interim += t;
    }
    input.value = (finalText + interim).trim();
  };
  r.onerror = ev => {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') toast('音声入力のためのマイク使用が許可されていません', 'error');
    else if (ev.error === 'no-speech') toast('声が聞き取れませんでした。もう一度どうぞ', 'error');
  };
  r.onend = () => {
    state.dictating = false;
    state.dictRecog = null;
    renderDictateUI();
    stateEl.hidden = true;
    updateListening();
    const text = finalText.trim();
    if (text) {
      input.value = text;
      const id = parseYouTubeId(text);
      if (!id) runAiPick();
    }
  };

  state.dictating = true;
  state.dictRecog = r;
  renderDictateUI();
  const wasRunning = state.recogRunning;
  updateListening(); // 「行こう！」待ち受けを一時停止
  AC.resume().catch(() => {});
  setTimeout(() => {
    try { r.start(); }
    catch (err) {
      state.dictating = false;
      state.dictRecog = null;
      renderDictateUI();
      updateListening();
      toast('音声入力を開始できませんでした', 'error');
    }
  }, wasRunning ? 450 : 0);
}

function renderDictateUI() {
  const b = $('#btn-dictate');
  b.setAttribute('aria-pressed', String(state.dictating));
  b.setAttribute('aria-label', state.dictating ? '音声入力を止める' : '声で入力');
}

/* ---------------------------------------------------------
 * マイリスト
 * ------------------------------------------------------- */
async function loadFavorites() {
  $('#fav-list').innerHTML = '<li class="empty">読み込み中…</li>';
  try {
    const r = await api('listFavorites');
    state.favorites = r.favorites;
    renderFavorites();
    if (state.resultMode === 'ai') {
      state.aiResults.forEach(s => { if (isInMylist(s)) { s.registered = true; s.checked = false; } });
      renderSearch();
    }
    if (state.suggestions.length) {
      state.suggestions.forEach(s => { if (isInMylist(s)) { s.registered = true; s.checked = false; } });
      renderSuggestions();
    }
  } catch (err) {
    $('#fav-list').innerHTML = `<li class="empty">${esc(err.message)}</li>`;
  }
}

function upsertFav(fav) {
  const i = state.favorites.findIndex(f => f.id === fav.id);
  if (i >= 0) state.favorites[i] = fav; else state.favorites.unshift(fav);
  state.favorites.sort((a, b) => (a.isOhako !== b.isOhako ? (a.isOhako ? -1 : 1) : b.updatedAt - a.updatedAt));
  if (state.song && state.song.videoId === fav.videoId) {
    Object.assign(state.song, { title: fav.title, artist: fav.artist, keyShift: fav.keyShift, memo: fav.memo, favId: fav.id });
    renderNow();
  }
  renderFavorites();
}

function renderFavorites() {
  const list = $('#fav-list');
  const items = state.favorites.filter(f => state.favFilter === 'all' || f.isOhako);
  $('#fav-count').textContent = `${state.favorites.length}曲`;
  if (!items.length) {
    list.innerHTML = state.favFilter === 'ohako'
      ? '<li class="empty">十八番はまだありません。「編集」で「十八番にする」にチェックを入れましょう。</li>'
      : '<li class="empty">まだ曲がありません。「曲さがし」で見つけた曲を「マイリストへ」で追加できます。</li>';
    return;
  }
  list.innerHTML = items.map(f => `
    <li class="song-row" data-id="${esc(f.id)}">
      <img src="https://i.ytimg.com/vi/${esc(f.videoId)}/mqdefault.jpg" alt="" loading="lazy">
      <div class="song-meta">
        <p class="song-title">${f.isOhako ? '<span class="ohako">十八番</span>' : ''}${esc(f.title)}</p>
        <p class="song-sub">${esc(f.artist)}<span class="key-chip">${fmtKey(f.keyShift)}</span></p>
        ${f.memo ? `<p class="song-memo">${esc(f.memo)}</p>` : ''}
      </div>
      <div class="song-actions">
        <button class="btn btn-sm btn-primary" data-act="sing">曲紹介から歌う</button>
        <button class="btn btn-sm" data-act="set">セットだけ</button>
        <button class="btn btn-sm" data-act="edit">編集</button>
        <button class="btn btn-sm btn-ghost" data-act="del">削除</button>
      </div>
    </li>`).join('');
}

function bindMylist() {
  $$('[data-filter]').forEach(b => b.addEventListener('click', () => {
    state.favFilter = b.dataset.filter;
    $$('[data-filter]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderFavorites();
  }));

  $('#fav-list').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const fav = state.favorites.find(f => f.id === btn.closest('li').dataset.id);
    if (!fav) return;
    const act = btn.dataset.act;
    if (act === 'sing') { setSong(fav); startWithIntro(); }
    if (act === 'set') { setSong(fav); toast('セットしました'); }
    if (act === 'edit') openFavDialog(fav);
    if (act === 'del') {
      if (!confirm(`「${fav.title}」をマイリストから削除しますか？`)) return;
      try {
        await api('deleteFavorite', { id: fav.id });
        state.favorites = state.favorites.filter(f => f.id !== fav.id);
        if (state.song?.favId === fav.id) { state.song.favId = null; renderNow(); }
        renderFavorites();
        toast('削除しました');
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  // キー選択肢
  const sel = $('#form-fav').keyShift;
  for (let k = -12; k <= 12; k++) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = fmtKey(k);
    sel.appendChild(o);
  }

  $('#dlg-fav [data-close]').addEventListener('click', () => $('#dlg-fav').close());
  $('#form-fav').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const fav = {
      id: f.favId.value || null,
      videoId: f.videoId.value,
      title: f.songTitle.value.trim(),
      artist: f.artist.value.trim(),
      keyShift: Number(f.keyShift.value),
      memo: f.memo.value,
      isOhako: f.isOhako.checked,
    };
    if (!fav.title) return toast('曲名を入力してください', 'error');
    setBusy(f, true, '保存中…');
    try {
      const r = await api('saveFavorite', { fav });
      upsertFav(r.fav);
      $('#dlg-fav').close();
      toast('マイリストに保存しました');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(f, false);
    }
  });
}

function openFavDialog(src) {
  const f = $('#form-fav');
  f.favId.value = src.id || src.favId || '';
  f.videoId.value = src.videoId;
  f.songTitle.value = src.title || '';
  f.artist.value = src.artist || '';
  f.keyShift.value = String(Number(src.keyShift) || 0);
  f.memo.value = src.memo || '';
  f.isOhako.checked = !!src.isOhako;
  $('#dlg-fav .dlg-title').textContent = f.favId.value ? 'マイリストを編集' : 'マイリストに保存';
  $('#dlg-fav').showModal();
}

/* ---------------------------------------------------------
 * お出かけ選曲（GPS）＆「行こう！」音声トリガー
 * ------------------------------------------------------- */
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('この端末は位置情報に対応していません'));
    navigator.geolocation.getCurrentPosition(resolve, err => {
      const msg = err.code === 1 ? '位置情報の利用が許可されていません。ブラウザの設定で許可してください'
        : err.code === 3 ? '時間内に現在地を取得できませんでした。屋外や窓の近くで試してください'
        : '現在地を取得できませんでした';
      reject(new Error(msg));
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
}

function setOutingStatus(t) { $('#outing-status').textContent = t; }

const STEP_ORDER = ['locate', 'guess', 'pick', 'go'];
const STEP_SCREEN = {
  locate: { ico: '📍', text: '現在地をキャッチ中…', moving: false },
  guess:  { ico: '🗺️', text: 'この辺りの雰囲気を推理中…', moving: true },
  pick:   { ico: '🎵', text: 'ぴったりの曲を選曲中…', moving: true },
  go:     { ico: '🎤', text: '出発進行！', moving: true },
};

/** スクリーン上の出発演出 */
function showGoOverlay(step, sub = '') {
  const ov = $('#go-overlay');
  if (!step) { ov.hidden = true; ov.className = 'go-overlay'; return; }
  const d = STEP_SCREEN[step];
  ov.hidden = false;
  ov.classList.toggle('is-moving', !!d?.moving);
  ov.classList.remove('is-arrived');
  if (d) {
    $('#go-ov-ico').textContent = d.ico;
    $('#go-ov-text').textContent = d.text;
    $('#go-ov-sub').textContent = sub;
  }
}

function showArrival(r) {
  const ov = $('#go-overlay');
  ov.hidden = false;
  ov.classList.remove('is-moving');
  ov.classList.add('is-arrived');
  $('#go-ov-ico').textContent = sceneEmoji(r.scene);
  $('#go-ov-text').textContent = `${r.area || 'このあたり'}に到着！`;
  $('#go-ov-sub').textContent = [r.scene && `${r.scene}エリア`, r.mood && `ムード：${r.mood}`].filter(Boolean).join('　');
}

function setStep(step) {
  if (step && step !== 'done' && STEP_SCREEN[step]) showGoOverlay(step);
  const steps = $('#go-steps');
  steps.hidden = !step;
  const idx = STEP_ORDER.indexOf(step);
  $$('#go-steps li').forEach(li => {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    li.classList.toggle('is-done', idx >= 0 && (i < idx || step === 'done'));
    li.classList.toggle('is-active', i === idx);
  });
  if (step === 'done') $$('#go-steps li').forEach(li => { li.classList.add('is-done'); li.classList.remove('is-active'); });
}

function sceneEmoji(scene = '') {
  const s = String(scene);
  if (/海|浜|港|湾|岬/.test(s)) return '🌊';
  if (/山|峠|高原|森/.test(s)) return '⛰️';
  if (/川|湖|渓/.test(s)) return '🏞️';
  if (/温泉/.test(s)) return '♨️';
  if (/車|移動|ドライブ|高速/.test(s)) return '🚗';
  if (/旅|観光|名所/.test(s)) return '🧳';
  if (/田|畑|里|農/.test(s)) return '🌾';
  if (/自宅|住宅|家/.test(s)) return '🏠';
  if (/街|都|駅|繁華|ビル/.test(s)) return '🏙️';
  return '📍';
}

function renderTicket(r) {
  const now = new Date();
  $('#ticket-time').textContent = `${now.getMonth() + 1}/${now.getDate()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')} 発`;
  $('#ticket-emoji').textContent = sceneEmoji(r.scene);
  $('#ticket-area').textContent = r.area || 'このあたり';
  $('#ticket-scene').textContent = r.scene ? `${r.scene}エリア` : '';
  $('#ticket-mood').textContent = r.mood || '';
  $('#ticket-cond').hidden = !r.condition;
  $('#ticket-cond').textContent = r.condition ? `条件：${r.condition}` : '';
  const t = $('#ticket');
  t.hidden = true;
  void t.offsetWidth; // アニメーションを毎回やり直す
  t.hidden = false;
}

async function runOutingFlow({ autoplay = false } = {}) {
  if (state.busyOuting) return;
  state.busyOuting = true;
  updateListening();
  setGoButtons(true);
  $('#ticket').hidden = true;
  $('#suggest-list').innerHTML = '';
  $('#go-pick-bar').hidden = true;
  setOutingStatus('');
  try {
    setStep('locate');
    const pos = await getPosition();
    setStep('guess');
    setNavi(true, '選曲中');
    const req = withTimeout(api('suggestByLocation', {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      speed: pos.coords.speed,
      character: state.character,
      withAudio: state.ttsMode === 'gemini',
      note: $('#outing-note').value.trim(),
      era: $('#sel-go-era').value,
      vocal: $('#sel-go-vocal').value,
    }), 45000);
    // 推理→選曲の表示を少し進める（サーバーは1回の通信で両方やる）
    const stepTimer = setTimeout(() => setStep('pick'), 2500);
    const r = await req;
    clearTimeout(stepTimer);
    setNavi(false);

    state.suggestions = (r.songs || []).map(x => ({ ...x, checked: false, registered: isInMylist(x) }));
    state.goCondition = r.condition || '';
    showArrival(r);
    renderTicket(r);
    renderSuggestions();
    setStep(autoplay ? 'go' : 'done');
    await Voice.say(r.comment, r.audio);

    if (autoplay) {
      const first = state.suggestions.find(s => s.videoId);
      if (first) {
        setSong({ videoId: first.videoId, title: first.title, artist: first.artist });
        $('#screen-empty').hidden = true;
        showGoOverlay('go', `1曲目は「${first.title}」`);
        setStep('done');
        await startWithIntro();
        showGoOverlay(null);
      } else {
        setStep('done');
        toast('再生できる動画が見つかりませんでした。候補から選んでください', 'error');
      }
    }
  } catch (err) {
    setNavi(false);
    setStep(null);
    showGoOverlay(null);
    setOutingStatus(err.message);
    toast(err.message, 'error');
  } finally {
    state.busyOuting = false;
    setGoButtons(false);
    updateListening();
    // 曲が始まっていなければ数秒後に演出を閉じる
    setTimeout(() => { if (!state.busyOuting) showGoOverlay(null); }, autoplay ? 400 : 3500);
  }
}

function setGoButtons(busy) {
  ['#btn-outing', '#btn-go', '#fab-go', '#btn-empty-go'].forEach(id => { const b = $(id); if (b) b.disabled = busy; });
}

function renderSuggestions() {
  const list = $('#suggest-list');
  const firstPlayable = state.suggestions.findIndex(s => s.videoId);
  list.innerHTML = state.suggestions.map((s, i) => `
    <li class="station${i === firstPlayable ? ' is-first' : ''}${s.checked ? ' is-checked' : ''}" data-idx="${i}">
      <span class="station-dot" aria-hidden="true"></span>
      ${i === firstPlayable ? '<span class="first-badge" style="margin-left:32px">1曲目</span>' : ''}
      <label class="station-check">
        <input type="checkbox" ${s.checked ? 'checked' : ''} ${s.registered ? 'disabled' : ''}>
        <span class="song-title">${esc(s.title)}</span>
      </label>
      <p class="song-sub">${esc(s.artist)}${s.year ? `<span>${esc(s.year)}年</span>` : ''}${s.vocal ? `<span class="vocal-chip">${esc(s.vocal)}</span>` : ''}${s.registered ? '<span class="done-chip">登録済み</span>' : ''}</p>
      <p class="song-reason">${esc(s.reason)}</p>
      <div class="song-actions">
        <button class="btn btn-sm btn-primary" data-act="sing">曲紹介から歌う</button>
        <button class="btn btn-sm btn-ghost" data-act="search">YouTubeで探す</button>
      </div>
    </li>`).join('');
  renderGoPickBar();
}

function bindOuting() {
  const go = () => {
    AC.resume().catch(() => {});
    selectTab('outing');
    runOutingFlow({ autoplay: true });
  };
  $('#btn-go').addEventListener('click', go);
  $('#fab-go').addEventListener('click', go);
  $('#btn-empty-go').addEventListener('click', go);
  $('#btn-outing').addEventListener('click', () => { AC.resume().catch(() => {}); runOutingFlow(); });

  $('#suggest-list').addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const li = cb.closest('li');
    const s = state.suggestions[Number(li.dataset.idx)];
    if (!s) return;
    s.checked = cb.checked;
    li.classList.toggle('is-checked', cb.checked);
    renderGoPickBar();
  });

  $('#chk-go-pick-all').addEventListener('change', e => {
    state.suggestions.forEach(s => { if (!s.registered) s.checked = e.target.checked; });
    renderSuggestions();
  });
  $('#btn-go-pick-add').addEventListener('click', () => registerSongs(state.suggestions, '#btn-go-pick-add', renderSuggestions));

  ['#sel-go-era', '#sel-go-vocal'].forEach(id => $(id).addEventListener('change', savePrefs));

  $('#suggest-list').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const s = state.suggestions[Number(btn.closest('li').dataset.idx)];
    if (!s) return;
    if (btn.dataset.act === 'sing') {
      const ok = await ensureVideo(s, btn);
      if (!ok) return;
      setSong({ videoId: s.videoId, title: s.title, artist: s.artist });
      startWithIntro();
    }
    if (btn.dataset.act === 'search') {
      selectTab('search');
      const q = `${s.title} ${s.artist}`;
      $('#form-search').q.value = q;
      runYouTubeSearch(q);
    }
  });

  $('#sw-listen').addEventListener('click', () => {
    AC.resume().catch(() => {});
    setListening(!state.listening);
  });
}

function setListening(on) {
  if (on) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('このブラウザは音声認識に対応していません（Chrome・Safariの最新版をお使いください）', 'error'); return; }
    if (!state.recog) {
      const r = new SR();
      r.lang = 'ja-JP';
      r.continuous = true;
      r.interimResults = true;
      r.onstart = () => { state.recogRunning = true; updateListenUI(); };
      r.onend = () => {
        state.recogRunning = false;
        updateListenUI();
        if (shouldListen()) setTimeout(updateListening, 400);
      };
      r.onerror = ev => {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          state.listening = false;
          toast('音声認識のためのマイク使用が許可されていません', 'error');
          updateListenUI();
        }
      };
      r.onresult = ev => {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const t = ev.results[i][0].transcript;
          $('#heard').textContent = `聞き取り：${t}`;
          if (TRIGGER_WORDS.test(t)) { onTrigger(); return; }
        }
      };
      state.recog = r;
    }
    state.listening = true;
  } else {
    state.listening = false;
  }
  updateListening();
}

function shouldListen() {
  return state.listening && !Voice.speaking && state.playerState !== YT_STATE.PLAYING && !state.busyOuting && !state.dictating;
}

function updateListening() {
  if (state.recog) {
    if (shouldListen()) {
      if (!state.recogRunning) { try { state.recog.start(); state.recogRunning = true; } catch {} }
    } else if (state.recogRunning) {
      try { state.recog.abort(); } catch {}
    }
  }
  updateListenUI();
}

function updateListenUI() {
  const sw = $('#sw-listen');
  if (!sw) return;
  sw.setAttribute('aria-checked', String(state.listening));
  const st = $('#listen-state');
  let text = 'オフ';
  if (state.listening) {
    if (state.busyOuting) text = '選曲中のため待ち受けを止めています';
    else if (state.dictating) text = '音声入力中のため待ち受けを止めています';
    else if (state.playerState === YT_STATE.PLAYING) text = '再生中のため待ち受けを止めています';
    else if (Voice.speaking) text = 'ナビが話し終わるまで待っています';
    else text = '耳をすませています。「行こう！」と話しかけてください';
  }
  st.textContent = text;
  st.classList.toggle('is-active', state.listening && shouldListen());
  const ear = state.listening && shouldListen();
  $('#btn-go')?.classList.toggle('is-listening', ear);
  $('#fab-go')?.classList.toggle('is-listening', ear);
  const fe = $('#fab-ear');
  if (fe) fe.hidden = !ear;
}

async function onTrigger() {
  const now = Date.now();
  if (now - state.lastTrigger < 6000 || state.busyOuting) return;
  state.lastTrigger = now;
  try { state.recog.abort(); } catch {}
  await chime();
  selectTab('outing');
  runOutingFlow({ autoplay: true });
}

async function chime() {
  try {
    const ctx = await AC.resume();
    const t = ctx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const st = t + i * 0.12;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.25, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(st);
      o.stop(st + 0.4);
    });
    await new Promise(r => setTimeout(r, 450));
  } catch {}
}

/* ---------------------------------------------------------
 * タブ・ヘッダー
 * ------------------------------------------------------- */
function selectTab(name) {
  $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.panel').forEach(p => { p.hidden = p.id !== `panel-${name}`; });
  if (name === 'mic') drawMeter();
}

function bindApp() {
  $$('.tab').forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  $('#sel-character').addEventListener('change', e => {
    state.character = e.target.value;
    renderCharacter();
    Voice.stop();
    showLine(CHARACTERS[state.character].welcome);
    state.prefetch = {};
    if (state.song) state.prefetch.intro = fetchLine('intro');
    if (state.profile) { state.profile.character = state.character; saveSession(); }
    api('updateProfile', { character: state.character }).catch(() => {});
  });

  $('#sel-tts').value = state.ttsMode;
  $('#sel-tts').addEventListener('change', e => {
    state.ttsMode = e.target.value;
    state.prefetch = {};
    if (state.song) state.prefetch.intro = fetchLine('intro');
    savePrefs();
  });

  $('#btn-logout').addEventListener('click', logout);

  // 最初の操作で AudioContext を起こしておく（自動再生制限対策）
  document.addEventListener('pointerdown', () => { AC.resume().catch(() => {}); }, { once: true });

  bindPlayer();
  bindSearch();
  bindMylist();
  bindMic();
  bindOuting();
}

/* ---------------------------------------------------------
 * 起動
 * ------------------------------------------------------- */
async function init() {
  const prefs = loadPrefs();
  if (prefs.ttsMode) state.ttsMode = prefs.ttsMode;
  if (typeof prefs.musicVol === 'number') state.musicVol = prefs.musicVol;
  if (prefs.preset) state.preset = prefs.preset;
  if (prefs.fx) Object.assign(MicFx.p, prefs.fx);
  if (prefs.goEra) $('#sel-go-era').value = prefs.goEra;
  if (prefs.goVocal) $('#sel-go-vocal').value = prefs.goVocal;

  setupPwToggles();
  bindAuth();
  bindApp();
  syncSliders();
  renderMicUI();
  renderNow();
  pickJaVoice();
  loadVersion();

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)); } catch {}
  if (!saved?.token) { showAuth('view-login'); return; }

  state.token = saved.token;
  state.profile = saved.profile;
  try {
    const r = await api('me');
    state.profile = r.profile;
    saveSession();
    if (r.mustReset) showAuth('view-reset'); else enterApp();
  } catch {
    if (state.token) { clearSession(); showAuth('view-login'); }
  }
}

init();
