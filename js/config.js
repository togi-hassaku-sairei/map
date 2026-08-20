/* ============================================================
 *  設定ファイル（このファイルだけ編集すればOK）
 *  ・閲覧ページ / 履歴ページ / 管理ページが読み込みます
 *  ・GPSデータの取得は GAS が事業者APIから行います（このファイルには
 *    APIのURL・認証は書きません。Code.gs に設定します）
 * ============================================================ */
const CONFIG = {

  /* ① Google Apps Script のウェブアプリURL
   *    GAS をデプロイすると発行される「…/exec」で終わるURLを貼り付ける */
  GAS_URL: "https://script.google.com/macros/s/AKfycbxpTZSQ2hVv5SOtGNWluJVNygX6CldBsuBhO_Gru-H-KaGOzaJe1zgaqJY37-1Ks2h0-g/exec",

  /* ② 地図の自動更新間隔（ミリ秒）… 30秒 = 30000 */
  REFRESH_INTERVAL: 30000,

  /* ③ 通信断とみなす秒数（5分＝300秒。この秒数以上更新がなければ「通信断」） */
  OFFLINE_SEC: 300,

  /* ⑤ 地図の初期表示（祭り会場の中心の緯度・経度）とズーム倍率
   *    Googleマップで会場を右クリック →「緯度・経度」でコピーできます */
  MAP_CENTER: [37.144497, 136.732007],  // ← 会場に合わせて変更（例：京都駅付近）
  MAP_ZOOM: 15,

  /* ⑥ 神輿の定義（表示用）
   *    id  … 自システム内の識別ID（Masterの「神輿ID」と一致させる）
   *    name… 表示名（自由に変更可）
   *    color… 地図マーカーのリング色（一覧・軌跡の色にも使用）
   *    icon … 地区紋の画像パス（img/フォルダ内）
   *  ※ どの端末(API)がどの神輿かは、スプレッドシートの Master シートの
   *    「APIのID」列で対応づけます（毎年の変更もシート編集だけでOK）
   *  ※ 参加/非参加・並び順も管理ページ（/admin/）から変更できます */
  MIKOSHI: [
    { id: "m01", name: "森之内（本社）", color: "#FFC400", icon: "img/m01.png?v=3" },
    { id: "m02", name: "富来領家町",     color: "#F57C00", icon: "img/m02.png?v=3" },
    { id: "m03", name: "里本江",         color: "#FFC400", icon: "img/m03.png?v=3" },
    { id: "m04", name: "富来地頭町",     color: "#8B0000", icon: "img/m04.png?v=3" },
    { id: "m05", name: "富来高田",       color: "#1B5E20", icon: "img/m05.png?v=3" },
    { id: "m06", name: "東小室",         color: "#111111", icon: "img/m06.png?v=3" },
    { id: "m07", name: "給分",           color: "#EC5F9E", icon: "img/m07.png?v=3" },
    { id: "m08", name: "和田",           color: "#1976D2", icon: "img/m08.png?v=3" },
    { id: "m09", name: "七海",           color: "#1976D2", icon: "img/m09.png?v=3" },
    { id: "m10", name: "田中",           color: "#12206E", icon: "img/m10.png?v=3" },
    { id: "m11", name: "貝田",           color: "#AEB4B8", icon: "img/m11.png?v=3" },
    { id: "m12", name: "大西",           color: "#E23B2E", icon: "img/m12.png?v=3" },
    { id: "m13", name: "相神",           color: "#C9A227", icon: "img/m13.png?v=3" },
    { id: "m14", name: "中浜",           color: "#EDEDED", icon: "img/m14.png?v=3" },
     { id: "g01", name: "⭐ガチャガチャ⭐", color: "#8E24AA", icon: "img/g01.png?v=3" }
  ],

  /* ⑦ トイレの場所（増やす場合はここに { name, lat, lng } の行を足すだけ） */
  TOILETS: [
    { name: "冨木八幡神社 社務所", lat: 37.152385944229074, lng: 136.73750267232603 },
    { name: "住吉神社 お手洗い",   lat: 37.13906994256999,  lng: 136.72721473095197 }
  ]
};

/* ============================================================
 *  参加・表示順の統合
 *  ・色/紋は上の MIKOSHI（config）
 *  ・参加/表示順は管理ページ→サーバー(Master)から取得
 *  失敗時は config の全基をそのまま使う（フォールバック）
 * ============================================================ */
async function loadRosterFull(){
  try{
    const res = await fetch(CONFIG.GAS_URL + (CONFIG.GAS_URL.includes("?")?"&":"?") + "type=roster&_=" + Date.now());
    const j = await res.json();
    const map = {}; (j.roster||[]).forEach(function(r){ map[r.id]=r; });
    const list = CONFIG.MIKOSHI.map(function(m,i){
      const r = map[m.id];
      return {
        id:m.id, name:m.name, color:m.color, icon:m.icon,
        active: r ? !!r.active : true,
        order:  (r && r.order!=null) ? Number(r.order) : (i+1)
      };
    });
    return list.sort(function(a,b){ return a.order-b.order; });
  }catch(e){
    return CONFIG.MIKOSHI.map(function(m,i){ return Object.assign({active:true,order:i+1}, m); });
  }
}
async function loadRoster(){ return (await loadRosterFull()).filter(function(m){ return m.active; }); }
