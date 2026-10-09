/**
 * =========================================================
 *  UTAGE — YouTubeカラオケ  バックエンド (Google Apps Script)
 *  - 会員認証（仮パスワード / SHA-256+salt+pepper / ロック）
 *  - お気に入り（十八番・キー・練習メモ）
 *  - Gemini：キャラ別セリフ生成 + Gemini TTS 音声合成
 *  - GPS（逆ジオコーディング）→ Gemini選曲 → YouTube検索
 *
 *  スクリプトプロパティ:
 *    GEMINI_API_KEY   (必須)
 *    YOUTUBE_API_KEY  (必須：曲検索・GPS選曲の動画特定)
 *    PEPPER           (setup() で自動生成。後から変更しないこと)
 *    APP_URL          (任意：メールに載せるURL)
 *    SPREADSHEET_ID   (任意：スタンドアロンGASの場合)
 *    TEXT_MODEL       (任意：既定 gemini-2.5-flash)
 *    TTS_MODEL        (任意：既定 gemini-2.5-flash-preview-tts)
 *    VOICE_MAMA / VOICE_DJ / VOICE_PRO (任意：TTSボイス名の上書き)
 *    AI_DAILY_LIMIT   (任意：1ユーザーあたりAI呼び出し上限 既定300)
 * =========================================================
 */

const APP_NAME = 'UTAGE';
// サーバー側のバージョン：Code.gs を直したら上げて「新バージョン」で再デプロイ
const APP_VERSION = '1.2.0';
const APP_UPDATED = '2026-10-09';
const SHEETS = { USERS: 'users', FAVS: 'favorites' };
const USER_COLS = ['email', 'passwordHash', 'salt', 'status', 'mustReset', 'nickname', 'character',
  'failCount', 'lockedUntil', 'createdAt', 'updatedAt', 'lastLoginAt'];
const FAV_COLS = ['id', 'email', 'videoId', 'title', 'artist', 'keyShift', 'memo', 'isOhako', 'createdAt', 'updatedAt'];
// 文字列として保持したい列（数値・指数表記への自動変換を防ぐ）
const TEXT_COLS = { users: ['email', 'passwordHash', 'salt'], favorites: ['id', 'email', 'videoId'] };

const SESSION_TTL = 21600;   // 6時間（アクセスごとに延長）
const MAX_FAIL = 5;
const LOCK_MINUTES = 15;
const MAX_FAVS = 300;
const STATUS = { TEMP: '仮登録', ACTIVE: '有効', STOP: '停止' };
const ERAS = {
  '1960s': '1960年代', '1970s': '1970年代', '1980s': '1980年代', '1990s': '1990年代',
  '2000s': '2000年代', '2010s': '2010年代', '2020s': '2020年代'
};
const VOCALS = { female: '女性ボーカル', male: '男性ボーカル', duet: '男女デュエット', group: 'グループ・合唱' };

const PERSONAS = {
  mama: {
    name: 'スナックのママ・百合子',
    voice: 'Sulafat',
    style: '昭和レトロなスナックのママとして、落ち着いた低めの声で、温かく少し色っぽく、ゆったりと話してください',
    persona: '昭和から続く路地裏のスナックのママ。一人称は「あたし」、相手を「あなた」と呼ぶ。語尾は「〜ねぇ」「〜のよ」「〜かしら」。包容力があって褒め上手、少し艶っぽい。昭和歌謡と演歌に詳しい。'
  },
  dj: {
    name: '熱血ライブDJ・ジョー',
    voice: 'Fenrir',
    style: 'テンションMAXのライブDJとして、ハイテンションで早口に、観客を煽るように勢いよく話してください',
    persona: 'フェスを沸かせる熱血ライブDJ。一人称は「オレ」。「Yeah!!」「神曲キター！」「ぶっ飛ばしていこうぜ！」のように英語混じりで煽る。とにかくポジティブで勢いがある。'
  },
  pro: {
    name: '辛口AIプロデューサー・K-01',
    voice: 'Charon',
    style: 'クールで辛口なAIプロデューサーとして、感情を抑えた無機質なアナウンス調で、淡々と明瞭に話してください',
    persona: '冷静沈着なAI音楽プロデューサー。です・ます調。感情を表に出さず、リズム・ブレス・発声・抑揚など技術的で具体的な指摘をする。褒めるときも控えめ。「85点以上を目指しましょう」のように数値目標を好む。'
  }
};

/* ---------------------------------------------------------
 * エントリポイント
 * ------------------------------------------------------- */
function doGet() {
  return json_({ ok: true, app: APP_NAME, version: APP_VERSION, updated: APP_UPDATED, message: 'UTAGE API is running' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e && e.postData ? e.postData.contents : '{}');
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの形式が正しくありません' });
  }
  const action = String(req.action || '');

  const PUBLIC = {
    version: version_,
    register: register_,
    login: login_,
    forgotPassword: forgotPassword_
  };
  const PRIVATE = {
    me: me_,
    logout: logout_,
    setPassword: setPassword_,
    updateProfile: updateProfile_,
    listFavorites: listFavorites_,
    saveFavorite: saveFavorite_,
    deleteFavorite: deleteFavorite_,
    aiSpeak: aiSpeak_,
    tts: tts_,
    suggestByLocation: suggestByLocation_,
    searchVideos: searchVideos_,
    aiPickSongs: aiPickSongs_,
    resolveVideos: resolveVideos_,
    addSongsToMylist: addSongsToMylist_
  };

  try {
    if (PUBLIC[action]) return json_(PUBLIC[action](req));
    if (!PRIVATE[action]) throw appError_('不明な操作です: ' + action);
    const sess = requireSession_(req.token);
    if (sess.mustReset && ['setPassword', 'logout', 'me'].indexOf(action) === -1) {
      throw appError_('先に新しいパスワードを設定してください', 'NEED_RESET');
    }
    return json_(PRIVATE[action](req, sess));
  } catch (err) {
    console.error(action, err && err.stack ? err.stack : err);
    return json_({ ok: false, error: (err && err.message) || String(err), code: (err && err.code) || '' });
  }
}

/* ---------------------------------------------------------
 * バージョン
 * ------------------------------------------------------- */
function version_() {
  return { ok: true, app: APP_NAME, version: APP_VERSION, updated: APP_UPDATED };
}

/* ---------------------------------------------------------
 * 認証
 * ------------------------------------------------------- */
function register_(req) {
  const email = normEmail_(req.email);
  const nickname = String(req.nickname || '').trim().slice(0, 20);
  if (!isEmail_(email)) throw appError_('メールアドレスの形式が正しくありません');
  if (!nickname) throw appError_('ニックネームを入力してください');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const f = findUser_(email);
    if (f.user && f.user.status === STATUS.ACTIVE) {
      throw appError_('このメールアドレスは登録済みです。パスワードがわからない場合は「パスワードを忘れた」から再発行してください');
    }
    if (f.user && f.user.status === STATUS.STOP) throw appError_('このアカウントは利用停止中です');

    const temp = tempPassword_();
    const salt = newSalt_();
    const now = new Date();
    if (f.user) {
      Object.assign(f.user, {
        passwordHash: hash_(temp, salt), salt: salt, nickname: nickname, mustReset: true,
        failCount: 0, lockedUntil: '', updatedAt: now
      });
      writeUser_(f.sh, f.rowNum, f.user);
    } else {
      const user = {
        email: email, passwordHash: hash_(temp, salt), salt: salt, status: STATUS.TEMP, mustReset: true,
        nickname: nickname, character: 'mama', failCount: 0, lockedUntil: '',
        createdAt: now, updatedAt: now, lastLoginAt: ''
      };
      f.sh.appendRow(toRow_(USER_COLS, user));
    }
    sendTempPassword_(email, nickname, temp, false);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, message: '仮パスワードをメールで送りました。メールを確認してログインしてください' };
}

function login_(req) {
  const email = normEmail_(req.email);
  const pw = String(req.password || '');
  if (!email || !pw) throw appError_('メールアドレスとパスワードを入力してください');
  const NG = 'メールアドレスまたはパスワードが違います';

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const f = findUser_(email);
    const u = f.user;
    if (!u) throw appError_(NG);
    if (u.status === STATUS.STOP) throw appError_('このアカウントは利用停止中です');

    const now = new Date();
    if (u.lockedUntil && new Date(u.lockedUntil) > now) {
      const m = Math.ceil((new Date(u.lockedUntil) - now) / 60000);
      throw appError_('ログインに' + MAX_FAIL + '回失敗したため、あと' + m + '分ログインできません');
    }

    if (hash_(pw, String(u.salt)) !== String(u.passwordHash)) {
      u.failCount = Number(u.failCount || 0) + 1;
      let msg = NG + '（あと' + (MAX_FAIL - u.failCount) + '回でロックされます）';
      if (u.failCount >= MAX_FAIL) {
        u.lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60000);
        u.failCount = 0;
        msg = NG + '。' + LOCK_MINUTES + '分間ログインをロックしました';
      }
      u.updatedAt = now;
      writeUser_(f.sh, f.rowNum, u);
      throw appError_(msg);
    }

    u.failCount = 0;
    u.lockedUntil = '';
    u.lastLoginAt = now;
    writeUser_(f.sh, f.rowNum, u);

    const mustReset = u.status === STATUS.TEMP || isTrue_(u.mustReset);
    const token = createSession_(u, mustReset);
    return { ok: true, token: token, mustReset: mustReset, profile: profile_(u) };
  } finally {
    lock.releaseLock();
  }
}

function forgotPassword_(req) {
  const email = normEmail_(req.email);
  if (!isEmail_(email)) throw appError_('メールアドレスの形式が正しくありません');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const f = findUser_(email);
    if (f.user && f.user.status !== STATUS.STOP) {
      const temp = tempPassword_();
      const salt = newSalt_();
      Object.assign(f.user, {
        passwordHash: hash_(temp, salt), salt: salt, mustReset: true,
        failCount: 0, lockedUntil: '', updatedAt: new Date()
      });
      writeUser_(f.sh, f.rowNum, f.user);
      sendTempPassword_(email, f.user.nickname, temp, true);
    }
  } finally {
    lock.releaseLock();
  }
  // 登録有無を推測されないよう、常に同じ応答
  return { ok: true, message: '登録済みのアドレスであれば、新しい仮パスワードを送りました' };
}

function setPassword_(req, sess) {
  const pw = String(req.newPassword || '');
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    throw appError_('パスワードは英字と数字を含む8文字以上にしてください');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let u;
  try {
    const f = findUser_(sess.email);
    if (!f.user) throw appError_('ユーザーが見つかりません', 'SESSION_EXPIRED');
    u = f.user;
    const salt = newSalt_();
    Object.assign(u, {
      passwordHash: hash_(pw, salt), salt: salt, status: STATUS.ACTIVE, mustReset: false, updatedAt: new Date()
    });
    writeUser_(f.sh, f.rowNum, u);
  } finally {
    lock.releaseLock();
  }
  updateSession_(sess, { mustReset: false });
  return { ok: true, profile: profile_(u) };
}

function me_(req, sess) {
  const f = findUser_(sess.email);
  if (!f.user) throw appError_('ユーザーが見つかりません', 'SESSION_EXPIRED');
  return { ok: true, profile: profile_(f.user), mustReset: !!sess.mustReset };
}

function logout_(req, sess) {
  CacheService.getScriptCache().remove('sess_' + sess.token);
  return { ok: true };
}

function updateProfile_(req, sess) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let u;
  try {
    const f = findUser_(sess.email);
    if (!f.user) throw appError_('ユーザーが見つかりません', 'SESSION_EXPIRED');
    u = f.user;
    if (req.nickname !== undefined) {
      const n = String(req.nickname).trim().slice(0, 20);
      if (!n) throw appError_('ニックネームを入力してください');
      u.nickname = n;
    }
    if (req.character !== undefined && PERSONAS[req.character]) u.character = req.character;
    u.updatedAt = new Date();
    writeUser_(f.sh, f.rowNum, u);
  } finally {
    lock.releaseLock();
  }
  updateSession_(sess, { nickname: u.nickname });
  return { ok: true, profile: profile_(u) };
}

function profile_(u) {
  return { email: u.email, nickname: u.nickname, character: PERSONAS[u.character] ? u.character : 'mama' };
}

/* ---------------------------------------------------------
 * お気に入り（マイリスト）
 * ------------------------------------------------------- */
function listFavorites_(req, sess) {
  const all = readAll_(SHEETS.FAVS, FAV_COLS);
  const favs = all.rows
    .filter(function (r) { return normEmail_(r.obj.email) === sess.email; })
    .map(function (r) { return favOut_(r.obj); })
    .sort(function (a, b) {
      if (a.isOhako !== b.isOhako) return a.isOhako ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  return { ok: true, favorites: favs };
}

function saveFavorite_(req, sess) {
  const f = req.fav || {};
  const videoId = String(f.videoId || '');
  if (!/^[\w-]{11}$/.test(videoId)) throw appError_('動画IDが正しくありません');
  const title = String(f.title || '').trim().slice(0, 120) || '（曲名未設定）';
  const artist = String(f.artist || '').trim().slice(0, 80);
  const keyShift = Math.max(-12, Math.min(12, Math.round(Number(f.keyShift) || 0)));
  const memo = String(f.memo || '').slice(0, 500);
  const isOhako = !!f.isOhako;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const all = readAll_(SHEETS.FAVS, FAV_COLS);
    const mine = all.rows.filter(function (r) { return normEmail_(r.obj.email) === sess.email; });
    let hit = null;
    if (f.id) hit = mine.find(function (r) { return String(r.obj.id) === String(f.id); }) || null;
    if (!hit) hit = mine.find(function (r) { return String(r.obj.videoId) === videoId; }) || null;

    const now = new Date();
    let obj;
    if (hit) {
      obj = Object.assign(hit.obj, { videoId: videoId, title: title, artist: artist, keyShift: keyShift, memo: memo, isOhako: isOhako, updatedAt: now });
      all.sh.getRange(hit.rowNum, 1, 1, FAV_COLS.length).setValues([toRow_(FAV_COLS, obj)]);
    } else {
      if (mine.length >= MAX_FAVS) throw appError_('マイリストは' + MAX_FAVS + '曲までです。不要な曲を削除してください');
      obj = {
        id: Utilities.getUuid(), email: sess.email, videoId: videoId, title: title, artist: artist,
        keyShift: keyShift, memo: memo, isOhako: isOhako, createdAt: now, updatedAt: now
      };
      all.sh.appendRow(toRow_(FAV_COLS, obj));
    }
    return { ok: true, fav: favOut_(obj) };
  } finally {
    lock.releaseLock();
  }
}

function deleteFavorite_(req, sess) {
  const id = String(req.id || '');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const all = readAll_(SHEETS.FAVS, FAV_COLS);
    const hit = all.rows.find(function (r) {
      return String(r.obj.id) === id && normEmail_(r.obj.email) === sess.email;
    });
    if (!hit) throw appError_('対象の曲が見つかりません');
    all.sh.deleteRow(hit.rowNum);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function favOut_(o) {
  return {
    id: String(o.id), videoId: String(o.videoId), title: String(o.title || ''), artist: String(o.artist || ''),
    keyShift: Number(o.keyShift) || 0, memo: String(o.memo || ''), isOhako: isTrue_(o.isOhako),
    updatedAt: o.updatedAt ? new Date(o.updatedAt).getTime() : 0
  };
}

/* ---------------------------------------------------------
 * AIナビ（セリフ生成 + TTS）
 * ------------------------------------------------------- */
function aiSpeak_(req, sess) {
  checkAiQuota_(sess.email);
  const ch = PERSONAS[req.character] ? req.character : 'mama';
  const scene = ['intro', 'interlude', 'outro', 'chat'].indexOf(req.scene) >= 0 ? req.scene : 'chat';
  const text = buildLine_(ch, scene, req, sess.nickname || 'お客');
  if (!text) throw appError_('セリフを生成できませんでした');

  let audio = null, ttsError = '';
  if (req.withAudio) {
    try { audio = geminiTts_(text, ch); } catch (e) { ttsError = e.message; }
  }
  return { ok: true, text: text, audio: audio, ttsError: ttsError };
}

function tts_(req, sess) {
  checkAiQuota_(sess.email);
  const ch = PERSONAS[req.character] ? req.character : 'mama';
  const text = String(req.text || '').slice(0, 300);
  if (!text) throw appError_('読み上げる文章がありません');
  return { ok: true, audio: geminiTts_(text, ch) };
}

function buildLine_(ch, scene, req, nickname) {
  const p = PERSONAS[ch];
  const song = req.song || {};
  const songTxt = song.title
    ? '曲名：「' + clip_(song.title, 80) + '」' + (song.artist ? '／歌手：' + clip_(song.artist, 40) : '')
    : '曲名：不明';
  const k = Number(song.keyShift) || 0;
  const keyTxt = k ? 'キー設定：' + (k > 0 ? '+' + k : String(k)) : '';
  const memoTxt = song.memo ? '本人の練習メモ：' + clip_(song.memo, 100) : '';

  let task;
  if (scene === 'intro') {
    task = 'これから' + nickname + 'さんがこの曲を歌います。曲紹介をしてください。曲の魅力や時代の空気にさらっと触れ、歌い方のコツを一つ添え、最後は歌い出しを促す。70文字以内。'
      + (keyTxt ? 'キー設定にも軽く触れてよい。' : '')
      + (memoTxt ? '練習メモを踏まえたアドバイスにする。' : '');
  } else if (scene === 'interlude') {
    task = 'いま曲の間奏中です。歌っている人を盛り上げる合いの手・応援を一言。25文字以内。曲名は言わない。';
  } else if (scene === 'outro') {
    const sc = req.score;
    const st = req.stats || {};
    if (sc === null || sc === undefined || sc === '') {
      task = '曲が終わりました。今回はマイクOFFのため採点なし。選曲をねぎらい、次はマイクをONにして歌うよう誘う。80文字以内。';
    } else {
      task = '曲が終わりました。採点結果は' + sc + '点（声を出していた割合' + (st.voicedPct || '?') + '%、声量の安定感は「' + (st.stability || '?') + '」）。'
        + '点数を読み上げ、キャラクターらしく講評し、次の一曲への一言で締める。100文字以内。';
    }
  } else {
    task = nickname + 'さんにひとこと話しかけてください。40文字以内。';
  }

  const sys = 'あなたはカラオケアプリ「UTAGE」の案内役キャラクター「' + p.name + '」です。\n'
    + '人物設定：' + p.persona + '\n'
    + '出力ルール：セリフの本文だけを出力する。かっこ書き・ト書き・絵文字・記号の装飾・改行・前置きは書かない。音声で読み上げられるので自然な話し言葉にする。';
  const user = [task, songTxt, keyTxt, memoTxt].filter(String).join('\n');
  return cleanLine_(geminiText_(sys, user, { temperature: 1.0 }));
}

/* ---------------------------------------------------------
 * GPS連動「お出かけ選曲」
 * ------------------------------------------------------- */
function suggestByLocation_(req, sess) {
  checkAiQuota_(sess.email);
  const lat = Number(req.lat), lng = Number(req.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw appError_('位置情報が正しくありません');
  }
  const ch = PERSONAS[req.character] ? req.character : 'mama';
  const p = PERSONAS[ch];

  let address = '';
  try {
    const g = Maps.newGeocoder().setLanguage('ja').reverseGeocode(lat, lng);
    if (g && g.status === 'OK' && g.results && g.results.length) address = g.results[0].formatted_address;
  } catch (e) {
    console.warn('reverseGeocode', e);
  }

  const speed = (req.speed !== null && req.speed !== undefined && Number(req.speed) >= 0)
    ? Math.round(Number(req.speed) * 3.6) : null;
  const now = new Date();
  const month = Number(Utilities.formatDate(now, 'Asia/Tokyo', 'M'));
  const season = month <= 2 || month === 12 ? '冬' : month <= 5 ? '春' : month <= 8 ? '夏' : '秋';
  const dateStr = Utilities.formatDate(now, 'Asia/Tokyo', 'M月d日 H時m分');
  const note = clip_(String(req.note || ''), 80);

  const sys = 'あなたはカラオケアプリ「UTAGE」の案内役キャラクター「' + p.name + '」です。\n'
    + '人物設定：' + p.persona + '\n'
    + 'あなたは、その場所とシチュエーションにぴったりのカラオケ曲を選ぶ名人でもあります。';
  const user = '現在地の情報：\n'
    + '- 住所（逆ジオコーディング）：' + (address || '取得できず') + '\n'
    + '- 緯度経度（概算）：' + lat.toFixed(3) + ', ' + lng.toFixed(3) + '\n'
    + '- 移動速度：' + (speed === null ? '不明' : speed + 'km/h') + '\n'
    + '- 日時：' + dateStr + '（' + season + '）\n'
    + '- 本人のひとこと：' + (note || 'なし') + '\n\n'
    + 'この場所が「海沿い・山道・街中・田園・観光地や旅先・自宅周辺・移動中の車内」などのどれに近いかを推定し、'
    + 'その場のムードにぴったりの、日本で有名なカラオケ定番曲を5曲選んでください。実在する曲名と歌手名を正確に書き、年代はばらけさせること。\n'
    + 'area：「横浜・みなとみらい周辺」程度の大まかな地名（番地や建物名は書かない）\n'
    + 'scene：推定した環境（例：海沿い）\n'
    + 'mood：その場のムードを一言で\n'
    + 'comment：キャラクターの口調で、場所の雰囲気に触れながら選曲を紹介するセリフ（70文字以内、読み上げ用、絵文字なし）\n'
    + 'songs[].reason：その曲を選んだ理由（30文字以内）';

  const schema = {
    type: 'OBJECT',
    properties: {
      area: { type: 'STRING' },
      scene: { type: 'STRING' },
      mood: { type: 'STRING' },
      comment: { type: 'STRING' },
      songs: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { title: { type: 'STRING' }, artist: { type: 'STRING' }, reason: { type: 'STRING' } },
          required: ['title', 'artist', 'reason']
        }
      }
    },
    required: ['area', 'scene', 'mood', 'comment', 'songs']
  };

  let out;
  try {
    out = JSON.parse(geminiText_(sys, user, { json: true, schema: schema, temperature: 0.9 }));
  } catch (e) {
    throw appError_('選曲の生成に失敗しました。もう一度お試しください');
  }
  const songs = (out.songs || []).slice(0, 5).map(function (s) {
    return { title: clip_(s.title, 80), artist: clip_(s.artist, 40), reason: clip_(s.reason, 60) };
  });

  // YouTube でカラオケ動画を並列検索（キー未設定でも提案だけは返す）
  try { ytResolve_(songs); } catch (e) { console.warn('ytResolve', e); }

  const comment = cleanLine_(out.comment || '');
  let audio = null;
  if (req.withAudio && comment) {
    try { audio = geminiTts_(comment, ch); } catch (e) { console.warn('tts', e); }
  }
  // 位置情報はスプレッドシートに保存しない
  return {
    ok: true, area: clip_(out.area, 40), scene: clip_(out.scene, 20), mood: clip_(out.mood, 30),
    comment: comment, songs: songs, audio: audio
  };
}

/* ---------------------------------------------------------
 * AI選曲（キーワード・年代・ボーカル）
 * ------------------------------------------------------- */
function aiPickSongs_(req, sess) {
  checkAiQuota_(sess.email);
  const keyword = clip_(String(req.keyword || '').trim(), 100);
  const era = ERAS[req.era] || '';
  const vocal = VOCALS[req.vocal] || '';
  const count = Math.max(3, Math.min(15, Number(req.count) || 10));
  if (!keyword && !era && !vocal) throw appError_('キーワード・年代・ボーカルのどれかを指定してください');

  const sys = 'あなたは日本のカラオケ事情に詳しい選曲の専門家です。実在する曲だけを、正確な曲名と歌手名で答えます。';
  const user = '次の条件に合うカラオケ曲を' + count + '曲選んでください。\n'
    + '- キーワード（話し言葉の場合あり）：' + (keyword || '指定なし') + '\n'
    + '- 年代：' + (era || '指定なし') + '\n'
    + '- ボーカル：' + (vocal || '指定なし') + '\n\n'
    + 'ルール：\n'
    + '・キーワードの中に年代やボーカルの指定が含まれていれば、そちらを優先する\n'
    + '・キーワードが特定の曲名なら、その曲を1曲目にし、残りは雰囲気の近い曲にする\n'
    + '・キーワードが歌手名なら、その歌手の代表曲を中心にする\n'
    + '・YouTubeでカラオケ音源が見つかりやすい有名曲を優先する\n'
    + '・同じ曲を重複させない\n'
    + 'year：発売年（西暦の数値）\n'
    + 'vocal：「女性」「男性」「デュエット」「グループ」のいずれか\n'
    + 'reason：選んだ理由（30文字以内）';
  const schema = {
    type: 'OBJECT',
    properties: {
      songs: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' }, artist: { type: 'STRING' }, year: { type: 'INTEGER' },
            vocal: { type: 'STRING' }, reason: { type: 'STRING' }
          },
          required: ['title', 'artist', 'year', 'vocal', 'reason']
        }
      }
    },
    required: ['songs']
  };

  let out;
  try {
    out = JSON.parse(geminiText_(sys, user, { json: true, schema: schema, temperature: 0.8, maxTokens: 4096 }));
  } catch (e) {
    throw appError_('AI選曲に失敗しました。もう一度お試しください');
  }
  const seen = {};
  const songs = (out.songs || []).map(function (s) {
    return {
      title: clip_(s.title, 80), artist: clip_(s.artist, 40),
      year: Number(s.year) || '', vocal: clip_(s.vocal, 10), reason: clip_(s.reason, 60)
    };
  }).filter(function (s) {
    const k = (s.title + '|' + s.artist).replace(/\s/g, '');
    if (!s.title || seen[k]) return false;
    seen[k] = true;
    return true;
  }).slice(0, count);

  return { ok: true, songs: songs, condition: [era, vocal, keyword].filter(String).join('／') };
}

/** 曲名＋歌手名からカラオケ動画を探す（1回で最大10曲） */
function resolveVideos_(req, sess) {
  const songs = (req.songs || []).slice(0, 10).map(function (s) {
    return { title: clip_(String(s.title || '').trim(), 120), artist: clip_(String(s.artist || '').trim(), 80) };
  }).filter(function (s) { return s.title; });
  if (!songs.length) throw appError_('曲が指定されていません');
  ytResolve_(songs);
  return { ok: true, songs: songs };
}

/** チェックした曲をまとめてマイリストに登録（動画IDが無ければ検索して補完） */
function addSongsToMylist_(req, sess) {
  const items = (req.items || []).slice(0, 20).map(function (s) {
    const vid = String(s.videoId || '');
    return {
      title: clip_(String(s.title || '').trim(), 120),
      artist: clip_(String(s.artist || '').trim(), 80),
      videoId: /^[\w-]{11}$/.test(vid) ? vid : ''
    };
  }).filter(function (s) { return s.title; });
  if (!items.length) throw appError_('登録する曲を選んでください');

  ytResolve_(items);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const all = readAll_(SHEETS.FAVS, FAV_COLS);
    const mine = all.rows.filter(function (r) { return normEmail_(r.obj.email) === sess.email; });
    const have = {};
    mine.forEach(function (r) { have[String(r.obj.videoId)] = true; });
    let count = mine.length;
    const now = new Date();
    const rows = [], added = [], skipped = [];

    items.forEach(function (s) {
      if (!s.videoId) { skipped.push({ title: s.title, artist: s.artist, reason: '動画が見つかりません' }); return; }
      if (have[s.videoId]) { skipped.push({ title: s.title, artist: s.artist, reason: '登録済み' }); return; }
      if (count >= MAX_FAVS) { skipped.push({ title: s.title, artist: s.artist, reason: '登録上限' }); return; }
      const obj = {
        id: Utilities.getUuid(), email: sess.email, videoId: s.videoId, title: s.title, artist: s.artist,
        keyShift: 0, memo: '', isOhako: false, createdAt: now, updatedAt: now
      };
      rows.push(toRow_(FAV_COLS, obj));
      added.push(favOut_(obj));
      have[s.videoId] = true;
      count++;
    });

    if (rows.length) {
      all.sh.getRange(all.sh.getLastRow() + 1, 1, rows.length, FAV_COLS.length).setValues(rows);
    }
    return { ok: true, added: added, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------
 * YouTube 検索
 * ------------------------------------------------------- */
/** songs[i].videoId が空のものだけ並列検索して埋める */
function ytResolve_(songs) {
  const key = prop_('YOUTUBE_API_KEY');
  if (!key) throw appError_('YOUTUBE_API_KEY が未設定です（管理者向け）');
  const targets = songs.filter(function (s) { return !s.videoId; });
  if (!targets.length) return songs;
  const resps = UrlFetchApp.fetchAll(targets.map(function (s) {
    return { url: ytSearchUrl_(s.title + ' ' + (s.artist || '') + ' カラオケ', 1, key), muteHttpExceptions: true };
  }));
  resps.forEach(function (r, i) {
    if (r.getResponseCode() !== 200) return;
    const items = JSON.parse(r.getContentText()).items || [];
    if (items[0] && items[0].id && items[0].id.videoId) {
      targets[i].videoId = items[0].id.videoId;
      targets[i].videoTitle = decodeHtml_(items[0].snippet.title);
    }
  });
  return songs;
}

function searchVideos_(req) {
  const q = String(req.q || '').trim().slice(0, 100);
  if (!q) throw appError_('検索ワードを入力してください');
  const key = prop_('YOUTUBE_API_KEY');
  if (!key) throw appError_('YOUTUBE_API_KEY が未設定です（管理者向け）');
  const query = req.karaoke ? q + ' カラオケ' : q;
  const res = UrlFetchApp.fetch(ytSearchUrl_(query, 12, key), { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) {
    throw appError_('YouTube検索に失敗しました：' + (data.error && data.error.message ? data.error.message : res.getResponseCode()));
  }
  const items = (data.items || []).filter(function (it) { return it.id && it.id.videoId; }).map(function (it) {
    return {
      videoId: it.id.videoId,
      title: decodeHtml_(it.snippet.title),
      channel: decodeHtml_(it.snippet.channelTitle)
    };
  });
  return { ok: true, items: items };
}

function ytSearchUrl_(q, n, key) {
  return 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true'
    + '&maxResults=' + n + '&regionCode=JP&relevanceLanguage=ja&safeSearch=moderate'
    + '&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(key);
}

/* ---------------------------------------------------------
 * Gemini 呼び出し
 * ------------------------------------------------------- */
function geminiText_(systemText, userText, opts) {
  opts = opts || {};
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw appError_('GEMINI_API_KEY が未設定です（管理者向け）');
  const model = prop_('TEXT_MODEL') || 'gemini-2.5-flash';
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: opts.temperature === undefined ? 1.0 : opts.temperature,
      maxOutputTokens: opts.maxTokens || 2048
    }
  };
  if (opts.json) {
    body.generationConfig.responseMimeType = 'application/json';
    if (opts.schema) body.generationConfig.responseSchema = opts.schema;
  }
  // 2.5 Flash は思考をオフにして応答を速くする
  if (/2\.5-flash/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
    {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body)
    }
  );
  const code = res.getResponseCode();
  const data = JSON.parse(res.getContentText());
  if (code !== 200) {
    throw appError_('Gemini APIエラー(' + code + ')：' + (data.error && data.error.message ? data.error.message : ''));
  }
  const cand = data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts ? cand.content.parts : [];
  return parts.filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('').trim();
}

function geminiTts_(text, character) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw appError_('GEMINI_API_KEY が未設定です（管理者向け）');
  const model = prop_('TTS_MODEL') || 'gemini-2.5-flash-preview-tts';
  const p = PERSONAS[character] || PERSONAS.mama;
  const voice = prop_('VOICE_' + String(character).toUpperCase()) || p.voice;

  const body = {
    contents: [{ parts: [{ text: p.style + ':\n' + text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  };
  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
    {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body)
    }
  );
  const code = res.getResponseCode();
  const data = JSON.parse(res.getContentText());
  if (code !== 200) {
    throw appError_('Gemini TTSエラー(' + code + ')：' + (data.error && data.error.message ? data.error.message : ''));
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const inline = parts.map(function (p) { return p.inlineData; }).filter(Boolean)[0];
  if (!inline || !inline.data) throw appError_('音声データが返されませんでした');
  // 例: mimeType = "audio/L16;codec=pcm;rate=24000"（フロントでPCM→AudioBufferに変換）
  return { data: inline.data, mimeType: inline.mimeType || 'audio/L16;rate=24000' };
}

function checkAiQuota_(email) {
  const limit = Number(prop_('AI_DAILY_LIMIT') || 300);
  const key = 'ai_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd') + '_' + email;
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(key) || 0) + 1;
  if (n > limit) throw appError_('本日のAI利用回数の上限に達しました。また明日どうぞ');
  cache.put(key, String(n), 21600);
}

/* ---------------------------------------------------------
 * メール
 * ------------------------------------------------------- */
function sendTempPassword_(email, nickname, temp, isReset) {
  const url = prop_('APP_URL') || '';
  const subject = isReset ? '【UTAGE】仮パスワード再発行のお知らせ' : '【UTAGE】仮登録のお知らせ';
  const body = (nickname ? nickname + ' さん\n\n' : '')
    + (isReset ? 'パスワード再発行のご依頼を受け付けました。\n' : 'UTAGE（YouTubeカラオケ）への仮登録ありがとうございます。\n')
    + '下記の仮パスワードでログインしてください。\n\n'
    + '仮パスワード：' + temp + '\n\n'
    + 'ログインすると、新しいパスワードの設定画面が表示されます。\n'
    + (url ? url + '\n' : '')
    + '\n※このメールにお心当たりがない場合は、破棄してください。\n';
  MailApp.sendEmail({ to: email, subject: subject, body: body, name: 'UTAGE カラオケ' });
}

/* ---------------------------------------------------------
 * セッション
 * ------------------------------------------------------- */
function createSession_(user, mustReset) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  const sess = { email: normEmail_(user.email), nickname: user.nickname, mustReset: !!mustReset };
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(sess), SESSION_TTL);
  return token;
}

function requireSession_(token) {
  if (!token) throw appError_('ログインしてください', 'SESSION_EXPIRED');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + token);
  if (!raw) throw appError_('ログインの有効期限が切れました。もう一度ログインしてください', 'SESSION_EXPIRED');
  cache.put('sess_' + token, raw, SESSION_TTL); // スライディング延長
  const s = JSON.parse(raw);
  s.token = token;
  return s;
}

function updateSession_(sess, patch) {
  const token = sess.token;
  const s = Object.assign({}, sess, patch);
  delete s.token;
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(s), SESSION_TTL);
}

/* ---------------------------------------------------------
 * スプレッドシート
 * ------------------------------------------------------- */
function ss_() {
  const id = prop_('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name, cols) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    (TEXT_COLS[name] || []).forEach(function (c) {
      const idx = cols.indexOf(c) + 1;
      if (idx > 0) sh.getRange(1, idx, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  }
  return sh;
}

function readAll_(name, cols) {
  const sh = sheet_(name, cols);
  const last = sh.getLastRow();
  if (last < 2) return { sh: sh, rows: [] };
  const vals = sh.getRange(2, 1, last - 1, cols.length).getValues();
  return {
    sh: sh,
    rows: vals.map(function (r, i) { return { rowNum: i + 2, obj: toObj_(cols, r) }; })
  };
}

function findUser_(email) {
  const all = readAll_(SHEETS.USERS, USER_COLS);
  const e = normEmail_(email);
  const hit = all.rows.find(function (r) { return normEmail_(r.obj.email) === e; });
  return hit ? { sh: all.sh, rowNum: hit.rowNum, user: hit.obj } : { sh: all.sh, rowNum: 0, user: null };
}

function writeUser_(sh, rowNum, user) {
  sh.getRange(rowNum, 1, 1, USER_COLS.length).setValues([toRow_(USER_COLS, user)]);
}

function toObj_(cols, r) {
  const o = {};
  cols.forEach(function (c, i) { o[c] = r[i]; });
  return o;
}

function toRow_(cols, o) {
  return cols.map(function (c) { return o[c] === undefined || o[c] === null ? '' : o[c]; });
}

/* ---------------------------------------------------------
 * ユーティリティ
 * ------------------------------------------------------- */
function hash_(pw, salt) {
  const pepper = prop_('PEPPER') || '';
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + ':' + pw + ':' + pepper, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function newSalt_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function tempPassword_() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now());
  let s = '';
  for (let i = 0; i < 10; i++) s += cs.charAt((bytes[i] & 0xff) % cs.length);
  return s;
}

function normEmail_(s) { return String(s || '').trim().toLowerCase(); }
function isEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function clip_(s, n) { return String(s || '').slice(0, n); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }

function cleanLine_(s) {
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[*＊#＃]/g, '')
    .replace(/^[「『"'\s]+|[」』"'\s]+$/g, '')
    .trim()
    .slice(0, 200);
}

function decodeHtml_(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function appError_(msg, code) {
  const e = new Error(msg);
  e.code = code || '';
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------------------------------------
 * 初期設定・テスト用（エディタから手動実行）
 * ------------------------------------------------------- */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PEPPER')) {
    props.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
    console.log('PEPPER を生成しました（以後は変更しないでください）');
  }
  sheet_(SHEETS.USERS, USER_COLS);
  sheet_(SHEETS.FAVS, FAV_COLS);
  console.log('シート作成完了（' + APP_NAME + ' v' + APP_VERSION + '）');
  checkConfig();
}

function checkConfig() {
  ['GEMINI_API_KEY', 'YOUTUBE_API_KEY', 'PEPPER', 'APP_URL', 'SPREADSHEET_ID', 'TEXT_MODEL', 'TTS_MODEL']
    .forEach(function (k) { console.log(k + ' : ' + (prop_(k) ? '設定済み' : '未設定')); });
  console.log('メール残り送信数: ' + MailApp.getRemainingDailyQuota());
}

function testGemini() {
  console.log('TEXT: ' + geminiText_('短く答えてください。', 'こんにちは'));
  const a = geminiTts_('いらっしゃい。今夜は何を歌うの？', 'mama');
  console.log('TTS: ' + a.mimeType + ' / base64長 ' + a.data.length);
}

function testGeocode() {
  const g = Maps.newGeocoder().setLanguage('ja').reverseGeocode(35.5308, 139.7029);
  console.log(g.status + ' : ' + (g.results[0] ? g.results[0].formatted_address : ''));
}
