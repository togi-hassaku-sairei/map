/* ============================================================
 *  神輿現在地マップ 本体ロジック
 * ============================================================ */

/* ---- 地図の初期化 ---- */
const map = L.map("map", { zoomControl: true }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);

/* ベースマップ（標準地図＝OpenStreetMap／航空写真＝国土地理院シームレス空中写真） */
const baseLayers = {
  std: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
  }),
  photo: L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", {
    maxZoom: 18, attribution: "地理院タイル（シームレス空中写真）"
  })
};
let currentBase = "std";
baseLayers.std.addTo(map);   // 初期表示は標準地図（航空写真は選択時に読み込む）

function switchBase(key){
  if (key === currentBase) return;
  map.removeLayer(baseLayers[currentBase]);
  baseLayers[key].addTo(map);      // 航空写真はここで初めて読み込まれる
  baseLayers[key].bringToBack();   // 神輿・現在地マーカーの下へ
  currentBase = key;
}

/* ===== トイレ（固定地点・タップで名称表示） ===== */
function toiletIcon(){
  const svg =
    '<svg width="40" height="52" viewBox="0 0 40 52" xmlns="http://www.w3.org/2000/svg">'+
    '<path d="M20 1 C10 1 2.5 8.5 2.5 18.5 C2.5 32 20 51 20 51 C20 51 37.5 32 37.5 18.5 C37.5 8.5 30 1 20 1 Z" fill="#1565c0" stroke="#ffffff" stroke-width="2.5"/>'+
    '<circle cx="20" cy="18.5" r="12" fill="#ffffff"/>'+
    '<circle cx="15" cy="12.4" r="1.9" fill="#1565c0"/>'+
    '<rect x="12.9" y="14.4" width="4.2" height="5.2" rx="1.4" fill="#1565c0"/>'+
    '<rect x="13.4" y="19" width="1.3" height="5" fill="#1565c0"/><rect x="15.3" y="19" width="1.3" height="5" fill="#1565c0"/>'+
    '<rect x="19.6" y="9" width="0.8" height="18" rx="0.4" fill="#bbdefb"/>'+
    '<circle cx="25" cy="12.4" r="1.9" fill="#1565c0"/>'+
    '<path d="M25 14.4 L21.9 21.4 L28.1 21.4 Z" fill="#1565c0"/>'+
    '<rect x="23.4" y="21.4" width="1.1" height="3.3" fill="#1565c0"/><rect x="25.5" y="21.4" width="1.1" height="3.3" fill="#1565c0"/>'+
    '</svg>';
  return L.divIcon({ className:"",
    html:'<div style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))">'+svg+'</div>',
    iconSize:[40,52], iconAnchor:[20,50], popupAnchor:[0,-46] });
}
(CONFIG.TOILETS || []).forEach(function(t){
  L.marker([t.lat, t.lng], { icon: toiletIcon(), title: t.name })
    .addTo(map)
    .bindPopup('<div class="pop"><b>🚻 トイレ</b><div class="line">'+t.name+'</div>'+dirBtn(t.lat,t.lng)+'</div>');
});

/* ---- 内部状態 ---- */
const markers = {};                  // id -> Leaflet marker
const state   = {};                  // id -> 最新データ
const movement = {};                 // id -> {lat,lng,updated,moving,arrow,dirText}
let lastServerTime = 0;
let ROSTER = CONFIG.MIKOSHI.slice();

/* ---- 距離(Haversine)・方位 ---- */
function haversine(a, b){
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(toR(a.lat))*Math.cos(toR(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearing(a, b){
  const toR = x => x*Math.PI/180, toD = x => x*180/Math.PI;
  const y = Math.sin(toR(b.lng-a.lng)) * Math.cos(toR(b.lat));
  const x = Math.cos(toR(a.lat))*Math.sin(toR(b.lat)) - Math.sin(toR(a.lat))*Math.cos(toR(b.lat))*Math.cos(toR(b.lng-a.lng));
  return (toD(Math.atan2(y, x)) + 360) % 360;
}
function dir8(deg){
  const dirs = [["↑","北"],["↗","北東"],["→","東"],["↘","南東"],["↓","南"],["↙","南西"],["←","西"],["↖","北西"]];
  const d = dirs[Math.round(deg/45) % 8];
  return { arrow:d[0], text:d[1] };
}
const MOVE_THRESHOLD_M = 20;   // 20m以上で「移動中」

/* 神輿アイコンを作る（紋バッジ画像。通信断は灰色化） */
function makeIcon(m, offline){
  const src = m.icon || "";
  const cls = "pin-img" + (offline ? " off" : "");
  const html = '<div class="' + cls + '"><img src="' + src + '" alt="' + m.name + '"></div>';
  return L.divIcon({ className: "", html: html,
    iconSize: [44, 44], iconAnchor: [22, 22], popupAnchor: [0, -22] });
}

function ago(sec){
  if (sec < 60) return Math.floor(sec) + "秒前";
  if (sec < 3600) return Math.floor(sec / 60) + "分前";
  return Math.floor(sec / 3600) + "時間前";
}
function clock(ms){
  return new Date(ms).toLocaleTimeString("ja-JP", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
}

/* 1基分の状態を計算 */
function calc(m){
  const d = state[m.id];
  if (!d || !d.updated){
    return { known:false, offline:true, statusText:"未受信", cls:"non" };
  }
  const base = lastServerTime || Date.now();
  const sec  = (base - d.updated) / 1000;
  const offline = sec > CONFIG.OFFLINE_SEC;
  return { known:true, offline, sec, statusText: offline ? "通信断" : "正常", cls: offline ? "off" : "ok", d };
}

/* 移動情報の取得（表示用） */
function moveInfo(id){
  const mv = movement[id];
  if (!mv) return null;
  return { moving: mv.moving, arrow: mv.arrow || "", dirText: mv.dirText || "" };
}

/* Googleマップ経路ボタン */
function dirBtn(lat, lng){
  return '<a href="https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng + '" ' +
    'target="_blank" rel="noopener" ' +
    'style="display:inline-block;margin-top:9px;padding:9px 14px;background:#1a73e8;color:#fff;' +
    'border-radius:8px;font-weight:700;text-decoration:none;font-size:13px;">🧭 経路（Googleマップ）</a>';
}

/* ポップアップの中身 */
function popupHtml(m, c){
  if (!c.known) return '<div class="pop"><b>' + m.name + "</b><div class='line'>まだ位置を受信していません</div></div>";
  const d = c.d;
  let html = '<div class="pop"><b>' + m.name + "</b>";
  if (d.desc) html += '<div class="line" style="color:#5a4;">💬 ' + d.desc + "</div>";
  html += '<div class="line">最終更新：' + clock(d.updated) + "（" + ago(c.sec) + "）</div>";
  const mi = (!c.offline) ? moveInfo(m.id) : null;
  if (mi){
    html += '<div class="line">状態：' + (mi.moving ? "👣 移動中" : "⏸ 停止中") + "</div>";
    if (mi.moving && mi.dirText) html += '<div class="line">進行方向：' + mi.arrow + " " + mi.dirText + "</div>";
  }
  html += '<div class="line">現在地：' + d.lat.toFixed(5) + ", " + d.lng.toFixed(5) + "</div>";
  if (d.img) html += '<div class="pop-img"><img src="' + d.img + '" alt="" loading="lazy"></div>';
  html += dirBtn(d.lat, d.lng) + "</div>";
  return html;
}

/* 波紋アニメーション（新データ受信時。リング色を流用） */
function rippleMarker(id){
  const mk = markers[id]; if (!mk) return;
  const el = mk.getElement(); if (!el) return;
  const m = ROSTER.find(x => x.id === id) || CONFIG.MIKOSHI.find(x => x.id === id);
  const color = m ? m.color : "#888";
  const box = document.createElement("div");
  box.className = "ripple-box";
  for (let i = 0; i < 3; i++){
    const r = document.createElement("span");
    r.className = "ripple-ring";
    r.style.borderColor = color;
    r.style.animationDelay = (i * 0.7) + "s";
    box.appendChild(r);
  }
  el.appendChild(box);
  setTimeout(function(){ if (box.parentNode) box.parentNode.removeChild(box); }, 3000);
}

/* 地図マーカーを更新 */
function updateMarkers(){
  const activeIds = new Set(ROSTER.map(m => m.id));
  Object.keys(markers).forEach(id => {
    if (!activeIds.has(id)){ map.removeLayer(markers[id]); delete markers[id]; }
  });
  ROSTER.forEach(m => {
    const c = calc(m);
    if (!c.known){
      if (markers[m.id]){ map.removeLayer(markers[m.id]); delete markers[m.id]; }
      return;
    }
    const pos = [c.d.lat, c.d.lng];
    if (!markers[m.id]){
      markers[m.id] = L.marker(pos, { icon: makeIcon(m, c.offline) }).addTo(map);
      markers[m.id].bindPopup(popupHtml(m, c), { autoPan: false });
      markers[m.id]._offState = c.offline;
    } else {
      markers[m.id].setLatLng(pos);
      if (markers[m.id]._offState !== c.offline){   // 通信断状態が変わったときだけアイコン再生成
        markers[m.id].setIcon(makeIcon(m, c.offline));
        markers[m.id]._offState = c.offline;
      }
      markers[m.id].setPopupContent(popupHtml(m, c));
    }
  });
}

/* 一覧を更新 */
function updateList(){
  const q = document.getElementById("search").value.trim().toLowerCase();
  const ul = document.getElementById("list");
  ul.innerHTML = "";

  ROSTER.forEach(m => {
    const c = calc(m);

    const hit = (m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    if (q && !hit) return;

    // 移動中／停止中・進行方向（通信中のみ）
    let moveLine = "";
    if (c.known && !c.offline){
      const mi = moveInfo(m.id);
      if (mi){
        moveLine = mi.moving
          ? '<div class="row-move">👣 ' + (mi.arrow ? mi.arrow + " " + mi.dirText + "へ移動中" : "移動中") + "</div>"
          : '<div class="row-move stop">⏸ 停止中</div>';
      }
    }

    const li = document.createElement("li");
    li.className = "row";
    li.innerHTML =
      '<div class="row-crest' + (c.offline ? " off" : "") + '">' +
        '<img src="' + (m.icon || "") + '" alt="">' +
      "</div>" +
      '<div class="row-main">' +
        '<div class="row-name"><span class="row-dot" style="background:' + m.color + '"></span>' + m.name + "</div>" +
        moveLine +
        '<div class="row-sub">' + (c.known ? "更新 " + ago(c.sec) : "位置情報なし") + "</div>" +
      "</div>";
    li.onclick = () => focusMikoshi(m.id);
    ul.appendChild(li);
  });
}

/* 指定神輿へ地図を移動しポップアップを開く */
function focusMikoshi(id){
  const mk = markers[id];
  if (mk){
    Object.values(markers).forEach(m => m.setZIndexOffset(0));
    mk.setZIndexOffset(1000);
    map.setView(mk.getLatLng(), Math.max(map.getZoom(), 16));
    mk.openPopup();
    setTimeout(() => mk.openPopup(), 350);
  }
  if (window.matchMedia("(max-width:720px)").matches){
    document.getElementById("panel").classList.remove("open");
    const tg = document.getElementById("panelToggle");
    if (tg) tg.textContent = tg.textContent.replace("▼", "▲");
  }
}

/* ---- サーバーから取得 ---- */
async function fetchData(){
  try{
    const url = CONFIG.GAS_URL + (CONFIG.GAS_URL.includes("?") ? "&" : "?") + "_=" + Date.now();
    const res = await fetch(url, { method:"GET" });
    const json = await res.json();
    if (!json.ok) throw new Error("server");

    lastServerTime = json.server || Date.now();

    const rippleTargets = [];
    json.mikoshi.forEach(d => {
      const prev = movement[d.id];
      const wasMoving = prev ? prev.moving : false;

      if (prev && prev.updated !== d.updated){
        const dist = haversine(prev, d);
        if (dist >= MOVE_THRESHOLD_M){
          const b = dir8(bearing(prev, d));
          movement[d.id] = { lat:d.lat, lng:d.lng, updated:d.updated, moving:true, arrow:b.arrow, dirText:b.text };
        } else {
          // 20m未満：停止中。方向は前回を据え置き（ちらつき防止）
          movement[d.id] = { lat:d.lat, lng:d.lng, updated:d.updated, moving:false, arrow:prev.arrow||"", dirText:prev.dirText||"" };
        }
      } else if (!prev){
        movement[d.id] = { lat:d.lat, lng:d.lng, updated:d.updated, moving:false, arrow:"", dirText:"" };
      }
      // updatedが同じ（変化なし）→ movementはそのまま維持

      // 停止→移動に変わった瞬間だけ波紋
      if (!wasMoving && movement[d.id] && movement[d.id].moving){
        rippleTargets.push(d.id);
      }

      state[d.id] = d;
    });

    updateMarkers();
    updateList();
    rippleTargets.forEach(id => rippleMarker(id));   // 動き出した神輿だけ波紋

    document.getElementById("foot").textContent = "最終取得：" + clock(Date.now());
    banner(false);
  }catch(e){
    banner(true, "サーバーに接続できません（自動で再試行します）");
    updateList();
  }
}

/* 通信エラーバナー */
function banner(show, msg){
  const b = document.getElementById("banner");
  b.textContent = msg || "";
  b.classList.toggle("show", !!show);
}

/* ---- UIイベント ---- */
document.getElementById("search").addEventListener("input", updateList);
document.getElementById("panelToggle").addEventListener("click", () => {
  const p = document.getElementById("panel");
  const open = p.classList.toggle("open");
  document.getElementById("panelToggle").textContent = open ? "🔍 キリコ・神輿等検索 ▼" : "🔍 キリコ・神輿等検索 ▲";
});

/* ---- 現在地（この端末の画面だけ。サーバーには送らない） ---- */
let meMarker = null, meCircle = null, meWatch = null, meFirst = true;

function meIcon(){
  return L.divIcon({ className:"",
    html:'<div class="me-dot"></div>',
    iconSize:[16,16], iconAnchor:[8,8] });
}
function locateMe(){
  if (!("geolocation" in navigator)){ banner(true, "この端末は位置情報に対応していません"); return; }
  const btn = document.getElementById("locateBtn");
  btn.classList.add("loading");
  // すでに追従中なら、自分の位置へ寄せ直すだけ
  if (meMarker){ map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 16)); btn.classList.remove("loading"); return; }
  meWatch = navigator.geolocation.watchPosition(
    p => {
      btn.classList.remove("loading"); btn.classList.add("on");
      const ll = [p.coords.latitude, p.coords.longitude];
      const acc = p.coords.accuracy || 30;
      if (!meMarker){
        meMarker = L.marker(ll, { icon: meIcon(), interactive:false, zIndexOffset:9999 }).addTo(map);
        meCircle = L.circle(ll, { radius: acc, className:"me-acc", stroke:false, fillColor:"#1a73e8", fillOpacity:0.15 }).addTo(map);
      } else {
        meMarker.setLatLng(ll); meCircle.setLatLng(ll); meCircle.setRadius(acc);
      }
      if (meFirst){ map.setView(ll, Math.max(map.getZoom(), 16)); meFirst = false; }
    },
    err => { btn.classList.remove("loading"); banner(true, "現在地を取得できません（位置情報を許可してください）");
             setTimeout(()=>banner(false), 4000); },
    { enableHighAccuracy:true, maximumAge:5000, timeout:20000 }
  );
}
document.getElementById("locateBtn").addEventListener("click", locateMe);

/* ---- 注意書き（ⓘ）ボタン ---- */
(function(){
  const ib = document.getElementById("infoBtn");
  const bubble = document.getElementById("infoBubble");
  if (!ib || !bubble) return;
  function openInfo(o){ bubble.classList.toggle("open", o); ib.classList.toggle("on", o); }
  ib.addEventListener("click", function(e){ e.stopPropagation(); openInfo(!bubble.classList.contains("open")); });
  bubble.addEventListener("click", function(e){ e.stopPropagation(); });
  map.on("click", function(){ openInfo(false); });
  document.addEventListener("click", function(){ openInfo(false); });
})();

/* ---- 地図レイヤー切替（Googleマップ風・小ボタンから開閉） ---- */
(function(){
  const btn   = document.getElementById("layerBtn");
  const panel = document.getElementById("layerPanel");
  if (!btn || !panel) return;

  function renderChecks(){
    panel.querySelectorAll(".layer-opt").forEach(function(op){
      const on = op.dataset.base === currentBase;
      op.classList.toggle("sel", on);
      op.querySelector(".chk").textContent = on ? "✓" : "";
    });
  }
  function openPanel(o){ panel.classList.toggle("open", o); btn.classList.toggle("on", o); }

  btn.addEventListener("click", function(e){
    e.stopPropagation();
    openPanel(!panel.classList.contains("open"));
    renderChecks();
  });
  panel.querySelectorAll(".layer-opt").forEach(function(op){
    op.addEventListener("click", function(e){
      e.stopPropagation();
      switchBase(op.dataset.base);
      renderChecks();
      openPanel(false);   // 選んだら閉じる（誤タップ防止・片手操作）
    });
  });
  // 地図など他をタップしたら閉じる
  map.on("click", function(){ openPanel(false); });
  document.addEventListener("click", function(){ openPanel(false); });
  renderChecks();
})();

setInterval(() => { const _c=document.getElementById("clock"); if(_c) _c.textContent = clock(Date.now()); }, 1000);

/* 30秒ごとに更新（経過時間表示は5秒ごとに再計算） */
fetchData();
setInterval(fetchData, CONFIG.REFRESH_INTERVAL);
setInterval(() => { updateMarkers(); updateList(); }, 5000);

/* 参加・表示順を読み込む（起動時＋5分ごと） */
async function refreshRoster(){
  ROSTER = await loadRoster();
  updateMarkers(); updateList();
}
refreshRoster();
setInterval(refreshRoster, 300000);
