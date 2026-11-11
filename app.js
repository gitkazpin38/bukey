// 部室の鍵ボード — GitHub Pages + Firebase 版
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
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

const DEFAULT_STATE = { key: "guard", holder: "", room: "closed", since: 0, returnBy: "", note: "" };
const ACT_LABEL = { borrow: "借りた", open: "開けた", lock: "閉めた", hold: "持っている", return: "返した", hand: "渡した", fix: "訂正", undo: "取消" };
const ACT_CLASS = { borrow: "a-borrow", open: "a-open", lock: "a-lock", hold: "a-hold", return: "a-return", hand: "a-hand", fix: "a-fix", undo: "a-fix" };

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
const stateLabel = s => {
  const h = s.holder ? s.holder + "さん" : "（不明）";
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
function setMsg(t, kind, undoId) {
  const m = $("msg"); m.textContent = t || ""; m.className = "msg" + (kind ? " " + kind : "");
  if (undoId) {
    const b = document.createElement("button"); b.type = "button"; b.className = "undo-btn"; b.textContent = "取り消す";
    b.onclick = () => undo(undoId); m.append(" ", b);
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
$("signInBtn").onclick = async () => {
  const provider = new GoogleAuthProvider();
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
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
  if (!cs.exists()) { setConn(""); show("missing"); return; }
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
}

// ---------------- board ----------------
function startBoard() {
  show("board");
  setConn("接続中…");
  const timer = setTimeout(() => setConn("データにつながりません。表示が古い可能性があります。"), 10000);

  unsubs.push(onSnapshot(clubRef(), s => { if (s.exists()) { club = s.data(); applyClubHeader(); render(); } }));
  unsubs.push(onSnapshot(doc(db, "clubs", clubId, "members", user.uid), s => {
    if (!s.exists()) { setConn("この部活から外されました。"); unsubs.forEach(f => f()); unsubs = []; show("missing"); return; }
    me = s.data();
    if (document.activeElement !== $("myName")) $("myName").value = me.name || "";
    $("adminCard").hidden = me.role !== "admin";
    if (me.role === "admin") loadInvite();
    render();
  }));
  unsubs.push(onSnapshot(collection(db, "clubs", clubId, "members"), qs => {
    members = qs.docs.map(d => d.data()).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    const dl = $("memberNames"); dl.innerHTML = "";
    members.forEach(m => { const o = document.createElement("option"); o.value = m.name; dl.append(o); });
    renderMembers();
  }, () => {}));
  unsubs.push(onSnapshot(stateRef(), s => {
    state = s.exists() ? { ...DEFAULT_STATE, ...s.data() } : { ...DEFAULT_STATE };
    if (!s.metadata.fromCache) { clearTimeout(timer); setConn("みんなの画面とリアルタイムで同期中"); }
    ready = true; render();
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
  const who = Object.assign(document.createElement("b"), { textContent: s.holder ? s.holder + "さん" : "誰か" });
  if (s.key === "guard") sum.textContent = "部室は閉まっています。鍵は守衛室にあります。";
  else if (s.room === "open") sum.append("部室は開いています。鍵は ", who, " が借りています。");
  else if (s.key === "holding") sum.append("部室は閉まっています。鍵は ", who, " が持っています。");
  else sum.append("部室は閉まっています。鍵は ", who, " が借りています。");

  const sl = $("subline"); sl.innerHTML = "";
  if (s.since) {
    const t = document.createElement("span"); t.className = "t"; t.textContent = fmtWhen(s.since);
    sl.append("最終更新 ", t, "（" + ago(s.since) + (s.by ? "・" + s.by + "さん" : "") + "）");
    if (s.key === "holding" && s.returnBy) {
      const r = document.createElement("span"); r.className = "t"; r.textContent = s.returnBy;
      sl.append(" ・ 返却予定 ", r);
    }
    if (s.note) sl.append(" ・ " + s.note);
  } else sl.textContent = "まだ記録がありません。鍵は守衛室にある前提で始めます。";

  renderAlerts(); renderButtons(); renderLog();
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
  const who = s.holder ? s.holder + "さん" : "鍵を持っている人";
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
    if (s.key === "borrowed") box.append(btn("自分で持っている", "返却時刻を決めて記録", "", () => showPanel("hold")));
    box.append(btn("鍵を別の人に渡した", "鍵の持ち主を変える", "", () => showPanel("hand")));
  } else {
    box.append(btn("部室を閉めた", "施錠したら押す。返却・保持はこのあと記録", "primary", () => act("lock")));
    box.append(btn("鍵を別の人に渡した", "部室は開けたまま、鍵の持ち主だけ変える", "", () => showPanel("hand")));
  }
}

function renderLog() {
  const ul = $("log"); ul.innerHTML = "";
  const latest = logs.find(l => l.prev && !l.undone && l.action !== "undo");
  const undoableId = (latest && logs[0] === latest && sameState(state, latest.next)) ? latest.id : null;
  if (!logs.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "まだ記録がありません。"; ul.append(li); return; }
  logs.forEach(d => {
    const li = document.createElement("li");
    const w = document.createElement("span"); w.className = "when"; w.textContent = fmtWhen(d.ms || 0);
    const body = document.createElement("span");
    const a = document.createElement("span"); a.className = "act " + (ACT_CLASS[d.action] || ""); a.textContent = ACT_LABEL[d.action] || d.action;
    const tx = document.createElement("span"); tx.textContent = String(d.text || ""); if (d.undone) tx.className = "undone";
    body.append(a, tx);
    if (d.undone) { const u = document.createElement("span"); u.className = "undone-note"; u.textContent = " 取り消し済み"; body.append(u); }
    if (d.id === undoableId) {
      const b = document.createElement("button"); b.type = "button"; b.className = "undo-btn"; b.textContent = "取り消す";
      b.disabled = busy; b.onclick = () => undo(d.id); body.append(" ", b);
    }
    li.append(w, body); ul.append(li);
  });
}

function showPanel(which) {
  $("holdPanel").hidden = which !== "hold";
  $("handPanel").hidden = which !== "hand";
  if (which === "hold") {
    if (!$("holdUntil").value) $("holdUntil").value = (club && club.closeTime) || "20:00";
    $("holdPledge").checked = false; $("holdUntil").focus();
  }
  if (which === "hand") { $("handTo").value = ""; $("handTo").focus(); }
}
$("holdCancel").onclick = () => showPanel(null);
$("handCancel").onclick = () => showPanel(null);
$("holdGo").onclick = () => act("hold");
$("handGo").onclick = () => act("hand");
$("fixGo").onclick = () => act("fix");

// ---------------- state transitions ----------------
function plan(kind, cur, myName) {
  let next = { ...cur }, text = "";
  const holderName = cur.holder || "（不明）";
  const closeTime = (club && club.closeTime) || "20:00";
  switch (kind) {
    case "borrow":
      if (cur.key !== "guard") throw new Error("鍵はすでに" + holderName + "さんが持っています。画面を確認してください。");
      next = { key: "borrowed", holder: myName, room: "closed", returnBy: "", note: "" };
      text = myName + "さんが守衛さんから鍵を借りた"; break;
    case "open":
      if (cur.key === "guard") throw new Error("鍵は守衛室にあります。先に「鍵を借りた」を記録してください。");
      if (cur.room === "open") throw new Error("部室はすでに開いています。");
      next = { ...cur, key: "borrowed", room: "open", returnBy: "", note: "" };
      text = myName + "さんが部室を開けた（鍵: " + holderName + "さん）"; break;
    case "lock":
      if (cur.room !== "open") throw new Error("部室はすでに閉まっています。");
      next = { ...cur, room: "closed" };
      text = myName + "さんが部室を閉めた（鍵: " + holderName + "さん）"; break;
    case "return":
      if (cur.key === "guard") throw new Error("鍵はすでに守衛室にあります。");
      if (cur.room === "open") throw new Error("部室が開いたままです。先に施錠してください。");
      next = { ...DEFAULT_STATE };
      text = myName + "さんが守衛さんに鍵を返した"; break;
    case "hold": {
      if (cur.key === "guard") throw new Error("鍵は守衛室にあります。");
      if (cur.room === "open") throw new Error("部室が開いたままです。先に施錠してください。");
      const until = $("holdUntil").value;
      if (!until) throw new Error("返却する時刻を入れてください。");
      const close = minutesOf(closeTime);
      if (close !== null && minutesOf(until) > close) throw new Error("最終返却時刻（" + closeTime + "）より後にはできません。");
      if (!$("holdPledge").checked) throw new Error("確認のチェックを入れてください。");
      const note = san($("holdNote").value, 60);
      next = { ...cur, key: "holding", holder: myName, room: "closed", returnBy: until, note };
      text = myName + "さんが鍵を持っている（" + until + "までに返却予定）" + (note ? "：「" + note + "」" : ""); break;
    }
    case "hand": {
      if (cur.key === "guard") throw new Error("鍵は守衛室にあります。");
      const to = san($("handTo").value);
      if (!to) throw new Error("受け取る人の名前を入れてください。");
      if (to === cur.holder) throw new Error("鍵はすでに" + to + "さんが持っています。");
      next = { ...cur, holder: to };
      text = holderName + "さん → " + to + "さんに鍵を渡した" + (cur.room === "open" ? "（部室は開いたまま）" : "") + "（記録: " + myName + "さん）"; break;
    }
    case "fix": {
      const k = $("fixKey").value, r = $("fixRoom").value, h = san($("fixHolder").value);
      if (k === "guard" && r === "open") throw new Error("鍵が守衛室にあるのに部室が開いている状態は記録できません。");
      if (k !== "guard" && !h) throw new Error("鍵を持っている人の名前を入れてください。");
      next = { key: k, holder: k === "guard" ? "" : h, room: r, returnBy: "", note: "" };
      const kl = { guard: "守衛室", borrowed: h + "さんが借用", holding: h + "さんが保持" }[k];
      text = myName + "さんが状態を訂正：鍵=" + kl + "、部室=" + (r === "open" ? "開" : "閉"); break;
    }
  }
  return { next, text };
}

async function act(kind) {
  if (busy || !me) return;
  const myName = me.name;
  let preview;
  try { preview = plan(kind, { ...state }, myName); } catch (e) { setMsg(e.message, "err"); return; }
  const ok = await confirmBox("この内容で記録しますか？", [
    ["操作", preview.text], ["いま", stateLabel(state)], ["記録後", stateLabel(preview.next), "after"],
  ], ACT_LABEL[kind] + " を記録");
  if (!ok) { setMsg("取りやめました。"); return; }
  busy = true; render(); setMsg("記録中…");
  try {
    const logRef = doc(logCol());
    const text = await runTransaction(db, async tx => {
      const s = await tx.get(stateRef());
      const cur = s.exists() ? { ...DEFAULT_STATE, ...s.data() } : { ...DEFAULT_STATE };
      const { next, text } = plan(kind, cur, myName);
      const now = Date.now();
      Object.assign(next, { since: now, by: myName, byUid: user.uid });
      tx.set(stateRef(), next);
      tx.set(logRef, { ms: now, action: kind, text, prev: cur, next, undone: false, by: myName, byUid: user.uid });
      return text;
    });
    showPanel(null);
    setMsg("記録しました：「" + text + "」", "ok", logRef.id);
  } catch (e) { setMsg(errText(e), "err"); }
  finally { busy = false; render(); }
}

async function undo(logId) {
  if (busy || !me) return;
  const entry = logs.find(l => l.id === logId);
  if (!entry || !entry.prev || entry.undone) { setMsg("この記録は取り消せません。", "err"); return; }
  if (!sameState(state, entry.next)) { setMsg("このあとに別の操作が記録されているため取り消せません。必要なら「記録の訂正」を使ってください。", "err"); return; }
  const prev = { ...DEFAULT_STATE, ...entry.prev };
  const ok = await confirmBox("この記録を取り消しますか？", [
    ["取り消す操作", entry.text], ["いま", stateLabel(state)], ["取り消し後", stateLabel(prev), "after"],
  ], "取り消す");
  if (!ok) { setMsg("取りやめました。"); return; }
  busy = true; render(); setMsg("取り消し中…");
  try {
    await runTransaction(db, async tx => {
      const entryRef = doc(db, "clubs", clubId, "log", logId);
      const [s, l] = [await tx.get(stateRef()), await tx.get(entryRef)];
      const cur = s.exists() ? { ...DEFAULT_STATE, ...s.data() } : { ...DEFAULT_STATE };
      if (!l.exists() || l.data().undone || !sameState(cur, l.data().next))
        throw new Error("直前に別の人が操作したため取り消せませんでした。画面を確認してください。");
      tx.set(stateRef(), { ...prev, by: me.name, byUid: user.uid });
      tx.update(entryRef, { undone: true, undoneBy: me.name });
      tx.set(doc(logCol()), { ms: Date.now(), action: "undo", text: me.name + "さんが「" + entry.text + "」を取り消した", by: me.name, byUid: user.uid });
    });
    setMsg("取り消しました。", "ok");
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
$("cfgSave").onclick = async () => {
  const name = san($("cfgName").value, 30), keyNo = san($("cfgKey").value, 10), closeTime = $("cfgClose").value || "20:00";
  if (!name) return;
  try { await updateDoc(clubRef(), { name, keyNo, closeTime }); setMsg("設定を保存しました。", "ok"); }
  catch (e) { setMsg(errText(e), "err"); }
};

function renderMembers() {
  const ul = $("memberList"); if (!ul) return; ul.innerHTML = "";
  const isAdmin = me && me.role === "admin";
  members.forEach(m => {
    const li = document.createElement("li");
    const left = document.createElement("span"); left.textContent = m.name;
    if (m.role === "admin") { const r = document.createElement("span"); r.className = "role"; r.textContent = club && m.uid === club.ownerUid ? "作成者" : "管理者"; left.append(r); }
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
