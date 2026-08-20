# 神輿リアルタイム位置マップ（pull型 / ソラコムGPS＋事業者API）

各神輿にソラコム対応GPS端末を載せ、レンタル事業者のJSON APIを **GASが1分ごとに取得** して
スプレッドシートに保存、GitHub Pages＋Leaflet で表示します。
**スマホ・SIM・送信ページは不要。運営は「端末を神輿に付けるだけ」です。**

---

## 1. システム構成図

```
[GPS端末12基] → [レンタル事業者システム] → [JSON API]
                                              │  GASが1分ごとに取得(pull)
                                              ▼
                       Google Apps Script（無料）
                         ├ CurrentLocation（最新のみ・上書き）
                         ├ History        （全履歴・追記）
                         ├ Master         （神輿情報・参加・並び順・APIのID対応）
                         └ ErrorLog       （取得失敗の記録）
                                              │  doGet でJSON配信（15秒キャッシュ）
                                              ▼
                       GitHub Pages（無料）＋ Leaflet
                         閲覧 / 履歴（軌跡再生）/ 管理（参加・並び順・削除）
```

---

## 2. Googleスプレッドシート設計

同じスプレッドシート内に4シート（`setupSheets` 実行で自動作成）。

**CurrentLocation（最新のみ）**

| 神輿ID | 神輿名 | 緯度 | 経度 | 更新日時 |
|---|---|---|---|---|

**History（全履歴・追記）**

| 取得日時 | 神輿ID | 神輿名 | 緯度 | 経度 |
|---|---|---|---|---|

**Master（神輿情報・毎年ここを編集）**

| 神輿ID | 神輿名 | 担当地区 | 参加 | 表示順 | APIのID |
|---|---|---|---|---|---|

- **APIのID**：事業者APIの `id`（端末ID）を入れると、その端末が地図上のどの神輿かが決まります。**毎年の付け替えはこの列を直すだけ**。
- **参加 / 表示順**：管理ページ（/admin/）からも変更できます。

**ErrorLog**

| 日時 | 内容 |
|---|---|

---

## 3. GAS設計

- `pullFromApi()` … 1分ごとに自動実行。API取得→解析→CurrentLocation上書き→History追記。失敗は ErrorLog へ。
- `doGet()` … 閲覧/履歴/軌跡/参加設定 をJSONで配信（既定は最新位置）。
- `doPost()` … 管理者操作（削除・参加/並び順の保存）。
- `setupSheets()` / `installTrigger()` / `testApiOnce()` … 初期設定・確認用。

APIの **URL・認証・項目名の揺れ**（`lon`/`lng`、`update_at`/`timestamp`、id数値）は Code.gs 上部と解析部で吸収します。

---

## 4. GitHub Pages設計

静的公開のみ。閲覧・履歴・管理の各HTMLと画像・JS/CSSを置くだけ。サーバー処理はGAS側なのでGitHubには秘密情報を置きません（APIキーはGASに保管）。

---

## 5. Leaflet実装方法

`index.html` が Leaflet を CDN 読込 → `js/map.js` が GASの `doGet` を30秒ごとに取得し、神輿を紋アイコンで描画。OpenStreetMapタイルを使用（無料）。

---

## 6. サンプルJSON（事業者APIの想定）

実URL：`https://ohwatcha.evolinq.link/api/items/current`（認証不要の公開GET）
```json
{ "data": [
  { "id": 2, "name": "中町", "lat": 36.78248, "lon": 137.08548,
    "update_at": "2026-07-29T13:55:35", "device_id": "354734101201693",
    "description": "見どころ説明…", "url": "https://instagram.com/…", "bat": 3 }
] }
```
※ このAPIは複数の祭り共用のため、全地域の端末が返ります。**Masterで対応づけた端末だけ**を表示します。
※ `lon`（経度）・`update_at`（TZ表記なし＝JST扱い）・`id`数値、いずれも自動で吸収します。
※ `description`＝見どころ、`url`＝関連リンク はポップアップに表示します。

---

## 7〜11. サンプルコード

| 項目 | 該当ファイル |
|---|---|
| 7. GASサンプル（API取得） | `gas/Code.gs` の `pullFromApi()` |
| 8. スプレッドシート更新 | `gas/Code.gs` の CurrentLocation上書き＋History追記 |
| 9. Leaflet表示 | `index.html` / `js/map.js` |
| 10. 位置履歴表示（軌跡） | 本日の軌跡＝メイン地図の「🧭 軌跡」ボタン／過去年度＝`history/` |
| 11. 通信断判定 | `js/map.js` の `calc()`（`OFFLINE_SEC`=300秒超で「通信断」） |

すべてコピペで動きます。編集は基本 `js/config.js`（表示）と `gas/Code.gs`（API設定）だけ。

---

## 12. エラーハンドリング

- API失敗（応答コード異常・空・例外）は **ErrorLogシート** に日時つきで記録し、処理は止めません（次の1分で再取得）。
- 閲覧側は取得失敗時に「接続できません（自動再試行）」を表示し、直前のデータを保持。
- `testApiOnce()` で、本番前にAPIの生データ・応答コードをログ確認できます。

---

## 13. 運用手順（初期セットアップ）

1. スプレッドシートを新規作成 → 拡張機能 → Apps Script に `Code.gs` を貼る
2. Code.gs 上部の **API_URL / API_KEY / ADMIN_KEY** を設定
3. 関数 **`testApiOnce`** を実行し、APIが取れるか・項目名を確認（実行ログを見る）
4. 関数 **`setupSheets`** を実行（4シート作成＋Master初期値）
5. 関数 **`listDevices`** を実行し、実行ログで全端末（id / device_id / 名前 / 位置）を確認
6. **Master の「APIのID」列**に、自分たちの端末の **id または device_id** を記入
   （このAPIは複数の祭りが共用。記入した端末だけが地図に出ます＝他祭りの端末は自動除外）
7. 関数 **`installTrigger`** を実行（1分ごとの取得開始）
8. デプロイ → ウェブアプリ（全員）→ URLを `js/config.js` の `GAS_URL` に貼る
9. GitHubに一式を配置（→15章）

---

## 14. 障害対策

| 症状 | 主因 | 対処 |
|---|---|---|
| 全神輿が出ない | APIのURL/認証ミス | ErrorLog確認。`testApiOnce` で応答を確認 |
| 特定の神輿が出ない | Masterの「APIのID」未設定・誤り | 該当端末IDをMasterに正しく設定 |
| 「通信断」表示 | 端末の電池切れ・圏外 | 端末の状態確認。数分で復帰することが多い |
| 位置がずれる | GPS精度低下（ビル陰等） | 数分で復帰。端末は空が見える向きに |
| 取得が時々飛ぶ | 一時的なAPI不調 | 1分後に自動再取得。ErrorLogで頻度確認 |

---

## 15. GitHubへの配置方法

1. GitHubで Public リポジトリを作成
2. `mikoshi-tracker` の**中身**（index.html・css・js・img・history・admin など）を直下にアップロード
3. Settings → Pages → Branch: main / (root) → Save
4. 公開URL：`https://ユーザー名.github.io/リポジトリ名/`

---

## 16. セキュリティ対策

- **APIキー・管理パスワードはGAS（Code.gs）に保管**。公開されるGitHub側（config.js）には置きません。
- 管理ページURL（/admin/）は運営内のみで共有。参加設定・削除は管理パスワード必須。
- 閲覧は公開情報（神輿の位置）のみ。個人情報は扱いません。
- 会場外の異常な座標が混じる場合は、Code.gs にジオフェンス（範囲外を捨てる）を追加できます。

---

## 17. 最終的な推奨構成

**ソラコムGPS端末 ＋ 事業者API ＋ GAS(1分pull) ＋ スプレッドシート ＋ GitHub Pages/Leaflet**

- 神輿側の作業は「端末を付けるだけ」。スマホ・SIM・送信操作が不要になり、当日の運用負荷が大幅減。
- サーバー費用0円は維持。開発範囲は「取得→蓄積→表示」に集約。
- 毎年の変更（参加地区・担当・端末の割当）は **Masterシートと管理ページ** だけで完結。

---

## フォルダ構成

```
mikoshi-tracker/
├── index.html          … 閲覧（地図）ページ
├── css/style.css       … 見た目
├── js/
│   ├── config.js       … 表示設定（GAS_URL・神輿の色/紋・トイレ・会場座標）
│   └── map.js          … 地図・一覧・検索・通信断・軌跡ON/OFF
├── img/ m01〜m14.png    … 地区紋アイコン
├── history/index.html  … 過去ルートの表示・再生・集計
├── admin/index.html    … 管理（参加・並び順・削除）
├── sender/index.html   … 【この方式では未使用】案内のみ
├── gas/Code.gs         … サーバー（API取得・保存・配信）
├── README.md           … このファイル（技術者向け）
└── 引き継ぎマニュアル.md … 主催者向け（非エンジニア向け）
```

閲覧 `…/` ／ 履歴 `…/history/` ／ 管理 `…/admin/`

---

## 18. 緊急用：スマホによる予備送信（画面ON前提）

ソラコム端末が足りない/故障したときの**穴埋め**として、スマホのブラウザから位置を送れます。

- URL：`…/sender/`（運営内のみ共有）
- 使い方：神輿を選ぶ → 書き込みキー（`Bebesheto`）を入力 → 送信開始
- **⚠ 画面を消す・別アプリ切替・スリープで停止します**（ブラウザの仕様。回避不可）。充電しながら画面ONで使用
- 二重送信防止：同じ神輿を別端末が送信中なら「他端末が送信中」で拒否
- **優先制御**：スマホ送信中の神輿は、API取得より優先（`MANUAL_TIMEOUT_SEC`＝180秒はAPIで上書きしない）。送信が止まって180秒経つと自動でAPI側へ戻る
- 地図では「📱 スマホ送信中（緊急）」と表示

### 設定（Code.gs）
- `SEND_KEY = "Bebesheto"`（緊急送信の書き込みキー）
- `MANUAL_TIMEOUT_SEC` / `CLAIM_TIMEOUT_SEC`（優先・ロックの秒数）

GAS無料枠：緊急用（数台・30秒間隔）でも上限に対し誤差。無料運用は維持されます。
