// 학생 화면: 입장(학번 + 이름 + 비밀번호) → 슬라이드를 따라가며 질문에 답한다.
// 3초마다 서버에서 수업 상태를 받아 온다(교사가 넘긴 쪽, 제출 열림, 공개된 응답).

const app = document.getElementById("app");
const params = new URLSearchParams(location.search);
const POLL_MS = 3000;
// 학생 계정은 웹앱 전체에 하나. 한 번 입장한 기기는 열쇠(token)를 기억해서, 새 수업 코드만 넣으면 바로 들어간다.
const TOKEN_KEY = "cra-token";
const ME_KEY = "cra-me";

let code = "";          // 수업 코드
let token = null;       // 입장 열쇠(이 기기에 저장)
let state = null;       // 서버에서 받은 수업 상태
let viewing = 1;        // 학생이 보고 있는 쪽
let following = true;   // 교사가 띄운 쪽을 따라가는 중인지
let timer = null;
let shell = null;
const cards = new Map(); // 활동 id → 화면 카드
const simFrames = new WeakMap(); // 시뮬레이션 iframe → 활동
const simProgressSent = new Map();

if (!sb) notConfigured(app);
else start();

function start() {
  code = (params.get("c") || localStorage.getItem("cra-last-code") || "").trim();
  // 예전 판은 수업마다 열쇠를 따로 저장했다: 있으면 그대로 옮겨 쓴다
  token = localStorage.getItem(TOKEN_KEY) || (code ? localStorage.getItem("cra-token:" + code.toLowerCase()) : null);
  if (token) localStorage.setItem(TOKEN_KEY, token);
  if (token && code) poll();
  else if (token) showCodeOnly();
  else showEntry();
}

function enterLesson(newCode) {
  code = newCode.trim();
  localStorage.setItem("cra-last-code", code);
  state = null;
  following = true;
  poll();
}

// 이미 입장한 기기: 수업 코드만 넣으면 된다
function showCodeOnly(notice) {
  stopPolling();
  shell = null;
  cards.clear();
  const me = localStorage.getItem(ME_KEY) || "";
  const codeIn = h("input", { type: "text", value: params.get("c") ? "" : code, autocomplete: "off", maxlength: 20, placeholder: "예: K7P2Q", autocapitalize: "characters", required: true });
  const msg = h("p", { class: "msg" }, notice || "");
  app.replaceChildren(h("main", { class: "narrow" },
    h("header", { class: "intro" }, h("p", { class: "eyebrow" }, me ? me + " 학생" : "수업 응답"), h("h1", {}, "수업 코드 입력")),
    h("form", {
      class: "card stack",
      onsubmit(e) {
        e.preventDefault();
        if (!codeIn.value.trim()) return;
        history.replaceState(null, "", "?c=" + encodeURIComponent(codeIn.value.trim()));
        enterLesson(codeIn.value);
      },
    }, h("label", {}, "수업 코드", codeIn), h("button", { class: "primary big", type: "submit" }, "입장하기"), msg),
    h("p", { class: "center" }, h("button", { class: "link", type: "button", onclick() { logout(""); } }, me ? me + " 학생이 아니면: 다른 학생으로 들어가기" : "다른 학생으로 들어가기"))));
  codeIn.focus();
}

// ---------- 입장 ----------
function showEntry(notice) {
  stopPolling();
  shell = null;
  cards.clear();
  const fromLink = !!params.get("c");
  const codeIn = h("input", { type: "text", value: code, autocomplete: "off", maxlength: 20, placeholder: "예: K7P2Q", autocapitalize: "characters", required: true });
  const noIn = h("input", { type: "text", autocomplete: "off", maxlength: 20, inputmode: "numeric", placeholder: "예: 20243030", required: true });
  const nameIn = h("input", { type: "text", autocomplete: "off", maxlength: 20, required: true });
  const pinIn = h("input", { type: "password", inputmode: "numeric", maxlength: 4, autocomplete: "off", required: true });
  const pin2In = h("input", { type: "password", inputmode: "numeric", maxlength: 4, autocomplete: "off" });
  const pin2Row = h("label", { hidden: true }, "비밀번호 한 번 더", pin2In);
  const msg = h("p", { class: "msg" }, notice || "");
  const btn = h("button", { class: "primary big", type: "submit" }, "입장하기");
  let confirming = false;

  // 이름이나 번호를 바꾸면 확인 단계를 처음부터 다시
  [codeIn, noIn, nameIn].forEach((el) => el.addEventListener("input", () => {
    confirming = false;
    pin2Row.hidden = true;
  }));

  const form = h("form", {
    class: "card stack",
    async onsubmit(e) {
      e.preventDefault();
      const pin = pinIn.value.trim();
      if (!/^\d{4}$/.test(pin)) { msg.textContent = "비밀번호는 숫자 4자리로 입력하세요."; return; }
      if (confirming && pin2In.value.trim() !== pin) { msg.textContent = "두 비밀번호가 다릅니다. 다시 입력하세요."; return; }
      btn.disabled = true;
      msg.textContent = "확인 중…";
      const { data, error } = await sb.rpc("student_enter", {
        p_code: codeIn.value, p_class_no: noIn.value, p_name: nameIn.value, p_pin: pin, p_confirm: confirming,
      });
      btn.disabled = false;
      if (error) { msg.textContent = "연결하지 못했습니다. 인터넷을 확인하고 다시 시도하세요. (" + error.message + ")"; return; }
      const err = data.error;
      if (err === "no_lesson") msg.textContent = "수업 코드를 찾지 못했습니다. 선생님께 받은 코드를 확인하세요.";
      else if (err === "bad_name") msg.textContent = "학번과 이름을 확인하세요(각각 20자까지).";
      else if (err === "bad_pin") msg.textContent = "비밀번호는 숫자 4자리로 입력하세요.";
      else if (err === "full") msg.textContent = "이 수업은 인원이 가득 찼습니다. 선생님께 알려 주세요.";
      else if (err === "need_confirm") {
        confirming = true;
        pin2Row.hidden = false;
        pin2In.value = "";
        pin2In.focus();
        msg.textContent = data.reset
          ? "선생님이 비밀번호를 초기화했습니다. 새 비밀번호를 한 번 더 입력하고 입장하세요."
          : "처음 들어왔네요. 지금 입력한 번호가 내 비밀번호가 됩니다. 한 번 더 입력하고 입장하세요.";
      } else if (err === "wrong_pin") msg.textContent = "비밀번호가 틀렸습니다. " + data.left + "번 더 틀리면 10분 동안 잠깁니다.";
      else if (err === "locked") msg.textContent = "비밀번호를 여러 번 틀려 잠겼습니다. " + data.minutes + "분 뒤에 다시 하거나 선생님께 초기화를 부탁하세요.";
      else if (data.token) {
        token = data.token;
        code = data.code;
        localStorage.setItem("cra-last-code", code);
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(ME_KEY, data.class_no + " " + data.name);
        following = true;
        poll();
      } else msg.textContent = "알 수 없는 오류입니다. 다시 시도하세요.";
    },
  },
    fromLink ? null : h("label", {}, "수업 코드", codeIn),
    h("label", {}, "학번", noIn),
    h("label", {}, "이름", nameIn),
    h("label", {}, "비밀번호 (숫자 4자리)", pinIn),
    pin2Row,
    h("div", { class: "tip" },
      h("strong", {}, "처음 들어오나요?"),
      h("p", {}, "처음 입력한 번호가 내 비밀번호가 됩니다. 다른 수업에서도 같은 학번·이름·비밀번호를 씁니다. 휴대폰 비밀번호나 생일은 쓰지 마세요.")),
    btn, msg);

  app.replaceChildren(h("main", { class: "narrow" },
    h("header", { class: "intro" },
      h("p", { class: "eyebrow" }, fromLink ? "수업 코드 " + code : "수업 응답"),
      h("h1", {}, "입장하기")),
    form,
    h("p", { class: "muted small center" }, "비밀번호를 잊었다면 선생님께 말하세요. 초기화해도 쓴 답은 지워지지 않습니다.")));
  (fromLink ? noIn : codeIn).focus();
}

function logout(notice) {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ME_KEY);
  if (code) localStorage.removeItem("cra-token:" + code.toLowerCase());
  token = null;
  state = null;
  showEntry(notice);
}

// ---------- 서버에서 상태 받기 ----------
function stopPolling() {
  clearTimeout(timer);
  timer = null;
}

async function poll() {
  clearTimeout(timer);
  const { data, error } = await sb.rpc("student_state", { p_token: token, p_code: code });
  if (!token) return;
  if (!error && data.error === "no_lesson") return showCodeOnly("수업 코드를 찾지 못했습니다. 선생님께 받은 코드를 확인하세요.");
  if (!error && data.error === "full") return showCodeOnly("이 수업은 인원이 가득 찼습니다. 선생님께 알려 주세요.");
  if (error) {
    if (shell) shell.conn.hidden = false;
    else showEntry("연결하지 못했습니다. 인터넷을 확인하고 다시 입장하세요.");
  } else if (data.error === "logged_out") {
    return logout("다시 입장해 주세요. 선생님이 비밀번호를 초기화했거나 학생 정보가 지워졌습니다.");
  } else {
    apply(data);
  }
  timer = setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && token && shell) poll(); });

function apply(data) {
  const before = state;
  state = data;
  if (!shell) buildShell();
  shell.conn.hidden = true;
  const teacherPage = clampPage(data.lesson.page);
  if (!before || following) viewing = teacherPage;
  if (viewing > teacherPage) viewing = teacherPage;   // 교사가 앞쪽으로 되돌아간 경우
  following = viewing === teacherPage;
  render(!before || before.lesson.page !== data.lesson.page);
}

function clampPage(n) {
  const max = Math.max(state.lesson.slide_count, 1);
  return Math.min(Math.max(n || 1, 1), max);
}

// ---------- 화면 ----------
function buildShell() {
  const img = h("img", { class: "slide", alt: "", title: "누르면 크게 보기", onclick: zoom });
  const prev = h("button", { class: "ghost", type: "button", onclick() { go(viewing - 1); } }, "◀ 이전");
  const next = h("button", { class: "ghost", type: "button", onclick() { go(viewing + 1); } }, "다음 ▶");
  const where = h("span", { class: "where" });
  const back = h("button", { class: "primary", type: "button", onclick() { go(state.lesson.page); } }, "선생님과 같은 쪽으로");
  const closed = h("p", { class: "banner" }, "지금은 제출이 닫혀 있습니다. 쓴 내용은 이 기기에 남아 있으니, 선생님이 열면 저장하세요.");
  const conn = h("p", { class: "banner bad", hidden: true }, "연결이 끊겼습니다. 다시 연결하는 중…");
  const title = h("strong", {});
  const who = h("span", {});
  const simStage = h("div", { class: "sim-stage", hidden: true });
  const slideBox = h("div", { class: "slide-box" }, img, simStage,
    h("nav", { class: "pager" }, prev, where, next, back, h("span", { class: "spacer" }),
      h("button", { class: "ghost", type: "button", onclick: zoom }, "크게 보기")),
    h("p", { class: "muted small" }, "다음 쪽은 선생님이 넘기면 자동으로 열립니다."));
  const list = h("div", { class: "stack" });
  app.replaceChildren(
    h("header", { class: "top" }, h("div", { class: "top-title" }, title, who),
      h("div", { class: "row" },
        h("button", { class: "link", type: "button", onclick() { history.replaceState(null, "", location.pathname); showCodeOnly(); } }, "다른 수업"),
        h("button", { class: "link", type: "button", onclick() { logout("나갔습니다. 다시 들어오려면 입장하세요."); } }, "나가기"))),
    h("main", { class: "lesson" }, conn, closed, slideBox, list));
  const anytimeHead = h("h2", { class: "section-head" }, "언제든 할 수 있는 활동");
  const empty = h("p", { class: "muted center" });
  shell = { img, simStage, prev, next, where, back, closed, conn, title, who, slideBox, list, anytimeHead, empty, stageSim: null, stageKey: "" };
}

// 슬라이드를 화면 가득 띄운다. 누르거나 Esc로 닫는다. 선생님이 쪽을 넘기면 띄운 그림도 바뀐다.
function zoom() {
  if (shell.stageSim) {
    const a = shell.stageSim;
    return loadSim(a).then((html) => openSimFull(a.title, html));
  }
  if (shell.zoom) return;
  const big = h("img", { src: shell.img.src, alt: shell.img.alt });
  const box = h("div", { class: "slide-zoom", onclick: close }, big, h("p", {}, "눌러서 닫기 · 휴대폰은 가로로 돌리면 더 크게 보입니다"));
  function close() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    box.remove();
    document.removeEventListener("keydown", esc);
    document.removeEventListener("fullscreenchange", left);
    shell.zoom = null;
  }
  const esc = (e) => { if (e.key === "Escape") close(); };
  const left = () => { if (!document.fullscreenElement) close(); };
  document.addEventListener("keydown", esc);
  document.body.append(box);
  shell.zoom = big;
  if (box.requestFullscreen) box.requestFullscreen().then(() => document.addEventListener("fullscreenchange", left)).catch(() => {});
}

function go(n) {
  viewing = clampPage(Math.min(n, state.lesson.page));
  following = viewing === clampPage(state.lesson.page);
  render(true);
  scrollTo(0, 0);
}

function render(pageChanged) {
  const L = state.lesson;
  const hasSlides = L.slide_count > 0;
  shell.title.textContent = L.title;
  shell.who.textContent = state.me.class_no + " " + state.me.name;
  shell.closed.hidden = L.open;
  shell.slideBox.hidden = !hasSlides;
  if (hasSlides) {
    const src = slideSrc(L, viewing);
    if (shell.img.getAttribute("src") !== src) shell.img.src = src;
    if (shell.zoom && shell.zoom.getAttribute("src") !== src) shell.zoom.src = src;
    shell.img.alt = "슬라이드 " + viewing;
    shell.where.textContent = viewing + " / " + L.slide_count;
    shell.prev.disabled = viewing <= 1;
    shell.next.disabled = viewing >= clampPage(L.page);
    shell.back.hidden = following;
  }

  // 슬라이드가 없는 수업은 활동을 모두 보여 준다
  const acts = state.activities;
  // 큰 화면에서는 슬라이드와 질문을 나란히(split), 슬라이드가 없으면 가운데 한 줄(single)
  shell.slideBox.parentNode.className = "lesson " + (hasSlides ? "split" : "single");
  let here = hasSlides ? acts.filter((a) => onPage(a, viewing)) : acts;
  const anytime = hasSlides ? acts.filter((a) => a.page == null) : [];
  // 「슬라이드 자리에 띄우기」 시뮬레이션은 슬라이드 그림 대신 위쪽에 크게 보인다
  const stageSim = hasSlides ? here.find((a) => a.kind === "sim" && a.sim_full) : null;
  showStageSim(stageSim);
  if (stageSim) here = here.filter((a) => a !== stageSim);
  const els = here.map(cardFor);
  if (anytime.length) els.push(shell.anytimeHead, anytime.map(cardFor));
  if (!here.length && !anytime.length) {
    shell.empty.textContent = hasSlides ? "이 쪽에는 질문이 없습니다." : "아직 활동이 없습니다.";
    els.push(shell.empty);
  }
  // 같은 카드들이면 그대로 둔다(다시 끼우면 쓰고 있던 칸의 커서가 빠진다)
  if (pageChanged || shell.list.childElementCount !== els.flat().length || els.flat().some((el, i) => shell.list.children[i] !== el)) {
    shell.list.replaceChildren(...els.flat());
  }
}

// ---------- 시뮬레이션 ----------
const simCache = new Map();   // 활동 id → { ver, html }
const SIM_HEARTBEAT_MS = 15000;

function monitoredSimHtml(html) {
  const script = `<script>(function(){
    const send = () => {
      const fields = [];
      const controls = Array.from(document.querySelectorAll('input,select,textarea'));
      controls.forEach((el, index) => {
        const type = el.tagName === 'SELECT' ? 'select' : (el.type || el.tagName).toLowerCase();
        if (['hidden','password','file','button','submit','reset'].includes(type)) return;
        if (!['range','number','select','checkbox','radio'].includes(type) && !el.hasAttribute('data-cra-condition')) return;
        const label = (el.getAttribute('aria-label') || (el.labels && Array.from(el.labels).map(x => x.innerText).join(' ').trim()) || el.closest('label')?.innerText || el.name || el.id || ('조건 ' + (index + 1))).trim().slice(0, 80);
        let value;
        if (type === 'checkbox' || type === 'radio') value = el.checked ? (el.value || true) : null;
        else if (el.tagName === 'SELECT' && el.multiple) value = Array.from(el.selectedOptions, o => o.textContent.trim()).slice(0, 10);
        else if (el.tagName === 'SELECT') value = el.selectedOptions[0]?.textContent.trim() || el.value;
        else value = el.value;
        if (value !== null) fields.push({label, value: String(Array.isArray(value) ? value.join(', ') : value).slice(0, 120)});
      });
      parent.postMessage({type:'cra-sim-progress', state:{fields:fields.slice(0,30)}}, '*');
    };
    let changed = false;
    const changedSoon = () => { changed = true; clearTimeout(window.__craSimDebounce); window.__craSimDebounce = setTimeout(send, 500); };
    document.addEventListener('input', changedSoon, true);
    document.addEventListener('change', changedSoon, true);
    window.reportSimulationState = state => parent.postMessage({type:'cra-sim-progress', state}, '*');
    send();
    setInterval(() => { if (!changed) send(); changed = false; }, ${SIM_HEARTBEAT_MS});
  })();<\/script>`;
  const source = typeof html === "string" ? html : "";
  return /<\/body\s*>/i.test(source) ? source.replace(/<\/body\s*>/i, script + "</body>") : source + script;
}

function trackSimFrame(frame, activity, html) {
  simFrames.set(frame.contentWindow, activity);
  frame.srcdoc = monitoredSimHtml(html);
}

window.addEventListener("message", (event) => {
  const activity = simFrames.get(event.source);
  if (!activity || !event.data || event.data.type !== "cra-sim-progress" || !frameIsActive(event.source)) return;
  const state = normalizeSimState(event.data.state);
  if (!state) return;
  const key = activity.id;
  const serialized = JSON.stringify(state);
  if (simProgressSent.get(key) === serialized && Date.now() - (simProgressSent.get(key + ":at") || 0) < SIM_HEARTBEAT_MS - 1000) return;
  simProgressSent.set(key, serialized);
  simProgressSent.set(key + ":at", Date.now());
  sb.rpc("student_simulation_progress", { p_token: token, p_activity: activity.id, p_state: state })
    .then(({ error }) => { if (error) console.warn("시뮬레이션 진행 상황을 저장하지 못했습니다.", error.message); });
});

function frameIsActive(source) {
  for (const frame of document.querySelectorAll("iframe.sim-frame")) if (frame.contentWindow === source) return frame.isConnected && !document.hidden;
  return false;
}

function normalizeSimState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = Array.isArray(value.fields) ? value.fields.slice(0, 30).map((field) => ({
    label: String(field && field.label || "조건").slice(0, 80),
    value: String(field && field.value != null ? field.value : "").slice(0, 120),
  })) : Object.entries(value).slice(0, 30).map(([label, field]) => ({ label: label.slice(0, 80), value: String(field).slice(0, 120) }));
  const state = { fields };
  while (fields.length && new TextEncoder().encode(JSON.stringify(state)).length > 3500) fields.pop();
  return state;
}

async function loadSim(a) {
  const hit = simCache.get(a.id);
  if (hit && hit.ver === a.html_ver) return hit.html;
  const { data, error } = await sb.rpc("student_sim", { p_token: token, p_activity: a.id });
  if (error) throw error;
  const html = typeof data === "string" ? data : "";
  simCache.set(a.id, { ver: a.html_ver, html });
  return html;
}

function showStageSim(a) {
  shell.stageSim = a || null;
  shell.img.hidden = !!a;
  shell.simStage.hidden = !a;
  const key = a ? a.id + ":" + a.html_ver : "";
  if (key === shell.stageKey) return;
  shell.stageKey = key;
  shell.simStage.replaceChildren();
  if (!a) return;
  const f = simFrame(null, a.title);
  shell.simStage.append(f);
  loadSim(a).then((html) => { if (shell.stageKey === key) trackSimFrame(f, a, html); })
    .catch(() => shell.simStage.replaceChildren(h("p", { class: "error" }, "시뮬레이션을 불러오지 못했습니다. 새로고침해 보세요.")));
}

// 슬라이드 아래에 붙는 시뮬레이션 카드
function simCard(a) {
  let c = cards.get(a.id);
  if (!c) {
    c = { el: h("section", { class: "card activity" }), key: "" };
    cards.set(a.id, c);
  }
  const key = a.title + ":" + a.html_ver;
  if (c.key !== key) {
    c.key = key;
    const f = simFrame(null, a.title);
    c.el.replaceChildren(
      h("div", { class: "card-head" }, h("h2", {}, a.title), h("span", { class: "badge" }, "시뮬레이션")),
      h("p", { class: "muted small" }, "직접 조작해 보세요. 화면이 작으면 「화면 가득 보기」를 누르세요."),
      h("button", { class: "primary", type: "button", onclick() { loadSim(a).then((html) => openSimFull(a.title, html, (frame) => trackSimFrame(frame, a, html))); } }, "화면 가득 보기"),
      f);
    loadSim(a).then((html) => { if (c.key === key) trackSimFrame(f, a, html); })
      .catch(() => f.replaceWith(h("p", { class: "error" }, "시뮬레이션을 불러오지 못했습니다. 새로고침해 보세요.")));
  }
  return c.el;
}

// ---------- 활동 카드 ----------
function draftKey(a) { return "cra-draft:" + token + ":" + a.id; }

function cardFor(a) {
  if (a.kind === "sim") return simCard(a);
  let c = cards.get(a.id);
  if (!c) {
    c = { el: h("section", { class: "card activity" }), form: h("div", { class: "stack" }), others: h("div", {}) };
    c.el.append(c.form, c.others);
    cards.set(a.id, c);
  }
  c.a = a;
  const formSig = JSON.stringify([a.title, a.kind, a.questions, a.saved_at, a.score]);
  if (formSig !== c.formSig) {
    c.formSig = formSig;
    buildForm(c);
  }
  c.refresh();
  const othersSig = JSON.stringify(a.shared ? [a.others, a.questions] : null);
  if (othersSig !== c.othersSig) {
    c.othersSig = othersSig;
    c.others.replaceChildren(...(a.shared ? [
      h("div", { class: "others" },
        h("h3", {}, "친구들의 응답"),
        h("p", { class: "muted small" }, "선생님이 공개했습니다 · " + (a.named ? "이름과 함께" : "이름 없이") + " · " + a.others.length + "명"),
        summaryView(a.questions, a.others)),
    ] : []));
  }
  return c.el;
}

function buildForm(c) {
  const a = c.a;
  if (isInfoActivity(a)) {
    c.refresh = () => {};
    c.form.replaceChildren(
      h("div", { class: "card-head" }, h("h2", {}, a.title), h("span", { class: "badge" }, "설명 카드")),
      linkedDescription(a.questions[0].text));
    return;
  }
  const quizDone = a.kind === "quiz" && !!a.mine;
  // 고치는 중인 내용(이 기기에 저장). 서버에 더 나중에 저장된 것이 있으면 그것을 쓴다.
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(draftKey(a)) || "null"); } catch (e) { draft = null; }
  if (draft && a.saved_at && draft.at < Date.parse(a.saved_at)) draft = null;
  const values = Object.assign({}, a.mine || {}, draft ? draft.values : {});
  const err = h("p", { class: "error" });
  const status = h("p", { class: "status" });
  const btn = h("button", { class: "primary big", type: "button" });
  let sending = false;

  const saveDraft = () => {
    localStorage.setItem(draftKey(a), JSON.stringify({ at: Date.now(), values }));
    err.textContent = "";
    c.refresh();
  };
  const dirty = () => a.questions.some((q) => JSON.stringify(values[q.id] ?? "") !== JSON.stringify((a.mine || {})[q.id] ?? ""));

  const rows = a.questions.map((q, i) => {
    const label = (i + 1) + ". " + q.text;
    let control;
    if (q.type === "choice" || q.type === "multi") {
      const picked = () => [].concat(values[q.id] ?? []);
      control = h("fieldset", { class: "options" }, h("legend", {}, label), q.options.map((o) => {
        const right = quizDone && q.answer != null && [].concat(q.answer).includes(o);
        return h("label", { class: "option" + (right ? " right" : "") },
          h("input", {
            type: q.type === "choice" ? "radio" : "checkbox", name: a.id + "-" + q.id, checked: picked().includes(o), disabled: quizDone,
            onchange(e) {
              if (q.type === "choice") values[q.id] = o;
              else values[q.id] = q.options.filter((x) => (x === o ? e.target.checked : picked().includes(x)));
              saveDraft();
            },
          }),
          h("span", {}, o), right ? h("strong", { class: "right-mark" }, "정답") : null);
      }));
    } else {
      const input = q.type === "short"
        ? h("input", { type: "text", maxlength: 200, value: values[q.id] || "", disabled: quizDone })
        : h("textarea", { rows: 4, maxlength: 2000, disabled: quizDone }, values[q.id] || "");
      input.addEventListener("input", () => { values[q.id] = input.value; saveDraft(); });
      control = h("label", {}, label, input);
    }
    const result = quizDone && q.answer != null
      ? h("p", { class: JSON.stringify(values[q.id]) === JSON.stringify(q.answer) ? "ok small" : "error small" },
        JSON.stringify(values[q.id]) === JSON.stringify(q.answer) ? "맞았습니다." : "정답: " + answerText(q.answer))
      : null;
    const explain = quizDone && q.explain ? h("p", { class: "tip small" }, "해설: " + q.explain) : null;
    return h("div", { class: "question" }, control, result, explain);
  });

  async function save() {
    const missing = a.questions.findIndex((q) => isEmptyAnswer(values[q.id]));
    if (missing >= 0) { err.textContent = (missing + 1) + "번 질문에 답해 주세요."; return; }
    if (a.kind === "quiz" && !confirm("퀴즈는 한 번만 제출할 수 있습니다. 제출할까요?")) return;
    const answers = {};
    a.questions.forEach((q) => { answers[q.id] = typeof values[q.id] === "string" ? values[q.id].trim() : values[q.id]; });
    sending = true;
    c.refresh();
    const { data, error } = await sb.rpc("student_save", { p_token: token, p_activity: a.id, p_answers: answers });
    sending = false;
    if (error) err.textContent = "저장하지 못했습니다. 다시 시도하세요. (" + error.message + ")";
    else if (data.error === "closed") err.textContent = "지금은 제출이 닫혀 있습니다. 선생님이 열면 다시 저장하세요.";
    else if (data.error === "already") err.textContent = "이미 제출한 퀴즈입니다.";
    else if (data.error === "logged_out") return logout("다시 입장해 주세요.");
    else if (data.error) err.textContent = "저장하지 못했습니다. (" + data.error + ")";
    else {
      localStorage.removeItem(draftKey(a));
      c.formSig = null;   // 저장한 내용으로 다시 그린다
      return poll();
    }
    c.refresh();
  }
  btn.addEventListener("click", save);

  c.refresh = () => {
    const open = state.lesson.open;
    const d = dirty();
    if (quizDone) {
      btn.hidden = true;
      status.textContent = "제출했습니다 (" + fmtTime(a.saved_at) + ")";
      status.className = "status ok";
      return;
    }
    btn.disabled = sending || !open || (a.mine && !d);
    btn.textContent = sending ? "저장 중…" : a.kind === "quiz" ? "제출하기" : !a.mine ? "저장하기" : d ? "고친 내용 저장" : "저장됨";
    status.textContent = !open ? "지금은 저장할 수 없습니다." : a.mine && !d ? "✓ 저장 완료 (" + fmtTime(a.saved_at) + ")" : a.mine ? "저장하지 않은 수정 내용이 있습니다." : "";
    status.className = a.mine && !d && open ? "status ok" : "status";
  };

  c.form.replaceChildren(...[
    h("div", { class: "card-head" }, h("h2", {}, a.title), h("span", { class: "badge" }, KIND_NAME[a.kind])),
    activityDescription(a) ? linkedDescription(activityDescription(a)) : null,
    quizDone && a.total ? h("p", { class: "score" }, "점수 " + a.score + " / " + a.total) : null,
    rows, err, btn, status].flat().filter(Boolean));
}
