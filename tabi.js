/* =========================================================
 * UTAGE号 運行モード (tabi.js)
 *  移動しながら歌う「旅モード」
 *   - 速度メーター／移動ペース判定（徒歩〜新幹線）
 *   - 市区町村が変わると駅名標＋ご当地アナウンス、県境突破ボーナス
 *   - 曲が終わると「次の停車駅」カウントダウン→この場所の曲で自動続行
 *   - GPSが途切れたら「トンネル演出」（マイクのエコー増量）
 *   - 終着駅で旅の称号と講評、端末内スタンプ帳
 *  ※ app.js のあとに読み込む（state / api / Voice などを使う）
 *  ※ 位置情報はサーバーに保存しない。端末にも市区町村名だけを保存
 * ========================================================= */
'use strict';

const Tabi = (() => {
  const LOG_KEY = 'utage_tabi_log_v1';
  const CUR_KEY = 'utage_tabi_current_v1';
  const OPT_KEY = 'utage_tabi_opts_v1';
  const PT = { perKm: 10, newCity: 300, newPref: 1000, song: 100 };
  const COUNTDOWN_SEC = 8;
  const TUNNEL_GAP_MS = 20000;   // この時間GPSが途切れたらトンネル判定
  const TUNNEL_MIN_KMH = 30;     // ある程度の速さで走っていた時だけ

  const LINES = {
    depart: {
      mama: 'UTAGE号、発車するわよぉ。窓の外を見ながら、ゆっくり歌っていきましょ。',
      dj: 'UTAGE号、発車オーライ！景色と一緒にボルテージも加速だぜ！',
      pro: 'UTAGE号、運行を開始します。移動距離と歌唱数を記録します。',
    },
    tunnelIn: {
      mama: 'あら、トンネルねぇ。声がよく響くわよ。',
      dj: 'トンネル突入！エコーマシマシでいくぜ！',
      pro: 'トンネルを検知。残響を増やします。',
    },
    tunnelOut: {
      mama: '抜けたわね。また景色が見えてきたわ。',
      dj: 'トンネル脱出！外の空気はうまいぜ！',
      pro: 'トンネルを抜けました。残響を元に戻します。',
    },
    welcome: {
      mama: name => `${name}に入ったわよ。いい街ねぇ。`,
      dj: name => `${name}に到着！この街もアゲていこうぜ！`,
      pro: name => `${name}に入りました。`,
    },
    summary: {
      mama: 'いい旅だったわねぇ。またいつでも乗りにいらっしゃい。',
      dj: '最高の旅だったぜ！次の運行も待ってるからな！',
      pro: '運行を終了しました。記録を保存しました。',
    },
  };

  const t = {
    active: false,
    watchId: null,
    wakeLock: null,
    startedAt: 0,
    prev: null,            // 距離計算用の直前地点 {lat,lng,ts}
    lastFixAt: 0,
    lastGoodKmh: 0,
    kmh: null,
    speeds: [],
    km: 0,
    maxKmh: 0,
    bonus: 0,
    place: null,           // {pref, city, ward}
    stations: [],          // {pref, city, ward, at, yomi, local:{title,artist}, songs:[{title,artist,score}]}
    prefs: [],
    sung: [],
    lastGeo: null,         // {lat,lng,at}
    geocoding: false,
    queue: [],             // 歌い終わるまで待たせるアナウンス
    tunnel: false,
    savedFx: null,
    savedPreset: null,
    countdown: null,
    signTimer: null,
    hudTimer: null,
    autoNext: true,
  };

  const $ = s => document.querySelector(s);
  const ch = () => (LINES.depart[state.character] ? state.character : 'mama');
  const isPlaying = () => state.playerState === YT_STATE.PLAYING;
  const canSpeakNow = () => !isPlaying() && !state.busyOuting && !Voice.speaking && !t.countdown;

  /* ---------------- 計算 ---------------- */
  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function modeOf(kmh) {
    if (kmh === null || kmh === undefined) return { key: 'unknown', ico: '📡', name: '測定中' };
    if (kmh < 1.5) return { key: 'stop', ico: '🛑', name: '停車中' };
    if (kmh < 7) return { key: 'walk', ico: '🚶', name: '徒歩ペース' };
    if (kmh < 25) return { key: 'bike', ico: '🚲', name: '自転車ペース' };
    if (kmh < 80) return { key: 'drive', ico: '🚗', name: 'ドライブペース' };
    if (kmh < 150) return { key: 'express', ico: '🛣️', name: '高速ペース' };
    if (kmh < 330) return { key: 'shinkansen', ico: '🚄', name: '新幹線ペース' };
    return { key: 'sky', ico: '✈️', name: '空の上？' };
  }

  function points() { return t.bonus + Math.floor(t.km * PT.perKm); }
  function minutes() { return t.startedAt ? Math.max(0, Math.round((Date.now() - t.startedAt) / 60000)) : 0; }
  function songCount() { return t.stations.reduce((n, s) => n + s.songs.length, 0); }
  function placeName(p) { return p ? `${p.city || ''}${p.ward || ''}` || p.pref || 'このあたり' : 'このあたり'; }
  function fmtDur(min) { return min >= 60 ? `${Math.floor(min / 60)}時間${min % 60}分` : `${min}分`; }
  function fmtNum(n) { return Number(n || 0).toLocaleString('ja-JP'); }

  /* ---------------- 位置の追跡 ---------------- */
  function onPosition(pos) {
    const c = pos.coords;
    const now = Date.now();
    const wasTunnel = t.tunnel;
    t.lastFixAt = now;
    if (wasTunnel) exitTunnel();

    const cur = { lat: c.latitude, lng: c.longitude, ts: pos.timestamp || now };
    const goodFix = (c.accuracy ?? 999) <= 100;

    let implied = null;
    if (t.prev && goodFix) {
      const d = haversine(t.prev, cur);
      const dt = Math.max(1, (cur.ts - t.prev.ts) / 1000);
      implied = d / dt * 3.6;
      if (implied > 450) {
        // GPSの飛び。距離に入れずに基準点だけ更新
        t.prev = cur;
        implied = null;
      } else if (d >= Math.max(15, (c.accuracy || 0) * 0.6)) {
        t.km += d / 1000;
        t.prev = cur;
      }
    } else if (goodFix) {
      t.prev = cur;
    }

    let kmh = (c.speed !== null && c.speed !== undefined && c.speed >= 0) ? c.speed * 3.6 : implied;
    if (kmh !== null && kmh !== undefined && kmh < 450) {
      t.speeds.push(kmh);
      if (t.speeds.length > 3) t.speeds.shift();
      t.kmh = t.speeds.reduce((a, b) => a + b, 0) / t.speeds.length;
      if (goodFix) t.maxKmh = Math.max(t.maxKmh, t.kmh);
      if (t.kmh >= 5) t.lastGoodKmh = t.kmh;
      else if (t.kmh < 1.5) t.lastGoodKmh = 0;
    }

    if (goodFix) maybeGeocode(cur);
    renderHud();
    saveCurrent();
  }

  function onPosError(err) {
    if (err.code === 1) {
      toast('位置情報が許可されていないため、運行を開始できません', 'error');
      stop({ silent: true });
    }
    // タイムアウト等はトンネル判定に任せる
  }

  async function maybeGeocode(cur) {
    if (t.geocoding) return;
    const now = Date.now();
    const g = t.lastGeo;
    if (g) {
      const d = haversine(g, cur);
      const since = now - g.at;
      const due = (d >= 700 && since >= 40000) || (d >= 200 && since >= 300000);
      if (!due) return;
    }
    t.geocoding = true;
    t.lastGeo = { lat: cur.lat, lng: cur.lng, at: now };
    try {
      const r = await withTimeout(api('tabiPlace', { lat: cur.lat, lng: cur.lng }), 15000);
      if (r.city || r.pref) onPlace({ pref: r.pref || '', city: r.city || '', ward: r.ward || '' });
    } catch (err) {
      console.warn('tabiPlace', err);
    } finally {
      t.geocoding = false;
    }
  }

  function onPlace(p) {
    if (!t.active) return;
    const key = x => `${x.pref}|${x.city}`;
    const first = !t.place;
    const sameCity = t.place && key(t.place) === key(p);

    if (sameCity) {
      if (p.ward && p.ward !== t.place.ward) {
        t.place.ward = p.ward;
        const st = currentStation();
        if (st) st.ward = p.ward;
        renderHud();
        renderRoute();
      }
      return;
    }

    const prev = t.place;
    const visited = t.stations.some(s => key(s) === key(p));
    const newPref = !first && p.pref && !t.prefs.includes(p.pref);
    let gained = 0;
    if (!first && !visited) gained += PT.newCity;
    if (newPref) gained += PT.newPref;
    t.bonus += gained;
    if (p.pref && !t.prefs.includes(p.pref)) t.prefs.push(p.pref);

    t.place = { ...p };
    t.stations.push({ ...p, at: Date.now(), yomi: '', local: null, songs: [] });
    renderHud();
    renderRoute();
    saveCurrent();

    showSign({ name: p.city || p.pref || 'このあたり', ward: p.ward, prev: prev ? placeName(prev) : '', first, crossedPref: newPref, gained, revisit: visited });
    if (newPref || !first) fanfare(newPref);
    requestWelcome(p, prev, { first, crossedPref: newPref });
  }

  function currentStation() { return t.stations[t.stations.length - 1] || null; }

  /* ---------------- ご当地アナウンス ---------------- */
  async function requestWelcome(p, prev, flags) {
    const st = currentStation();
    const fallbackText = LINES.welcome[ch()](placeName(p));
    // 声なし＋ナビ非表示ならAIを呼ばない
    if (state.ttsMode === 'none' && state.naviHidden) return;
    let line = { text: fallbackText, audio: null };
    try {
      const r = await withTimeout(api('tabiLine', {
        kind: 'welcome',
        character: state.character,
        withAudio: useGeminiVoice(),
        place: p,
        prev: prev || null,
        first: !!flags.first,
        crossedPref: !!flags.crossedPref,
        mode: modeOf(t.kmh).name,
      }), CONFIG.AI_TIMEOUT_MS);
      line = { text: r.text || fallbackText, audio: r.audio || null };
      if (st) {
        st.yomi = r.yomi || '';
        if (r.local && r.local.title) st.local = { title: r.local.title, artist: r.local.artist || '' };
        renderRoute();
        updateSignExtras(st);
        saveCurrent();
      }
    } catch (err) {
      console.warn('tabiLine', err);
    }
    announce(line);
  }

  function announce(line) {
    if (!line || !line.text) return;
    if (canSpeakNow()) Voice.say(line.text, line.audio);
    else {
      t.queue.push(line);
      if (t.queue.length > 3) t.queue.shift();
      // 歌っている最中は吹き出しだけ更新（声は曲のあと）
      if (isPlaying()) showLine(line.text);
    }
  }

  async function drainQueue() {
    while (t.queue.length && !isPlaying()) {
      const line = t.queue.shift();
      await Voice.say(line.text, line.audio);
    }
  }

  /* ---------------- 駅名標 ---------------- */
  function showSign({ name, ward, prev, first, crossedPref, gained, revisit }) {
    const el = $('#eki-sign');
    clearTimeout(t.signTimer);
    el.classList.toggle('is-compact', isPlaying());
    el.classList.toggle('is-border', !!crossedPref);
    $('#eki-kicker').textContent = first ? '始発駅' : revisit ? 'おかえりなさい' : 'ようこそ';
    $('#eki-name').textContent = name;
    $('#eki-ward').textContent = ward || '';
    $('#eki-ward').hidden = !ward;
    $('#eki-yomi').textContent = '';
    $('#eki-prev').textContent = prev ? `← ${prev}` : '← 出発';
    $('#eki-badge').hidden = !crossedPref;
    $('#eki-pt').textContent = gained ? `＋${fmtNum(gained)} 旅ポイント` : '';
    $('#eki-local').hidden = true;
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('is-in');
    t.signTimer = setTimeout(hideSign, isPlaying() ? 6000 : 11000);
  }

  function updateSignExtras(st) {
    const el = $('#eki-sign');
    if (el.hidden) return;
    if (st.yomi) $('#eki-yomi').textContent = st.yomi;
    const btn = $('#eki-local');
    if (st.local && !el.classList.contains('is-compact')) {
      btn.textContent = `🎤 ご当地曲「${st.local.title}」を歌う`;
      btn.hidden = false;
    }
  }

  function hideSign() {
    const el = $('#eki-sign');
    el.classList.remove('is-in');
    setTimeout(() => { if (!el.classList.contains('is-in')) el.hidden = true; }, 350);
  }

  async function fanfare(big) {
    try {
      const ctx = await AC.resume();
      const t0 = ctx.currentTime;
      const notes = big ? [523, 659, 784, 1047, 784, 1047] : [784, 988, 1175];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const st = t0 + i * (big ? 0.13 : 0.11);
        o.type = big ? 'square' : 'triangle';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, st);
        g.gain.exponentialRampToValueAtTime(big ? 0.12 : 0.18, st + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, st + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(st);
        o.stop(st + 0.32);
      });
    } catch {}
  }

  /* ---------------- トンネル演出 ---------------- */
  function checkTunnel() {
    if (!t.active || t.tunnel || !t.lastFixAt) return;
    if (Date.now() - t.lastFixAt > TUNNEL_GAP_MS && t.lastGoodKmh >= TUNNEL_MIN_KMH) enterTunnel();
  }

  function enterTunnel() {
    t.tunnel = true;
    if (MicFx.enabled) {
      t.savedFx = { ...MicFx.p };
      t.savedPreset = state.preset;
      MicFx.preset('tunnel');
    }
    renderHud();
    const text = LINES.tunnelIn[ch()];
    if (isPlaying()) showLine(text);
    else if (canSpeakNow()) Voice.say(text);
  }

  function exitTunnel() {
    if (!t.tunnel) return;
    t.tunnel = false;
    if (t.savedFx) {
      const prevSec = MicFx.p.reverbSec;
      Object.assign(MicFx.p, t.savedFx);
      if (MicFx.n && prevSec !== MicFx.p.reverbSec) MicFx.n.conv.buffer = makeImpulse(AC.ctx, MicFx.p.reverbSec);
      MicFx.apply();
      state.preset = t.savedPreset || state.preset;
      t.savedFx = null;
      t.savedPreset = null;
    }
    renderHud();
    const text = LINES.tunnelOut[ch()];
    if (isPlaying()) showLine(text);
    else if (canSpeakNow()) Voice.say(text);
  }

  /* ---------------- 次の停車駅（自動続行） ---------------- */
  function startCountdown() {
    cancelCountdown();
    let n = COUNTDOWN_SEC;
    const el = $('#next-call');
    $('#next-call-place').textContent = `つぎは ${placeName(t.place)} の曲`;
    $('#next-call-num').textContent = String(n);
    el.hidden = false;
    t.countdown = setInterval(() => {
      n--;
      $('#next-call-num').textContent = String(Math.max(0, n));
      if (n <= 0) goNext();
    }, 1000);
  }

  function cancelCountdown() {
    if (t.countdown) clearInterval(t.countdown);
    t.countdown = null;
    $('#next-call').hidden = true;
  }

  function goNext() {
    cancelCountdown();
    if (!t.active) return;
    runOutingFlow({ autoplay: true });
  }

  /* ---------------- app.js から呼ばれるフック ---------------- */
  async function onSongFinished(song, result) {
    if (!t.active) return;
    const st = currentStation();
    const score = result ? result.score : null;
    if (st && song) {
      st.songs.push({ title: song.title || '（曲名不明）', artist: song.artist || '', score: score === null ? null : Math.round(score * 10) / 10 });
    }
    if (song?.title) {
      t.sung.push(song.title);
      if (t.sung.length > 30) t.sung.shift();
    }
    const gained = PT.song + (score === null ? 0 : Math.max(0, Math.round((score - 60) * 5)));
    t.bonus += gained;
    renderHud();
    renderRoute();
    saveCurrent();
    flashPoints(`＋${fmtNum(gained)} 旅ポイント（${st ? placeName(st) : 'このあたり'}で1曲）`);

    await drainQueue();
    if (t.active && t.autoNext && !isPlaying()) startCountdown();
  }

  function requestExtras() {
    if (!t.active) return {};
    const m = modeOf(t.kmh);
    return {
      travel: {
        mode: m.name,
        kmh: t.kmh === null ? null : Math.round(t.kmh),
        km: Math.round(t.km * 10) / 10,
        minutes: minutes(),
        songs: songCount(),
        city: placeName(t.place),
        tunnel: t.tunnel,
      },
      exclude: t.sung.slice(-15),
    };
  }

  function flashPoints(text) {
    const el = $('#cab-flash');
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('is-pop');
    void el.offsetWidth;
    el.classList.add('is-pop');
    clearTimeout(flashPoints._t);
    flashPoints._t = setTimeout(() => { el.hidden = true; }, 3800);
  }

  /* ---------------- 開始・終了 ---------------- */
  async function start({ resume = false } = {}) {
    if (t.active) return;
    if (!navigator.geolocation) { toast('この端末は位置情報に対応していません', 'error'); return; }
    AC.resume().catch(() => {});

    if (resume) {
      const cur = loadCurrent();
      if (cur) Object.assign(t, {
        startedAt: cur.startedAt, km: cur.km, maxKmh: cur.maxKmh, bonus: cur.bonus,
        stations: cur.stations || [], prefs: cur.prefs || [], sung: cur.sung || [], place: cur.place || null,
      });
    } else {
      Object.assign(t, { startedAt: Date.now(), km: 0, maxKmh: 0, bonus: 0, stations: [], prefs: [], sung: [], place: null });
    }
    Object.assign(t, { active: true, prev: null, lastFixAt: 0, lastGoodKmh: 0, kmh: null, speeds: [], lastGeo: null, queue: [], tunnel: false });

    t.watchId = navigator.geolocation.watchPosition(onPosition, onPosError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    t.hudTimer = setInterval(() => { checkTunnel(); renderHud(); }, 3000);
    await requestWakeLock();

    $('#terminal').hidden = true;
    $('#btn-unko-resume').hidden = true;
    renderControls();
    renderHud();
    renderRoute();
    saveCurrent();
    if (!resume) Voice.say(LINES.depart[ch()]);
    else toast('前回の運行を再開しました');
  }

  async function stop({ silent = false } = {}) {
    if (!t.active) return;
    t.active = false;
    if (t.watchId !== null) navigator.geolocation.clearWatch(t.watchId);
    t.watchId = null;
    clearInterval(t.hudTimer);
    exitTunnel();
    cancelCountdown();
    hideSign();
    releaseWakeLock();
    localStorage.removeItem(CUR_KEY);
    renderControls();
    renderHud();
    if (silent) return;

    const trip = {
      id: String(Date.now()),
      start: t.startedAt,
      end: Date.now(),
      km: Math.round(t.km * 10) / 10,
      minutes: minutes(),
      maxKmh: Math.round(t.maxKmh),
      points: points(),
      stations: t.stations.map(s => ({ pref: s.pref, city: s.city, ward: s.ward, songs: s.songs })),
      title: '',
      line: '',
    };
    renderTerminal(trip, true);
    saveTrip(trip);

    let line = { text: LINES.summary[ch()], audio: null };
    if (!(state.ttsMode === 'none' && state.naviHidden)) {
      setNavi(true, '旅をふりかえり中');
      try {
        const r = await withTimeout(api('tabiLine', {
          kind: 'summary',
          character: state.character,
          withAudio: useGeminiVoice(),
          trip: {
            km: trip.km, minutes: trip.minutes, maxKmh: trip.maxKmh, points: trip.points,
            stations: trip.stations.map(s => ({ name: `${s.pref}${s.city}`, songs: s.songs.map(x => ({ title: x.title, score: x.score })) })),
          },
        }), CONFIG.AI_TIMEOUT_MS + 10000);
        trip.title = r.title || '';
        line = { text: r.text || line.text, audio: r.audio || null };
      } catch (err) {
        console.warn('tabi summary', err);
      }
      setNavi(false);
    }
    trip.title = trip.title || autoTitle(trip);
    trip.line = line.text;
    saveTrip(trip);
    renderTerminal(trip, false);
    renderBook();
    selectTab('outing');
    Voice.say(line.text, line.audio);
  }

  function autoTitle(trip) {
    const m = modeOf(trip.maxKmh);
    const head = trip.stations[0]?.city || 'まぼろし';
    return `${head}発 ${m.key === 'walk' ? 'てくてく' : m.key === 'bike' ? 'ペダル' : m.key === 'shinkansen' ? '超特急' : 'うたかた'}号`;
  }

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) t.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  function releaseWakeLock() {
    try { t.wakeLock?.release(); } catch {}
    t.wakeLock = null;
  }

  /* ---------------- 保存（端末内のみ・市区町村名まで） ---------------- */
  function saveCurrent() {
    if (!t.active) return;
    try {
      localStorage.setItem(CUR_KEY, JSON.stringify({
        startedAt: t.startedAt, km: t.km, maxKmh: t.maxKmh, bonus: t.bonus,
        stations: t.stations, prefs: t.prefs, sung: t.sung, place: t.place, savedAt: Date.now(),
      }));
    } catch {}
  }
  function loadCurrent() {
    try {
      const c = JSON.parse(localStorage.getItem(CUR_KEY));
      if (c && Date.now() - (c.savedAt || 0) < 12 * 3600 * 1000) return c;
    } catch {}
    return null;
  }
  function loadLog() {
    try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch { return []; }
  }
  function saveTrip(trip) {
    const log = loadLog().filter(x => x.id !== trip.id);
    log.unshift(trip);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, 30))); } catch {}
  }

  /* ---------------- 描画 ---------------- */
  function renderControls() {
    const b = $('#btn-unko');
    b.classList.toggle('is-running', t.active);
    b.innerHTML = t.active
      ? '<span class="unko-btn-main">終着駅へ</span><span class="unko-btn-sub">運行を終えて旅をふりかえる</span>'
      : '<span class="unko-btn-main">運行開始</span><span class="unko-btn-sub">移動しながら歌う旅モード</span>';
    $('#unko-live').hidden = !t.active;
    $('#cab-hud').hidden = !t.active;
    document.body.classList.toggle('is-unko', t.active);
  }

  function renderHud() {
    if (!t.active) return;
    const m = modeOf(t.kmh);
    const kmh = t.kmh === null ? '--' : String(Math.round(t.kmh));
    $('#cab-kmh').textContent = kmh;
    $('#cab-mode').textContent = t.tunnel ? '🚇 トンネル内' : `${m.ico} ${m.name}`;
    $('#cab-place').textContent = t.place ? placeName(t.place) : '現在地を確認中';
    $('#cab-hud').classList.toggle('is-tunnel', t.tunnel);

    $('#unko-kmh').textContent = kmh;
    $('#unko-mode').textContent = t.tunnel ? '🚇 トンネル内（エコー増量中）' : `${m.ico} ${m.name}`;
    $('#unko-km').textContent = t.km.toFixed(1);
    $('#unko-time').textContent = fmtDur(minutes());
    $('#unko-songs').textContent = String(songCount());
    $('#unko-pt').textContent = fmtNum(points());
  }

  function renderRoute() {
    const list = $('#unko-route');
    if (!t.stations.length) {
      list.innerHTML = '<li class="unko-route-empty">最初の駅（現在地の市区町村）を確認しています…</li>';
      return;
    }
    list.innerHTML = t.stations.map((s, i) => {
      const isCur = i === t.stations.length - 1;
      const songs = s.songs.map(x => `<li>${esc(x.title)}${x.score !== null && x.score !== undefined ? `<span class="unko-score">${esc(x.score)}点</span>` : ''}</li>`).join('');
      return `<li class="unko-st${isCur ? ' is-current' : ''}">
        <span class="unko-st-dot" aria-hidden="true"></span>
        <p class="unko-st-name">${esc(placeName(s))}${s.yomi ? `<span class="unko-st-yomi">${esc(s.yomi)}</span>` : ''}</p>
        <p class="unko-st-pref">${esc(s.pref)}${isCur ? '　いまここ' : ''}</p>
        ${songs ? `<ul class="unko-st-songs">${songs}</ul>` : ''}
        ${s.local ? `<button class="btn btn-sm btn-ghost unko-local" data-idx="${i}">🎤 ご当地曲「${esc(s.local.title)}」</button>` : ''}
      </li>`;
    }).join('');
  }

  function renderTerminal(trip, loading) {
    $('#terminal').hidden = false;
    $('#terminal-title').textContent = loading ? '称号を考え中…' : `「${trip.title}」`;
    $('#terminal-route').textContent = trip.stations.length
      ? trip.stations.map(s => s.city || s.pref).join(' → ')
      : '（駅に停まる前に終着しました）';
    const songs = trip.stations.reduce((n, s) => n + s.songs.length, 0);
    $('#terminal-stats').innerHTML = [
      ['走行距離', `${trip.km}km`],
      ['運行時間', fmtDur(trip.minutes)],
      ['歌った曲', `${songs}曲`],
      ['停車駅', `${trip.stations.length}駅`],
      ['最高速度', `${trip.maxKmh}km/h`],
      ['旅ポイント', `${fmtNum(trip.points)}pt`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('#terminal-line').textContent = loading ? '' : trip.line;
    $('#btn-terminal-share').dataset.id = trip.id;
    $('#terminal').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderBook() {
    const log = loadLog();
    $('#stamp-count').textContent = `${log.length}回`;
    const list = $('#stamp-book');
    if (!log.length) {
      list.innerHTML = '<li class="empty">まだ旅の記録はありません。「運行開始」で最初の旅へ。</li>';
      return;
    }
    list.innerHTML = log.map(trip => {
      const d = new Date(trip.start);
      const songs = trip.stations.reduce((n, s) => n + s.songs.length, 0);
      const route = trip.stations.map(s => s.city || s.pref).join(' → ') || '—';
      return `<li class="stamp">
        <p class="stamp-date">${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}</p>
        <p class="stamp-title">${esc(trip.title || '名もなき旅')}</p>
        <p class="stamp-route">${esc(route)}</p>
        <p class="stamp-meta">${esc(trip.km)}km／${songs}曲／${fmtNum(trip.points)}pt</p>
      </li>`;
    }).join('');
  }

  async function share(id) {
    const trip = loadLog().find(x => x.id === id);
    if (!trip) return;
    const songs = trip.stations.reduce((n, s) => n + s.songs.length, 0);
    const text = `UTAGE号の旅「${trip.title}」\n${trip.stations.map(s => s.city || s.pref).join('→')}\n`
      + `走行${trip.km}km／${songs}曲／${fmtNum(trip.points)}旅ポイント\n#UTAGE号`;
    const url = location.href.split('#')[0];
    try {
      if (navigator.share) { await navigator.share({ title: 'UTAGE号の旅', text, url }); return; }
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('旅の記録をコピーしました');
    } catch (err) {
      if (err?.name !== 'AbortError') toast('シェアできませんでした', 'error');
    }
  }

  async function singLocal(st) {
    if (!st?.local) return;
    const song = { title: st.local.title, artist: st.local.artist };
    const ok = await ensureVideo(song, null);
    if (!ok) return;
    cancelCountdown();
    hideSign();
    setSong({ videoId: song.videoId, title: song.title, artist: song.artist });
    startWithIntro();
  }

  /* ---------------- 初期化 ---------------- */
  function bind() {
    try { t.autoNext = (JSON.parse(localStorage.getItem(OPT_KEY)) || {}).autoNext !== false; } catch {}
    $('#chk-auto-next').checked = t.autoNext;
    $('#chk-auto-next').addEventListener('change', e => {
      t.autoNext = e.target.checked;
      if (!t.autoNext) cancelCountdown();
      try { localStorage.setItem(OPT_KEY, JSON.stringify({ autoNext: t.autoNext })); } catch {}
    });

    $('#btn-unko').addEventListener('click', () => (t.active ? stop() : start()));
    $('#btn-unko-resume').addEventListener('click', () => start({ resume: true }));
    $('#btn-next-now').addEventListener('click', goNext);
    $('#btn-next-cancel').addEventListener('click', () => { cancelCountdown(); toast('ここで停車します。歌いたくなったら「行こう！」'); });
    $('#btn-terminal-share').addEventListener('click', e => share(e.currentTarget.dataset.id));
    $('#btn-terminal-close').addEventListener('click', () => { $('#terminal').hidden = true; });
    $('#eki-local').addEventListener('click', () => singLocal(currentStation()));
    $('#eki-sign').addEventListener('click', e => { if (!e.target.closest('#eki-local')) { clearTimeout(t.signTimer); hideSign(); } });
    $('#unko-route').addEventListener('click', e => {
      const b = e.target.closest('.unko-local');
      if (b) singLocal(t.stations[Number(b.dataset.idx)]);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && t.active) requestWakeLock();
    });

    $('#btn-unko-resume').hidden = !loadCurrent();
    renderControls();
    renderBook();
  }

  bind();

  return { onSongFinished, requestExtras, isActive: () => t.active, start, stop };
})();
window.Tabi = Tabi;
