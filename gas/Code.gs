/* ============================================================
 *  神輿トラッカー サーバー（Google Apps Script）— pull型
 *
 *  ■ 方式：GASが1分ごとにレンタル事業者のJSON APIを取得し、
 *          CurrentLocation（最新）と History（全履歴）に保存する。
 *
 *  ■ 初回セットアップ（エディタで1回ずつ実行）
 *    1) setupSheets   … 各シートを作成・初期化
 *    2) installTrigger … 1分ごとの自動取得を開始
 *    3) デプロイ → 新しいデプロイ → ウェブアプリ（全員）
 *       発行URLを config.js の GAS_URL に貼る
 *  ■ コード変更後は「デプロイを管理 → 鉛筆 → 新バージョン → デプロイ」
 * ============================================================ */

/* ===== ① 事業者API設定 ===== */
const API_URL = "https://ohwatcha.evolinq.link/api/items/current";  // おわっちゃ 位置情報API
const API_KEY = "";   // このAPIは認証不要（公開GET）。必要になった場合のみ設定
const API_KEY_HEADER = "Authorization";
const API_KEY_PREFIX = "Bearer ";

/* ===== ② 管理者パスワード（公開ファイルには書かない）===== */
const ADMIN_KEY = "kanri-himitsu-CHANGE_ME";

/* ===== ③ 緊急スマホ送信の設定 ===== */
const SEND_KEY = "Bebesheto";       // 緊急送信ページの書き込みキー（config側と一致）
const MANUAL_TIMEOUT_SEC = 180;     // スマホ送信の優先が続く秒数（この間はAPIで上書きしない）
const CLAIM_TIMEOUT_SEC  = 180;     // 同じ神輿を別端末が送れない秒数（二重送信防止）

/* ===== 基本設定 ===== */
const TZ = "Asia/Tokyo";
const CUR_SHEET   = "CurrentLocation";
const HIST_SHEET  = "History";
const MASTER_SHEET= "Master";
const ERR_SHEET   = "ErrorLog";
const CACHE_KEY = "cur"; const CACHE_SEC = 15;
const MKEY = "roster"; const MCACHE_SEC = 60;

function ss_(){ return SpreadsheetApp.getActiveSpreadsheet(); }

/* ---- シート取得（無ければ作成）---- */
function getCurrent_(){
  const ss=ss_(); let sh=ss.getSheetByName(CUR_SHEET);
  if(!sh){ sh=ss.insertSheet(CUR_SHEET); sh.appendRow(["神輿ID","神輿名","緯度","経度","更新日時","見どころ","リンク","送信元","トークン"]); }
  return sh;
}
function getHistory_(){
  const ss=ss_(); let sh=ss.getSheetByName(HIST_SHEET);
  if(!sh){ sh=ss.insertSheet(HIST_SHEET); sh.appendRow(["取得日時","神輿ID","神輿名","緯度","経度"]); }
  return sh;
}
function getMaster_(){
  const ss=ss_(); let sh=ss.getSheetByName(MASTER_SHEET);
  if(!sh){ sh=ss.insertSheet(MASTER_SHEET); sh.appendRow(["神輿ID","神輿名","担当地区","参加","表示順","APIのID"]); }
  return sh;
}
function getErrorLog_(){
  const ss=ss_(); let sh=ss.getSheetByName(ERR_SHEET);
  if(!sh){ sh=ss.insertSheet(ERR_SHEET); sh.appendRow(["日時","内容"]); }
  return sh;
}

/* ---- 初回セットアップ ---- */
function setupSheets(){
  getCurrent_(); getHistory_(); getErrorLog_();
  const sh=getMaster_();
  sh.getRange(1,1,1,6).setValues([["神輿ID","神輿名","担当地区","参加","表示順","APIのID"]]);
  if(sh.getLastRow()<2){
    // 神輿ID / 名前 / 地区 / 参加 / 表示順 / APIのID（←空。listDevices実行後に実端末IDを記入）
    const base=[
      ["m01","森之内","本社",true,1,""],["m02","富来領家町","富来",true,2,""],
      ["m03","里本江","東増穂",true,3,""],["m04","富来地頭町","富来",true,4,""],
      ["m05","富来高田","富来",true,5,""],["m06","東小室","稗造",true,6,""],
      ["m07","給分","東増穂",true,7,""],["m08","和田","稗造",true,8,""],
      ["m09","七海","富来",true,9,""],["m10","田中","稗造",true,10,""],
      ["m11","貝田","稗造",true,11,""],["m12","大西","稗造",true,12,""],
      ["m13","相神","東増穂",false,13,""],["m14","中浜","東増穂",false,14,""]
    ];
    sh.getRange(2,1,base.length,6).setValues(base);
  }
  CacheService.getScriptCache().remove(MKEY);
  return "OK: シート準備完了。次に installTrigger を実行してください。";
}

/* ---- 1分ごとの自動取得を開始 ---- */
function installTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if(t.getHandlerFunction()==="pullFromApi") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("pullFromApi").timeBased().everyMinutes(1).create();
  return "OK: 1分ごとの取得を開始しました。";
}

/* ============================================================
 *  ★中核：事業者APIを取得して保存
 * ============================================================ */
function pullFromApi(){
  const lock=LockService.getScriptLock();
  try{
    lock.waitLock(20000);

    // 1) 取得
    const opt={ muteHttpExceptions:true };
    if(API_KEY){ opt.headers={}; opt.headers[API_KEY_HEADER]=API_KEY_PREFIX+API_KEY; }
    const res=UrlFetchApp.fetch(API_URL, opt);
    const code=res.getResponseCode();
    if(code<200||code>=300){ logError_("API応答コード "+code+": "+res.getContentText().slice(0,200)); return; }

    // 2) JSON解析（配列 / {data:[...]} / 単体 のいずれにも対応）
    let json=JSON.parse(res.getContentText());
    let arr = Array.isArray(json) ? json
            : (json.data||json.devices||json.results||json.list||json.items
               || (json.id!==undefined ? [json] : []));
    if(!Array.isArray(arr) || !arr.length){ logError_("APIデータが空、または配列ではありません"); return; }

    // 3) Master の「APIのID → 神輿ID/名」対応表
    const map=getApiMap_();

    const cur=getCurrent_(); const hist=getHistory_();
    const now=new Date();
    const nowStr=Utilities.formatDate(now,TZ,"yyyy/MM/dd HH:mm:ss");

    // 現在シートの既存行を把握（ID→{行, 送信元, 更新epoch}）
    const last=cur.getLastRow();
    const curMap={}; let ids=[];
    if(last>=2){
      const cv=cur.getRange(2,1,last-1,9).getValues();
      cv.forEach(function(rr,i){
        const id=String(rr[0]); ids.push(id);
        curMap[id]={ row:i+2, src:String(rr[7]||""), upd:(parseTime_(rr[4])||0) };
      });
    }
    const nowMs=now.getTime();

    arr.forEach(function(r){
      const apiId = String(r.id!==undefined ? r.id : (r.deviceId!==undefined ? r.deviceId : ""));
      const devId = String(r.device_id!==undefined ? r.device_id : "");
      const lat = Number(r.lat!==undefined ? r.lat : r.latitude);
      const lng = Number(r.lng!==undefined ? r.lng : (r.lon!==undefined ? r.lon : r.longitude));
      const tRaw= r.update_at || r.updated_at || r.timestamp || r.time || r.datetime;
      if(!isFinite(lat)||!isFinite(lng)) return;

      // Masterの「APIのID」に id か device_id が一致した端末だけ採用（＝他祭りの端末を自動除外）
      const mp = map[apiId] || map[devId];
      if(!mp) return;                 // 対応づけの無い端末は表示しない
      const mid  = mp.id;
      const mname= mp.name || r.name || "";

      // ★スマホ緊急送信が優先中の神輿は、API取得で上書きしない
      const cm=curMap[mid];
      if(cm && cm.src==="manual" && (nowMs-cm.upd) < MANUAL_TIMEOUT_SEC*1000){
        return;   // 手動送信優先（時間切れになればAPIが再び上書き）
      }

      const desc = (r.description ? String(r.description).replace(/\s+/g," ").trim() : "");
      const link = (r.url ? String(r.url) : "");
      const tEpoch=parseTime_(tRaw);
      const tStr = tEpoch ? Utilities.formatDate(new Date(tEpoch),TZ,"yyyy/MM/dd HH:mm:ss") : nowStr;

      // CurrentLocation：上書き or 追加（送信元=api / トークン=空）
      const row=[mid, mname, lat, lng, tStr, desc, link, "api", ""];
      if(cm){ cur.getRange(cm.row,1,1,9).setValues([row]); }
      else { cur.appendRow(row); ids.push(mid); curMap[mid]={row:cur.getLastRow(),src:"api",upd:nowMs}; }

      // History：毎回追記
      hist.appendRow([nowStr, mid, mname, lat, lng]);
    });

    CacheService.getScriptCache().remove(CACHE_KEY);
  }catch(err){
    logError_("pull例外: "+err);
  }finally{
    lock.releaseLock();
  }
}

/* APIのID → {id,name} をMasterから作る */
function getApiMap_(){
  const sh=getMaster_(); const last=sh.getLastRow(); const map={};
  if(last>=2){
    const v=sh.getRange(2,1,last-1,6).getValues();
    v.forEach(function(r){
      const apiId=String(r[5]);
      if(apiId!=="" ) map[apiId]={id:String(r[0]), name:r[1]};
    });
  }
  return map;
}

/* 神輿ID → 神輿名（Master）*/
function getMasterNameMap_(){
  const sh=getMaster_(); const last=sh.getLastRow(); const map={};
  if(last>=2){
    sh.getRange(2,1,last-1,2).getValues().forEach(function(r){ if(r[0]) map[String(r[0])]=r[1]; });
  }
  return map;
}

/* 時刻文字列 → epoch（タイムゾーン無しはJSTとして扱う。/ 区切りにも対応）*/
function parseTime_(s){
  if(!s) return null;
  s=String(s).trim();
  if(/[zZ]$/.test(s) || /[+\-]\d{2}:?\d{2}$/.test(s)){ const t=new Date(s).getTime(); return isNaN(t)?null:t; }
  const iso=s.replace(/\//g,"-").replace(" ","T");
  const t=new Date(iso+"+09:00").getTime();
  return isNaN(t)? null : t;
}

function logError_(msg){
  try{ getErrorLog_().appendRow([Utilities.formatDate(new Date(),TZ,"yyyy/MM/dd HH:mm:ss"), String(msg)]); }catch(e){}
}

/* ============================================================
 *  配信（閲覧・管理・履歴）
 * ============================================================ */
function doGet(e){
  const p=(e&&e.parameter)?e.parameter:{};
  if(p.type==="roster")  return out_raw_(rosterBody_());
  if(p.type==="years")   return getYears_();
  if(p.type==="history") return getHistoryJson_(p.year,p.id);
  if(p.type==="track")   return getTrackJson_();

  // 既定：最新位置
  const cache=CacheService.getScriptCache();
  const cached=cache.get(CACHE_KEY);
  if(cached) return out_raw_(cached);

  const sh=getCurrent_(); const last=sh.getLastRow(); const list=[];
  if(last>=2){
    sh.getRange(2,1,last-1,9).getValues().forEach(function(r){
      list.push({ id:String(r[0]), name:r[1], lat:Number(r[2]), lng:Number(r[3]),
        speed:null, updated: parseTime_(r[4]) || 0,
        desc:(r[5]||""), link:(r[6]||""), src:(r[7]||"api") });
    });
  }
  const body=JSON.stringify({ ok:true, server:Date.now(), mikoshi:list });
  cache.put(CACHE_KEY, body, CACHE_SEC);
  return out_raw_(body);
}

/* 参加・表示順（Master由来）*/
function rosterBody_(){
  const cache=CacheService.getScriptCache();
  const c=cache.get(MKEY); if(c) return c;
  const sh=getMaster_(); const last=sh.getLastRow(); const list=[];
  if(last>=2){
    sh.getRange(2,1,last-1,5).getValues().forEach(function(r,i){
      if(!r[0]) return;
      const active=(r[3]===""||r[3]===null)?true:(r[3]===true||String(r[3]).toUpperCase()==="TRUE"||String(r[3])==="1"||r[3]==="○");
      const order=(r[4]===""||r[4]===null)?(i+1):Number(r[4]);
      list.push({id:String(r[0]),name:r[1],area:r[2],active:active,order:order});
    });
  }
  list.sort(function(a,b){return a.order-b.order;});
  const body=JSON.stringify({ok:true,roster:list});
  cache.put(MKEY,body,MCACHE_SEC);
  return body;
}

/* 履歴：年度一覧（取得日時の先頭4文字）*/
function getYears_(){
  const sh=getHistory_(); const last=sh.getLastRow(); const set={};
  if(last>=2){ sh.getRange(2,1,last-1,1).getValues().forEach(function(r){
    const y=String(r[0]).slice(0,4); if(y) set[y]=true; }); }
  return out_({ok:true,years:Object.keys(set).sort()});
}

/* 履歴：指定年度（任意でID）の全点 [id,lat,lng,"日時"] */
function getHistoryJson_(year,id){
  const sh=getHistory_(); const last=sh.getLastRow(); const pts=[];
  if(last>=2){
    const v=sh.getRange(2,1,last-1,5).getValues();
    for(let i=0;i<v.length;i++){
      const r=v[i]; const dt=String(r[0]);
      if(year && dt.slice(0,4)!==String(year)) continue;
      if(id && String(r[1])!==id) continue;
      pts.push([String(r[1]), Number(r[3]), Number(r[4]), dt]);
    }
  }
  return out_({ok:true,year:year||null,points:pts});
}

/* 本日の軌跡（メイン地図のON/OFF用）[id,lat,lng] 時刻順 */
function getTrackJson_(){
  const sh=getHistory_(); const last=sh.getLastRow(); const pts=[];
  const today=Utilities.formatDate(new Date(),TZ,"yyyy/MM/dd");
  if(last>=2){
    const v=sh.getRange(2,1,last-1,5).getValues();
    for(let i=0;i<v.length;i++){
      const r=v[i];
      if(String(r[0]).slice(0,10)!==today) continue;
      pts.push([String(r[1]), Number(r[3]), Number(r[4])]);
    }
  }
  return out_({ok:true,points:pts});
}

/* ============================================================
 *  管理者操作（削除・参加/並び順の保存）
 * ============================================================ */
function doPost(e){
  const lock=LockService.getScriptLock();
  try{
    lock.waitLock(15000);
    const data=JSON.parse(e.postData.contents);

    if(data.action==="delete"){
      if(data.adminKey!==ADMIN_KEY) return out_({ok:false,error:"admin_auth"});
      const sh=getCurrent_(); const last=sh.getLastRow();
      if(last>=2){
        const ids=sh.getRange(2,1,last-1,1).getValues().flat().map(String);
        const idx=ids.indexOf(String(data.id));
        if(idx>=0){ sh.deleteRow(idx+2); CacheService.getScriptCache().remove(CACHE_KEY);
          return out_({ok:true,deleted:data.id}); }
      }
      return out_({ok:true,deleted:null});
    }

    if(data.action==="saveRoster"){
      if(data.adminKey!==ADMIN_KEY) return out_({ok:false,error:"admin_auth"});
      const sh=getMaster_(); const last=sh.getLastRow();
      if(last<2) return out_({ok:false,error:"no_master"});
      const ids=sh.getRange(2,1,last-1,1).getValues().flat().map(String);
      (data.items||[]).forEach(function(it){
        const idx=ids.indexOf(String(it.id));
        if(idx>=0) sh.getRange(idx+2,4,1,2).setValues([[ it.active?true:false, Number(it.order) ]]);
      });
      CacheService.getScriptCache().remove(MKEY);
      return out_({ok:true});
    }

    /* ★緊急スマホ送信（位置の受信）*/
    if(data.action==="send" || (data.key!==undefined && data.lat!==undefined)){
      if(data.key!==SEND_KEY) return out_({ok:false,error:"auth"});
      const mid=String(data.id);
      const lat=Number(data.lat), lng=Number(data.lng);
      if(!mid || !isFinite(lat) || !isFinite(lng)) return out_({ok:false,error:"bad_data"});

      const cur=getCurrent_(); const now=new Date();
      const nowStr=Utilities.formatDate(now,TZ,"yyyy/MM/dd HH:mm:ss");
      const last=cur.getLastRow();
      let rowIdx=-1, existing=null;
      if(last>=2){
        const cv=cur.getRange(2,1,last-1,9).getValues();
        for(let i=0;i<cv.length;i++){ if(String(cv[i][0])===mid){ rowIdx=i+2; existing=cv[i]; break; } }
      }
      // 担当ロック：別端末が送信中なら拒否
      if(existing){
        const owner=String(existing[8]||"");
        const upd=parseTime_(existing[4])||0;
        if(owner && owner!==String(data.token) && existing[7]==="manual"
           && (now.getTime()-upd) < CLAIM_TIMEOUT_SEC*1000){
          return out_({ok:false,error:"in_use"});
        }
      }
      // Master優先の名前／見どころ・リンクは既存を保持
      const mmap=getMasterNameMap_();
      const name=(mmap[mid]||data.name||(existing?existing[1]:"")||"");
      const desc=existing?existing[5]:"";
      const link=existing?existing[6]:"";
      const row=[mid,name,lat,lng,nowStr,desc,link,"manual",String(data.token||"")];
      if(rowIdx>0) cur.getRange(rowIdx,1,1,9).setValues([row]);
      else cur.appendRow(row);
      getHistory_().appendRow([nowStr,mid,name,lat,lng]);
      CacheService.getScriptCache().remove(CACHE_KEY);
      return out_({ok:true});
    }

    return out_({ok:false,error:"unknown_action"});
  }catch(err){ return out_({ok:false,error:String(err)}); }
  finally{ lock.releaseLock(); }
}

function out_(obj){ return out_raw_(JSON.stringify(obj)); }
function out_raw_(str){ return ContentService.createTextOutput(str).setMimeType(ContentService.MimeType.JSON); }

/* ============================================================
 *  動作確認用：APIの生データを一度だけ手動取得してログ表示
 * ============================================================ */
function testApiOnce(){
  const opt={ muteHttpExceptions:true };
  if(API_KEY){ opt.headers={}; opt.headers[API_KEY_HEADER]=API_KEY_PREFIX+API_KEY; }
  const res=UrlFetchApp.fetch(API_URL, opt);
  Logger.log("code: "+res.getResponseCode());
  Logger.log(res.getContentText().slice(0,1500));
}

/* APIの全端末を一覧表示（Masterの「APIのID」に何を入れるか決める用）
 * 実行後「実行ログ」を開くと、id / device_id / 名前 / 位置 が並びます。
 * 自分たちの端末の id か device_id を Master の「APIのID」に転記してください。 */
function listDevices(){
  const opt={ muteHttpExceptions:true };
  if(API_KEY){ opt.headers={}; opt.headers[API_KEY_HEADER]=API_KEY_PREFIX+API_KEY; }
  const json=JSON.parse(UrlFetchApp.fetch(API_URL,opt).getContentText());
  const arr=Array.isArray(json)?json:(json.data||json.devices||json.results||json.list||json.items||[]);
  Logger.log("=== 全 "+arr.length+" 端末 ===");
  arr.forEach(function(r){
    Logger.log("id="+r.id+" / device_id="+r.device_id+" / 名前="+r.name
      +" / 位置="+r.lat+","+r.lon+" / 更新="+r.update_at);
  });
  Logger.log("↑ この中から自分たちの端末を選び、id か device_id を Master の「APIのID」列へ");
}
