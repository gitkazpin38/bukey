// 部室の鍵ボード — GitHub Pages + Firebase 版
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, orderBy, limit, runTransaction, writeBatch, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const clubId = (params.get("club") || "").toLowerCase().trim();
const codeFromUrl = (params.get("code") || "").trim();

// guests: 「部員以外」として記録・譲渡した人の名前。鍵を守衛さんに返すと空になる（選択肢から消える）
const DEFAULT_STATE = { key: "guard", holder: "", holderUid: "", holderGuest: false, guests: [], room: "closed", since: 0, returnBy: "", note: "" };
const ACT_LABEL = { borrow: "借りた", open: "開けた", lock: "閉めた", hold: "持っている", return: "返した", hand: "渡した", fix: "訂正", undo: "取消", redo: "戻した" };
const ACT_CLASS = { borrow: "a-borrow", open: "a-open", lock: "a-lock", hold: "a-hold", return: "a-return", hand: "a-hand", fix: "a-fix", undo: "a-fix", redo: "a-fix" };

let user = null, me = null, club = null, state = { ...DEFAULT_STATE }, logs = [], members = [];
let busy = false, ready = false, unsubs = [];

// ---------------- helpers ----------------
const pad = n => String(n).padStart(2, "0");
const hm = ms => { const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const fmtWhen = ms => {
  const d = new Date(ms), now = new Date();
  return d.toDateString() === now.toDateString() ? "今日 " + hm(ms) : (d.getMonth() + 1) + "/" + d.getDate() + " " + hm(ms);
};
const ago = ms => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "たった今";
  if (m < 60) return m + "分前";
  const h = Math.floor(m / 60); return h + "時間" + (m % 60 ? (m % 60) + "分" : "") + "前";
};
const minutesOf = t => { if (!t) return null; const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const san = (s, n = 20) => String(s || "").trim().slice(0, n);
const randomCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const a = new Uint32Array(8); crypto.getRandomValues(a);
  return Array.from(a, x => chars[x % chars.length]).join("");
};
const sameState = (a, b) => a && b && a.key === b.key && (a.holder || "") === (b.holder || "") && a.room === b.room && (a.since || 0) === (b.since || 0);
// 鍵を持っている人の表示名。部員以外のときは必ず「（部員以外）」を付ける
const holderText = s => s.holder ? s.holder + "さん" + (s.holderGuest ? "（部員以外）" : "") : "（不明）";
const stateLabel = s => {
  const h = holderText(s);
  const k = s.key === "guard" ? "守衛室" : s.key === "holding" ? h + "が持っている" : h + "が借りている";
  return "鍵: " + k + " ／ 部室: " + (s.room === "open" ? "開いている" : "閉まっている");
};
const clubRef = () => doc(db, "clubs", clubId);
const stateRef = () => doc(db, "clubs", clubId, "state", "main");
const logCol = () => collection(db, "clubs", clubId, "log");

function show(view) {
  ["signin", "home", "join", "missing", "board"].forEach(v => { $("v-" + v).hidden = v !== view; });
}
function setConn(t) { $("conn").textContent = t; }
function setMsg(t, kind, undoId, redoId) {
  const m = $("msg"); m.textContent = t || ""; m.className = "msg" + (kind ? " " + kind : "");
  if (undoId) {
    const b = document.createElement("button"); b.type = "button"; b.className = "undo-btn"; b.textContent = "取り消す";
    b.onclick = () => undo(undoId); m.append(" ", b);
  }
  if (redoId) {
    const b = document.createElement("button"); b.type = "button"; b.className = "undo-btn redo-btn"; b.textContent = "元に戻す";
    b.onclick = () => redo(redoId); m.append(" ", b);
  }
}
function errText(e) {
  const c = e && e.code;
  if (c === "permission-denied") return "この操作をする権限がありません。";
  if (c === "unavailable") return "通信できませんでした。電波を確認してもう一度押してください。";
  return (e && e.message) || "うまくいきませんでした。もう一度試してください。";
}

// ---------------- confirm dialog ----------------
function confirmBox(title, lines, okLabel) {
  return new Promise(resolve => {
    const ov = $("dlg"), last = document.activeElement;
    $("dlgTitle").textContent = title;
    const body = $("dlgBody"); body.innerHTML = "";
    lines.forEach(([lab, val, cls]) => {
      const r = document.createElement("div"); r.className = "dlg-row" + (cls ? " " + cls : "");
      const a = document.createElement("span"); a.className = "dlg-lab"; a.textContent = lab;
      const b = document.createElement("span"); b.textContent = val;
      r.append(a, b); body.append(r);
    });
    $("dlgOk").textContent = okLabel || "OK";
    ov.hidden = false; $("dlgOk").focus();
    const done = v => {
      ov.hidden = true; $("dlgOk").onclick = $("dlgNo").onclick = ov.onclick = null;
      document.removeEventListener("keydown", key); if (last && last.focus) last.focus(); resolve(v);
    };
    const key = e => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", key);
    $("dlgOk").onclick = () => done(true);
    $("dlgNo").onclick = () => done(false);
    ov.onclick = e => { if (e.target === ov) done(false); };
  });
}

// ---------------- auth ----------------
// ポップアップが使えないときはリダイレクトでログインする。ただし GitHub Pages とログイン用ドメイン
// （firebaseapp.com）が別なので、ブラウザによっては戻ってきてもログインできていない。
// そのときは黙って失敗しないよう、Safari / Chrome で開き直す案内を出す。
const REDIRECT_KEY = "bukey-signin-redirect-at";
const ss = {
  get: () => { try { return sessionStorage.getItem(REDIRECT_KEY); } catch { return null; } },
  set: v => { try { sessionStorage.setItem(REDIRECT_KEY, v); } catch {} },
  del: () => { try { sessionStorage.removeItem(REDIRECT_KEY); } catch {} },
};
// LINE / Instagram / Facebook / X などのアプリ内ブラウザ
const IN_APP = /\bLine\/|FBAN|FBAV|Instagram|Twitter|MicroMessenger|KAKAOTALK|; wv\)/i.test(navigator.userAgent);

function showSigninHelp(kind) {
  const box = $("signinHelp");
  if (!kind) { box.hidden = true; return; }
  box.className = "alert " + (kind === "failed" ? "bad" : "warn");
  $("signinHelpText").textContent = kind === "failed"
    ? "ログインできませんでした。このブラウザではログインが完了しないことがあります。このページのURLをコピーして、Safari か Chrome で開き直してください。"
    : "LINE などのアプリの中で開いているため、ログインできないことがあります。うまくいかないときは、URLをコピーして Safari か Chrome で開いてください。";
  box.hidden = false;
}
$("copyUrlBtn").onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); $("copyUrlBtn").textContent = "コピーしました"; }
  catch { window.prompt("このURLをコピーしてください", location.href); }
};
if (IN_APP) showSigninHelp("inapp");

// リダイレクトから戻ってきたときの結果。ログインできていなければ案内を出す
getRedirectResult(auth).catch(e => e).then(r => {
  const tried = ss.get(); ss.del();
  if (!tried || auth.currentUser) return;
  showSigninHelp("failed");
  if (r && r.code) setConn("ログインできませんでした: " + errText(r));
});

$("signInBtn").onclick = async () => {
  const provider = new GoogleAuthProvider();
  showSigninHelp(IN_APP ? "inapp" : null);
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      ss.set(String(Date.now()));
      try { await signInWithRedirect(auth, provider); }
      catch (e2) { ss.del(); showSigninHelp("failed"); setConn("ログインできませんでした: " + errText(e2)); }
    } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      showSigninHelp("failed");
      setConn("ログインできませんでした: " + errText(e));
    }
  }
};
$("signOutBtn").onclick = () => signOut(auth);

onAuthStateChanged(auth, async u => {
  unsubs.forEach(f => f()); unsubs = [];
  user = u; me = null; club = null; ready = false;
  $("who").hidden = !u; $("keyTag").hidden = true; $("homeLink").hidden = !clubId;
  if (!u) { setConn("ログインしていません"); show("signin"); return; }
  $("whoName").textContent = u.displayName || u.email || "";
  try {
    if (!clubId) await showHome();
    else await enterClub();
  } catch (e) { setConn(errText(e)); }
});

// ---------------- home ----------------
async function showHome() {
  $("title").textContent = "部室の鍵ボード";
  document.title = "部室の鍵ボード";
  setConn("参加する部活を選んでください");
  show("home");
  $("ccMe").value = $("ccMe").value || (user.displayName || "").split(/\s+/)[0].slice(0, 20);
  const snap = await getDoc(doc(db, "users", user.uid));
  const list = (snap.exists() && snap.data().clubs) || [];
  const ul = $("myClubs"); ul.innerHTML = "";
  if (!list.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "まだ参加している部活はありません。"; ul.append(li); return; }
  list.forEach(c => {
    const li = document.createElement("li");
    const a = document.createElement("a"); a.href = "?club=" + encodeURIComponent(c.id); a.textContent = c.name || c.id;
    const s = document.createElement("span"); s.className = "cid"; s.textContent = c.id;
    li.append(a, s); ul.append(li);
  });
}

$("joinJump").onsubmit = e => {
  e.preventDefault();
  const id = san($("jjClub").value, 32).toLowerCase(), code = san($("jjCode").value, 32);
  if (!id) return;
  location.search = "?club=" + encodeURIComponent(id) + (code ? "&code=" + encodeURIComponent(code) : "");
};

$("createClub").onsubmit = async e => {
  e.preventDefault();
  const id = san($("ccId").value, 32).toLowerCase();
  const name = san($("ccName").value, 30), keyNo = san($("ccKey").value, 10);
  const closeTime = $("ccClose").value || "20:00", myName = san($("ccMe").value);
  if (!/^[a-z0-9-]{3,32}$/.test(id)) { setConn("部活IDは英小文字・数字・ハイフンで3〜32字にしてください。"); return; }
  if (!name || !myName) return;
  try {
    const exists = await getDoc(doc(db, "clubs", id));
    if (exists.exists()) { setConn("その部活IDはもう使われています。別のIDにしてください。"); return; }
    const b = writeBatch(db);
    b.set(doc(db, "clubs", id), { name, keyNo, closeTime, ownerUid: user.uid, createdAt: Date.now() });
    b.set(doc(db, "clubs", id, "members", user.uid), { uid: user.uid, name: myName, role: "admin", joinedAt: Date.now() });
    await b.commit();
    await setDoc(doc(db, "clubs", id, "private", "invite"), { code: randomCode(), updatedAt: Date.now() });
    await setDoc(doc(db, "users", user.uid), { clubs: arrayUnion({ id, name }) }, { merge: true });
    location.search = "?club=" + encodeURIComponent(id);
  } catch (err) { setConn("登録できませんでした: " + errText(err)); }
};

// ---------------- join / enter ----------------
async function enterClub() {
  const cs = await getDoc(clubRef());
  if (!cs.exists()) { setConn(""); show("missing"); removeFromMyList(clubId).catch(() => {}); return; }
  club = cs.data();
  applyClubHeader();
  const ms = await getDoc(doc(db, "clubs", clubId, "members", user.uid));
  if (!ms.exists()) {
    $("joinClubName").textContent = club.name || clubId;
    $("joinCode").value = codeFromUrl;
    $("joinName").value = (user.displayName || "").split(/\s+/)[0].slice(0, 20);
    setConn("この部活にはまだ参加していません");
    show("join");
    return;
  }
  startBoard();
}

$("joinForm").onsubmit = async e => {
  e.preventDefault();
  const code = san($("joinCode").value, 32).toUpperCase(), name = san($("joinName").value);
  if (!code || !name) return;
  try {
    await setDoc(doc(db, "clubs", clubId, "members", user.uid), { uid: user.uid, name, role: "member", joinCode: code, joinedAt: Date.now() });
    await setDoc(doc(db, "users", user.uid), { clubs: arrayUnion({ id: clubId, name: club.name || clubId }) }, { merge: true });
    history.replaceState(null, "", "?club=" + encodeURIComponent(clubId));
    startBoard();
  } catch (err) {
    setConn(err && err.code === "permission-denied" ? "招待コードが違います。管理者に確認してください。" : "参加できませんでした: " + errText(err));
  }
};

function applyClubHeader() {
  const name = (club && club.name) || clubId;
  $("title").textContent = name + " の鍵";
  document.title = name + " の鍵 | 部室の鍵ボード";
  $("keyNo").textContent = (club && club.keyNo) || "未設定";
  $("keyTag").hidden = false;
  $("delClubId").textContent = clubId;
}

// 自分の部活一覧から外す（削除された部活が一覧に残らないように）
async function removeFromMyList(id) {
  const ref = doc(db, "users", user.uid);
  const s = await getDoc(ref);
  if (!s.exists()) return;
  const list = s.data().clubs || [];
  if (!list.some(c => c.id === id)) return;
  await setDoc(ref, { clubs: list.filter(c => c.id !== id) }, { merge: true });
}

// ---------------- board ----------------
function startBoard() {
  show("board");
  setConn("接続中…");
  const timer = setTimeout(() => setConn("データにつながりません。表示が古い可能性があります。"), 10000);

  unsubs.push(onSnapshot(clubRef(), s => { if (s.exists()) { club = s.data(); applyClubHeader(); render(); } }));
  unsubs.push(onSnapshot(doc(db, "clubs", clubId, "members", user.uid), s => {
    if (!s.exists()) { setConn("この部活から外されました。"); unsubs.forEach(f => f()); unsubs = []; show("missing"); return; }
    me = s.data(); fillActor();
    if (document.activeElement !== $("myName")) $("myName").value = me.name || "";
    $("adminCard").hidden = me.role !== "admin";
    if (me.role === "admin") loadInvite();
    render();
  }));
  unsubs.push(onSnapshot(collection(db, "clubs", clubId, "members"), qs => {
    members = qs.docs.map(d => d.data()).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    const dl = $("memberNames"); dl.innerHTML = "";
    members.forEach(m => { const o = document.createElement("option"); o.value = m.name; dl.append(o); });
    renderMembers(); fillActor();
    if (!$("handPanel").hidden) fillHandTo();
  }, () => {}));
  unsubs.push(onSnapshot(stateRef(), s => {
    state = s.exists() ? { ...DEFAULT_STATE, ...s.data() } : { ...DEFAULT_STATE };
    if (!s.metadata.fromCache) { clearTimeout(timer); setConn("みんなの画面とリアルタイムで同期中"); }
    ready = true; fillActor(); render();
  }, e => { clearTimeout(timer); setConn("同期できません: " + errText(e)); }));
  unsubs.push(onSnapshot(query(logCol(), orderBy("ms", "desc"), limit(40)), qs => {
    logs = qs.docs.map(d => ({ ...d.data(), id: d.id })); renderLog();
  }, () => {}));
}

setInterval(() => { if (ready) render(); }, 30000);

function render() {
  if (!ready) return;
  const s = state;
  ["borrowed", "holding", "guard"].forEach(k => $("L-" + k).classList.toggle("on", s.key === k));
  $("L-open").classList.toggle("on", s.room === "open");
  $("L-closed").classList.toggle("on", s.room === "closed");

  const sum = $("summary"); sum.innerHTML = "";
  const who = document.createDocumentFragment();
  const whoName = Object.assign(document.createElement("b"), { textContent: s.holder ? s.holder + "さん" : "誰か" });
  who.append(whoName);
  if (s.holderGuest && s.holder) { whoName.className = "guest"; who.append(guestTag()); }
  if (s.key === "guard") sum.textContent = "部室は閉まっています。鍵は守衛室にあります。";
  else if (s.room === "open") sum.append("部室は開いています。鍵は ", who, " が借りています。");
  else if (s.key === "holding") sum.append("部室は閉まっています。鍵は ", who, " が持っています。");
  else sum.append("部室は閉まっています。鍵は ", who, " が借りています。");

  const sl = $("subline"); sl.innerHTML = "";
  if (s.since) {
    const t = document.createElement("span"); t.className = "t"; t.textContent = fmtWhen(s.since);
    const who = s.actor || s.by;
    sl.append("最終更新 ", t, "（" + ago(s.since) + (who ? "・" + who + "さん" + (s.actorGuest ? "（部員以外）" : "") : "") + (s.actor && s.by && (s.actor !== s.by || s.actorGuest) ? "、記録: " + s.by + "さん" : "") + "）");
    if (s.key === "holding" && s.returnBy) {
      const r = document.createElement("span"); r.className = "t"; r.textContent = s.returnBy;
      sl.append(" ・ 返却予定 ", r);
    }
    if (s.note) sl.append(" ・ " + s.note);
  } else sl.textContent = "まだ記録がありません。鍵は守衛室にある前提で始めます。";

  renderAlerts(); renderButtons(); renderLog(); renderMembers();
  if (club && me && me.role === "admin") {
    if (document.activeElement !== $("cfgName")) $("cfgName").value = club.name || "";
    if (document.activeElement !== $("cfgKey")) $("cfgKey").value = club.keyNo || "";
    if (document.activeElement !== $("cfgClose")) $("cfgClose").value = club.closeTime || "";
  }
}

function renderAlerts() {
  const box = $("alerts"); box.innerHTML = "";
  const add = (cls, text) => { const d = document.createElement("div"); d.className = "alert " + cls; d.textContent = text; box.append(d); };
  const s = state, closeTime = (club && club.closeTime) || "20:00";
  const close = minutesOf(closeTime), now = nowMin(), pastClose = close !== null && now >= close;
  const who = s.holder ? holderText(s) : "鍵を持っている人";
  if (s.key !== "guard" && pastClose) add("bad", "最終返却時刻（" + closeTime + "）を過ぎています。" + who + "、施錠して守衛さんに鍵を返してください。家に持ち帰らないこと。");
  else if (s.key !== "guard" && s.since && new Date(s.since).toDateString() !== new Date().toDateString()) add("bad", "前日から鍵が返却されていません。" + who + "、すぐに守衛さんへ返してください。");
  if (s.key === "borrowed" && s.room === "closed" && s.since && Date.now() - s.since > 30 * 60000)
    add("warn", "施錠後（または借りた後）30分以上たっています。守衛さんに「返した」か、自分で「持っている」かを記録してください。");
  if (s.key === "holding" && s.returnBy) {
    const r = minutesOf(s.returnBy);
    if (r !== null && now > r && !pastClose) add("warn", "返却予定（" + s.returnBy + "）を過ぎています。" + who + "、返したら記録してください。");
  }
}

function btn(label, sub, cls, fn) {
  const b = document.createElement("button"); b.type = "button"; if (cls) b.className = cls;
  const t = document.createElement("span"); t.textContent = label; b.append(t);
  if (sub) { const s = document.createElement("small"); s.textContent = sub; b.append(s); }
  b.disabled = busy || !me; b.addEventListener("click", fn); return b;
}

function renderButtons() {
  const box = $("btns"); box.innerHTML = "";
  const s = state;
  if (s.key === "guard") {
    box.append(btn("鍵を借りた", "守衛さんから受け取ったら押す", "primary", () => act("borrow")));
  } else if (s.room === "closed") {
    box.append(btn("部室を開けた", "解錠して中に入る", "go", () => act("open")));
    box.append(btn("守衛さんに返した", "鍵を返却したら押す", "primary", () => act("return")));
    const a = currentActor();
    if (s.key === "borrowed") box.append(btn(a.self ? "自分で持っている" : (a.name ? a.name + "さん" : "部員以外の人") + "が持っている", "返却時刻を決めて記録", "", () => showPanel("hold")));
    box.append(btn("鍵を別の人に渡した", "鍵の持ち主を変える", "", () => showPanel("hand")));
  } else {
    box.append(btn("部室を閉めた", "施錠したら押す。返却・保持はこのあと記録", "primary", () => act("lock")));
    box.append(btn("鍵を別の人に渡した", "部室は開けたまま、鍵の持ち主だけ変える", "", () => showPanel("hand")));
  }
}

function renderLog() {
  const ul = $("log"); ul.innerHTML = "";
  // 取り消せるのは、取り消し・元に戻す・取り消し済み 以外で一番新しい記録。押した本人（byUid）だけ。
  // 続けて取り消すと1つずつさかのぼれる（いまの状態がその記録の直後と一致するときだけ）
  const latest = logs.find(l => l.action !== "undo" && l.action !== "redo" && !l.undone);
  const undoableId = (latest && latest.prev && !latest.undone && user && latest.byUid === user.uid && sameState(state, latest.next)) ? latest.id : null;
  // 元に戻せるのは、一番新しい記録が自分の「取り消し」で、そのあと状態が変わっていないときだけ
  const top = logs[0];
  const redoableId = (top && top.action === "undo" && top.target && top.next && !top.redone && user && top.byUid === user.uid && sameState(state, top.next)) ? top.id : null;
  if (!logs.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "まだ記録がありません。"; ul.append(li); return; }
  logs.forEach(d => {
    const li = document.createElement("li");
    const w = document.createElement("span"); w.className = "when"; w.textContent = fmtWhen(d.ms || 0);
    const body = document.createElement("span");
    const a = document.createElement("span"); a.className = "act " + (ACT_CLASS[d.action] || ""); a.textContent = ACT_LABEL[d.action] || d.action;
    const tx = document.createElement("span"); tx.textContent = String(d.text || ""); if (d.undone) tx.className = "undone";
    body.append(a, tx);
    if (d.action === "hand" && d.next && d.next.holderGuest) body.append(guestTag());
    if (d.undone) { const u = document.createElement("span"); u.className = "undone-note"; u.textContent = " 取り消し済み"; body.append(u); }
    if (d.id === undoableId) {
      const b = document.createElement("button"); b.type = "button"; b.className = "undo-btn"; b.textContent = "取り消す";
      b.disabled = busy; b.onclick = () => undo(d.id); body.append(" ", b);
    }
    if (d.id === redoableId) {
      const b = document.createElement("button"); b.type = "button"; b.className = "undo-btn redo-btn"; b.textContent = "元に戻す";
      b.disabled = busy; b.onclick = () => redo(d.id); body.append(" ", b);
    }
    li.append(w, body); ul.append(li);
  });
}

// ---------------- 誰として記録するか ----------------
// 選択肢の値: 部員は uid、記録済みの部員以外は "guest:名前"、新しい部員以外は NEW_GUEST
const NEW_GUEST = "__new_guest__";
// 選択肢に出す部員以外の名前（記録中の guests と、いま鍵を持っている部員以外）
const guestNames = () => [...new Set([...(state.guests || []),
  ...(state.key !== "guard" && state.holderGuest && state.holder ? [state.holder] : [])])];
function currentActor() {
  const v = $("actorSel").value;
  const self = { name: me ? me.name : "", uid: user ? user.uid : "", self: true, guest: false };
  if (v === NEW_GUEST) return { name: san($("actorGuest").value), uid: "", self: false, guest: true };
  if (v && v.startsWith("guest:")) {
    const name = v.slice(6);
    return guestNames().includes(name) ? { name, uid: "", self: false, guest: true } : self;
  }
  const m = members.find(x => x.uid === v);
  if (!m || !user || v === user.uid) return self;
  return { name: m.name, uid: m.uid, self: false, guest: false };
}
function fillActor() {
  const sel = $("actorSel"); if (!user) return;
  const cur = sel.value || user.uid;
  sel.innerHTML = "";
  const list = members.length ? members : (me ? [me] : []);
  const add = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; sel.append(o); };
  // 自分を先頭に、部員、記録中の部員以外、新しく部員以外を足す
  [...list].sort((a, b) => (b.uid === user.uid) - (a.uid === user.uid))
    .forEach(m => add(m.uid, m.uid === user.uid ? m.name + "（自分）" : m.name));
  guestNames().forEach(g => add("guest:" + g, g + "（部員以外）"));
  add(NEW_GUEST, "＋ 部員以外の人…");
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : user.uid;
  syncActor();
}
function syncActor() {
  const a = currentActor(), isNew = $("actorSel").value === NEW_GUEST;
  $("actorGuest").hidden = !isNew;
  $("actorRow").classList.toggle("proxy", !a.self);
  $("actorRow").classList.toggle("guest", !!a.guest);
  $("actorNote").hidden = a.self;
  const label = a.name ? a.name + "さん" + (a.guest ? "（部員以外）" : "") : "部員以外の人";
  $("actorNote").textContent = a.self ? "" : label + "として記録します。記録者（" + (me ? me.name : "") + "さん）も履歴に残ります。"
    + (a.guest ? "部員以外の人は、鍵を守衛さんに返すと選択肢から消えます。" : "") + "記録すると自分に戻ります。";
  if (ready) renderButtons();
}
function resetActor() { $("actorSel").value = user.uid; $("actorGuest").value = ""; syncActor(); }
$("actorSel").onchange = () => { syncActor(); if ($("actorSel").value === NEW_GUEST) $("actorGuest").focus(); };
$("actorGuest").oninput = syncActor;

function showPanel(which, hint) {
  $("holdPanel").hidden = which !== "hold";
  $("handPanel").hidden = which !== "hand";
  $("holdHint").hidden = !(which === "hold" && hint);
  if (which === "hold") {
    if (!$("holdUntil").value) $("holdUntil").value = (club && club.closeTime) || "20:00";
    $("holdPledge").checked = false;
    if (hint) $("holdPanel").scrollIntoView({ block: "center", behavior: "smooth" });
    else $("holdUntil").focus();
  }
  if (which === "hand") {
    $("handGuestOn").checked = false; $("handGuest").value = ""; syncHandGuest();
    fillHandTo(""); $("handTo").focus();
  }
}
// 施錠後: 「持っている」の欄を開き、誰として記録するかを鍵を持っている人に合わせる
function promptHold(n) {
  const sel = $("actorSel");
  const v = n.holderGuest ? "guest:" + n.holder : n.holderUid;
  if (v && [...sel.options].some(o => o.value === v)) { sel.value = v; syncActor(); }
  showPanel("hold", true);
}
function guestTag() { return Object.assign(document.createElement("span"), { className: "guest-tag", textContent: "部員以外" }); }
const isHolder = (m, s) => s.key !== "guard" && (s.holderUid ? m.uid === s.holderUid : (!s.holderGuest && m.name === s.holder));
// 受け取る人は参加している部員から選ぶ（いま持っている人は除く）
function fillHandTo(keep) {
  const sel = $("handTo"), cur = keep === undefined ? sel.value : keep;
  sel.innerHTML = "";
  const others = members.filter(m => !isHolder(m, state));
  const first = document.createElement("option"); first.value = "";
  first.textContent = others.length ? "選んでください" : "ほかの部員がいません（招待してください）";
  sel.append(first);
  others.forEach(m => { const o = document.createElement("option"); o.value = m.uid; o.textContent = m.name + (m.uid === user.uid ? "（自分）" : ""); sel.append(o); });
  sel.value = others.some(m => m.uid === cur) ? cur : "";
}
function syncHandGuest() {
  const on = $("handGuestOn").checked;
  $("handGuestBox").hidden = !on; $("handTo").disabled = on;
  if (on) $("handGuest").focus();
}
$("handGuestOn").onchange = syncHandGuest;
$("holdCancel").onclick = () => showPanel(null);
$("handCancel").onclick = () => showPanel(null);
$("holdGo").onclick = () => act("hold");
$("handGo").onclick = () => act("hand");
$("fixGo").onclick = () => act("fix");

// ---------------- state transitions ----------------
// who = { name, uid, self }：誰として記録するか。myName は押した本人（記録者）
function plan(kind, cur, myName, who) {
  who = who || { name: myName, uid: user.uid, self: true, guest: false };
  let next = { ...cur }, text = "";
  const closeTime = (club && club.closeTime) || "20:00";
  const by = who.self ? "" : "（記録: " + myName + "さん）";
  const wn = who.name + "さん" + (who.guest ? "（部員以外）" : "");
  switch (kind) {
    case "borrow":
      if (cur.key !== "guard") throw new Error("鍵はすでに" + holderText(cur) + "が持っています。画面を確認してください。");
      next = { key: "borrowed", holder: who.name, holderUid: who.uid, holderGuest: !!who.guest, room: "closed", returnBy: "", note: "" };
      text = wn + "が守衛さんから鍵を借りた" + by; break;
    case "open":
      if (cur.key === "guard") throw new Error("鍵は守衛室にあります。先に「鍵を借りた」を記録してください。");
      if (cur.room === "open") throw new Error("部室はすでに開いています。");
      next = { ...cur, key: "borrowed", room: "open", returnBy: "", note: "" };
      text = wn + "が部室を開けた（鍵: " + holderText(cur) + "）" + by; break;
    case "lock":
      if (cur.room !== "open") throw new Error("部室はすでに閉まっています。");
      next = { ...cur, room: "closed" };
      text = wn + "が部室を閉めた（鍵: " + holderText(cur) + "）" + by; break;
    case "return":
      if (cur.key === "guard") throw new Error("鍵はすでに守衛室にあります。");
      if (cur.room === "open") throw new Error("部室が開いたままです。先に施錠してください。");
      next = { ...DEFAULT_STATE };
      text = wn + "が守衛さんに鍵を返した" + by; break;
    case "hold": {
      if (cur.key === "guard") throw new Error("鍵は守衛室にあります。");
      if (cur.room === "open") throw new Error("部室が開いたままです。先に施錠してください。");
      const until = $("holdUntil").value;
      if (!until) throw new Error("返却する時刻を入れてください。");
      const close = minutesOf(closeTime);
      if (close !== null && minutesOf(until) > close) throw new Error("最終返却時刻（" + closeTime + "）より後にはできません。");
      if (!$("holdPledge").checked) throw new Error("確認のチェックを入れてください。");
      const note = san($("holdNote").value, 60);
      next = { ...cur, key: "holding", holder: who.name, holderUid: who.uid, holderGuest: !!who.guest, room: "closed", returnBy: until, note };
      text = wn + "が鍵を持っている（" + until + "までに返却予定）" + (note ? "：「" + note + "」" : "") + by; break;
    }
    case "hand": {
      if (cur.key === "guard") throw new Error("鍵は守衛室にあります。");
      let to, toUid = "", guest = $("handGuestOn").checked;
      if (guest) {
        to = san($("handGuest").value);
        if (!to) throw new Error("受け取る人（部員以外）の名前を入れてください。");
      } else {
        const m = members.find(x => x.uid === $("handTo").value);
        if (!m) throw new Error("受け取る部員を選んでください。");
        if (isHolder(m, cur)) throw new Error("鍵はすでに" + m.name + "さんが持っています。");
        to = m.name; toUid = m.uid;
      }
      next = { ...cur, holder: to, holderUid: toUid, holderGuest: guest };
      text = holderText(cur) + " → " + to + "さん" + (guest ? "（部員以外）" : "") + "に鍵を渡した" + (cur.room === "open" ? "（部室は開いたまま）" : "") + "（記録: " + myName + "さん）"; break;
    }
    case "fix": {
      const k = $("fixKey").value, r = $("fixRoom").value, h = san($("fixHolder").value);
      if (k === "guard" && r === "open") throw new Error("鍵が守衛室にあるのに部室が開いている状態は記録できません。");
      if (k !== "guard" && !h) throw new Error("鍵を持っている人の名前を入れてください。");
      const fixM = k === "guard" ? null : members.find(x => x.name === h);
      next = { key: k, holder: k === "guard" ? "" : h, holderUid: fixM ? fixM.uid : "", holderGuest: false, guests: cur.guests || [], room: r, returnBy: "", note: "" };
      const kl = { guard: "守衛室", borrowed: h + "さんが借用", holding: h + "さんが保持" }[k];
      text = myName + "さんが状態を訂正：鍵=" + kl + "、部室=" + (r === "open" ? "開" : "閉"); break;
    }
  }
  // 部員以外の名前は、鍵が守衛室に戻るまで選択肢に残す
  next.guests = next.key === "guard" ? [] : [...new Set([
    ...(cur.guests || []), ...(who.guest && who.name ? [who.name] : []), ...(next.holderGuest && next.holder ? [next.holder] : []),
  ])];
  return { next, text };
}

// 「誰として記録する」を使うのは、借りた・開けた・閉めた・返した・持っている。渡した・訂正は押した本人として記録
const ACTOR_KINDS = ["borrow", "open", "lock", "return", "hold"];
async function act(kind) {
  if (busy || !me) return;
  const myName = me.name;
  const sel = currentActor();
  const who = ACTOR_KINDS.includes(kind) ? sel : { name: myName, uid: user.uid, self: true, guest: false };
  if (who.guest && !who.name) { setMsg("「誰として記録する？」に部員以外の人の名前を入れてください。", "err"); $("actorGuest").focus(); return; }
  let preview;
  try { preview = plan(kind, { ...state }, myName, who); } catch (e) { setMsg(e.message, "err"); return; }
  const rows = [["操作", preview.text], ["いま", stateLabel(state)], ["記録後", stateLabel(preview.next), "after"]];
  if (!who.self) rows.splice(1, 0, ["代理記録", who.name + "さん" + (who.guest ? "（部員以外）" : "") + "として、" + myName + "さんが記録します"]);
  const ok = await confirmBox("この内容で記録しますか？", rows, ACT_LABEL[kind] + " を記録");
  if (!ok) { setMsg("取りやめました。"); return; }
  busy = true; render(); setMsg("記録中…");
  try {
    const logRef = doc(logCol());
    const res = await runTransaction(db, async tx => {
      const s = await tx.get(stateRef());
      const cur = s.exists() ? { ...DEFAULT_STATE, ...s.data() } : { ...DEFAULT_STATE };
      const { next, text } = plan(kind, cur, myName, who);
      const now = Date.now();
      Object.assign(next, { since: now, by: myName, byUid: user.uid, actor: who.name, actorUid: who.uid, actorGuest: !!who.guest });
      tx.set(stateRef(), next);
      tx.set(logRef, { ms: now, action: kind, text, prev: cur, next, undone: false, by: myName, byUid: user.uid, actor: who.name, actorUid: who.uid, actorGuest: !!who.guest });
      return { text, next };
    });
    const text = res.text;
    showPanel(null);
    if (!who.self) resetActor(); // 代理記録は1回ごとに自分に戻す
    // 部室を閉めたら、鍵をどうするか（返す／持っている）を促す。強制ではない
    if (kind === "lock" && res.next.key === "borrowed") promptHold(res.next);
    setMsg("記録しました：「" + text + "」", "ok", logRef.id);
  } catch (e) { setMsg(errText(e), "err"); }
  finally { busy = false; render(); }
}

async function undo(logId) {
  if (busy || !me) return;
  const entry = logs.find(l => l.id === logId);
  if (!entry || !entry.prev || entry.undone) { setMsg("この記録は取り消せません。", "err"); return; }
  if (entry.byUid !== user.uid) { setMsg("取り消せるのは、その操作を記録した本人（" + (entry.by || "") + "さん）だけです。", "err"); return; }
  if (!sameState(state, entry.next)) { setMsg("このあとに別の操作が記録されているため取り消せません。必要なら「記録の訂正」を使ってください。", "err"); return; }
  const prev = { ...DEFAULT_STATE, ...entry.prev };
  const ok = await confirmBox("この記録を取り消しますか？", [
    ["取り消す操作", entry.text], ["いま", stateLabel(state)], ["取り消し後", stateLabel(prev), "after"],
  ], "取り消す");
  if (!ok) { setMsg("取りやめました。"); return; }
  busy = true; render(); setMsg("取り消し中…");
  const undoRef = doc(logCol());
  try {
    await runTransaction(db, async tx => {
      const entryRef = doc(db, "clubs", clubId, "log", logId);
      const [s, l] = [await tx.get(stateRef()), await tx.get(entryRef)];
      const cur = s.exists() ? { ...DEFAULT_STATE, ...s.data() } : { ...DEFAULT_STATE };
      if (!l.exists() || l.data().undone || !sameState(cur, l.data().next))
        throw new Error("直前に別の人が操作したため取り消せませんでした。画面を確認してください。");
      const restored = { ...prev, by: me.name, byUid: user.uid, actor: me.name, actorUid: user.uid, actorGuest: false };
      tx.set(stateRef(), restored);
      tx.update(entryRef, { undone: true, undoneBy: me.name });
      // 元に戻す ために、取り消す前（prev）と後（next）の状態、対象の記録を残す
      tx.set(undoRef, { ms: Date.now(), action: "undo", text: me.name + "さんが「" + entry.text + "」を取り消した", by: me.name, byUid: user.uid,
        target: logId, prev: cur, next: restored, redone: false });
    });
    setMsg("取り消しました。", "ok", null, undoRef.id);
  } catch (e) { setMsg(errText(e), "err"); }
  finally { busy = false; render(); }
}

// 取り消しを取り消す（元に戻す）。取り消した本人だけ、そのあと状態が変わっていないときだけ
async function redo(undoId) {
  if (busy || !me) return;
  const u = logs.find(l => l.id === undoId);
  if (!u || u.action !== "undo" || !u.target || !u.prev || u.redone) { setMsg("この取り消しは元に戻せません。", "err"); return; }
  if (u.byUid !== user.uid) { setMsg("元に戻せるのは、取り消した本人（" + (u.by || "") + "さん）だけです。", "err"); return; }
  if (!sameState(state, u.next)) { setMsg("このあとに別の操作が記録されているため元に戻せません。", "err"); return; }
  const back = { ...DEFAULT_STATE, ...u.prev };
  const target = logs.find(l => l.id === u.target);
  const ok = await confirmBox("取り消しを元に戻しますか？", [
    ["元に戻す操作", target ? target.text : "（取り消した記録）"], ["いま", stateLabel(state)], ["元に戻した後", stateLabel(back), "after"],
  ], "元に戻す");
  if (!ok) { setMsg("取りやめました。"); return; }
  busy = true; render(); setMsg("元に戻しています…");
  try {
    await runTransaction(db, async tx => {
      const uRef = doc(db, "clubs", clubId, "log", undoId), tRef = doc(db, "clubs", clubId, "log", u.target);
      const [s, ul, tl] = [await tx.get(stateRef()), await tx.get(uRef), await tx.get(tRef)];
      const cur = s.exists() ? { ...DEFAULT_STATE, ...s.data() } : { ...DEFAULT_STATE };
      if (!ul.exists() || ul.data().redone || !sameState(cur, ul.data().next) || !tl.exists())
        throw new Error("直前に別の人が操作したため元に戻せませんでした。画面を確認してください。");
      // 履歴は増やさない: 取り消しの記録を消し、元の記録の取り消し済みを外して、状態を取り消す前に戻す
      tx.set(stateRef(), { ...back, by: me.name, byUid: user.uid });
      tx.delete(uRef);
      tx.update(tRef, { undone: false, undoneBy: "" });
    });
    setMsg("元に戻しました。", "ok", u.target); // 元に戻した記録はまた取り消せる
  } catch (e) { setMsg(errText(e), "err"); }
  finally { busy = false; render(); }
}

// ---------------- my name ----------------
$("myNameSave").onclick = async () => {
  const n = san($("myName").value);
  if (!n || !me || n === me.name) return;
  try { await updateDoc(doc(db, "clubs", clubId, "members", user.uid), { name: n }); setMsg("名前を変えました。", "ok"); }
  catch (e) { setMsg(errText(e), "err"); }
};

// ---------------- admin ----------------
async function loadInvite() {
  try {
    const s = await getDoc(doc(db, "clubs", clubId, "private", "invite"));
    const code = s.exists() ? s.data().code : "";
    const url = new URL(location.href); url.search = "?club=" + encodeURIComponent(clubId) + "&code=" + encodeURIComponent(code);
    $("inviteLink").value = code ? url.toString() : "（招待コードがありません。作り直してください）";
  } catch (e) { $("inviteLink").value = "読み込めませんでした"; }
}
$("inviteCopy").onclick = async () => {
  const v = $("inviteLink").value;
  try { await navigator.clipboard.writeText(v); setMsg("招待リンクをコピーしました。", "ok"); }
  catch { $("inviteLink").select(); setMsg("選択したのでコピーしてください。"); }
};
$("inviteNew").onclick = async () => {
  const ok = await confirmBox("招待コードを作り直しますか？", [["影響", "今の招待リンクでは新しく参加できなくなります。参加済みの部員はそのままです。"]], "作り直す");
  if (!ok) return;
  try { await setDoc(doc(db, "clubs", clubId, "private", "invite"), { code: randomCode(), updatedAt: Date.now() }); await loadInvite(); setMsg("招待コードを作り直しました。", "ok"); }
  catch (e) { setMsg(errText(e), "err"); }
};
// ---------------- delete club（管理者） ----------------
$("delConfirm").oninput = () => { $("delClub").disabled = $("delConfirm").value.trim().toLowerCase() !== clubId; };
$("delClub").onclick = async () => {
  if (!me || me.role !== "admin" || $("delConfirm").value.trim().toLowerCase() !== clubId) return;
  const name = (club && club.name) || clubId;
  const ok = await confirmBox("部活を削除しますか？", [
    ["部活", name + "（" + clubId + "）"],
    ["消えるもの", "部員 " + members.length + "人・履歴・招待コード・鍵の状態"],
    ["注意", "元に戻せません。ほかの部員の画面からも消えます。", "after"],
  ], "削除する");
  if (!ok) return;
  const dm = $("delMsg"); dm.className = "msg"; dm.textContent = "削除中…";
  $("delClub").disabled = true;
  unsubs.forEach(f => f()); unsubs = []; ready = false;
  try {
    const ownerUid = club && club.ownerUid;
    const [logSnap, memSnap] = await Promise.all([getDocs(logCol()), getDocs(collection(db, "clubs", clubId, "members"))]);
    // 作成者と自分の部員データは、部活本体と同じ最後のまとめ書き込みで消す（ルールがそれを条件に許可している）
    const last = [], first = [...logSnap.docs.map(d => d.ref), stateRef(), doc(db, "clubs", clubId, "private", "invite")];
    memSnap.docs.forEach(d => (d.id === user.uid || d.id === ownerUid ? last : first).push(d.ref));
    for (let i = 0; i < first.length; i += 400) {
      const b = writeBatch(db); first.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit();
    }
    const b = writeBatch(db); b.delete(clubRef()); last.forEach(r => b.delete(r)); await b.commit();
    await removeFromMyList(clubId).catch(() => {});
    location.href = "./";
  } catch (e) {
    dm.className = "msg err"; dm.textContent = "削除できませんでした: " + errText(e);
    $("delClub").disabled = false;
    startBoard();
  }
};

$("cfgSave").onclick = async () => {
  const name = san($("cfgName").value, 30), keyNo = san($("cfgKey").value, 10), closeTime = $("cfgClose").value || "20:00";
  if (!name) return;
  try { await updateDoc(clubRef(), { name, keyNo, closeTime }); setMsg("設定を保存しました。", "ok"); }
  catch (e) { setMsg(errText(e), "err"); }
};

function renderMembers() {
  const ul = $("memberList"); if (!ul) return; ul.innerHTML = "";
  $("memberH").textContent = "部員（" + members.length + "人）";
  const isAdmin = me && me.role === "admin";
  members.forEach(m => {
    const li = document.createElement("li");
    const left = document.createElement("span"); left.textContent = m.name;
    if (m.role === "admin") { const r = document.createElement("span"); r.className = "role"; r.textContent = club && m.uid === club.ownerUid ? "作成者" : "管理者"; left.append(r); }
    if (user && m.uid === user.uid) left.append(Object.assign(document.createElement("span"), { className: "me-tag", textContent: "自分" }));
    if (ready && isHolder(m, state)) left.append(Object.assign(document.createElement("span"), { className: "key-tag", textContent: state.key === "holding" ? "鍵を持っている" : "鍵を借りている" }));
    li.append(left);
    if (isAdmin && club && m.uid !== club.ownerUid && m.uid !== user.uid) {
      const ops = document.createElement("span"); ops.className = "ops";
      const toggle = document.createElement("button"); toggle.type = "button";
      toggle.textContent = m.role === "admin" ? "一般部員にする" : "管理者にする";
      toggle.onclick = async () => {
        const ok = await confirmBox("権限を変えますか？", [["部員", m.name], ["変更後", m.role === "admin" ? "一般部員" : "管理者", "after"]], "変える");
        if (!ok) return;
        try { await updateDoc(doc(db, "clubs", clubId, "members", m.uid), { role: m.role === "admin" ? "member" : "admin" }); }
        catch (e) { setMsg(errText(e), "err"); }
      };
      const rm = document.createElement("button"); rm.type = "button"; rm.className = "danger"; rm.textContent = "外す";
      rm.onclick = async () => {
        const ok = await confirmBox("この部員を外しますか？", [["部員", m.name], ["影響", "ボードを見たり記録したりできなくなります。履歴は残ります。"]], "外す");
        if (!ok) return;
        try { await deleteDoc(doc(db, "clubs", clubId, "members", m.uid)); }
        catch (e) { setMsg(errText(e), "err"); }
      };
      ops.append(toggle, rm); li.append(ops);
    }
    ul.append(li);
  });
}
