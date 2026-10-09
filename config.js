/* =========================================================
 * UTAGE 設定ファイル
 *  GASのウェブアプリURLなど、環境ごとに変わる値はここだけで管理します。
 * ========================================================= */
window.APP_CONFIG = {
  // GAS「デプロイ → ウェブアプリ」のURL（…/exec）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwy8-ITYcLQwuVMZ21TiujniwlaQvNiZRSjwjZ-p8TgloTVea-3kR_WlFBrjPxzHouH/exec',

  // 以下は必要なときだけ変更
  AI_TIMEOUT_MS: 25000,   // AIセリフ待ちの上限（ミリ秒）。超えたら定型セリフで続行
  VOICE_THRESHOLD: 0.02,  // この音量(RMS)を超えたら「歌っている」と判定
};
