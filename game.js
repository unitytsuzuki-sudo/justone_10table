// ============================================================
// JUST ONE × BBQ
// GitHub Gist 同期版（テーブル制・自動プレイヤー名・立候補方式）
// ============================================================

// ---------- 状態管理 ----------
const STORAGE_KEYS = {
  token: 'jone_gh_token',
  gistId: 'jone_gist_id',
  playerId: 'jone_player_id'
};

let state = {
  token: null,
  gistId: null,
  tableNum: null,
  playerId: null,
  playerName: null,
  currentControlledId: null,  // 切替中のゴーストID（nullなら自分）
  pollTimer: null,
  lastPhase: null,
  isWriting: false
};

function ensurePlayerId() {
  let pid = localStorage.getItem(STORAGE_KEYS.playerId);
  if (!pid) {
    pid = 'p_' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem(STORAGE_KEYS.playerId, pid);
  }
  state.playerId = pid;
}

// ---------- Gist API ----------
async function gistRead() {
  if (!state.token || !state.gistId) throw new Error('No token/gist');
  // キャッシュ回避のためタイムスタンプ付与（URLパラメータのみ）
  const cacheBuster = `?_=${Date.now()}`;
  const res = await fetch(`https://api.github.com/gists/${state.gistId}${cacheBuster}`, {
    headers: {
      'Authorization': `Bearer ${state.token}`,
      'Accept': 'application/vnd.github+json'
    }
  });
  if (!res.ok) throw new Error('Gist read failed: ' + res.status);
  const data = await res.json();
  const file = data.files['data.json'] || data.files[Object.keys(data.files)[0]];
  try {
    return JSON.parse(file.content);
  } catch (e) {
    return {};
  }
}

async function gistWrite(data) {
  if (!state.token || !state.gistId) throw new Error('No token/gist');
  const res = await fetch(`https://api.github.com/gists/${state.gistId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${state.token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      files: { 'data.json': { content: JSON.stringify(data, null, 2) } }
    })
  });
  if (!res.ok) throw new Error('Gist write failed: ' + res.status);
  return await res.json();
}

async function readTable() {
  const all = await gistRead();
  const key = `table_${state.tableNum}`;
  return all[key] || createEmptyTable();
}

async function writeTable(tableData) {
  const all = await gistRead();
  tableData.updatedAt = Date.now();
  all[`table_${state.tableNum}`] = tableData;
  await gistWrite(all);
}

async function updateTable(updater) {
  if (state.isWriting) {
    await new Promise(r => setTimeout(r, 200));
  }
  state.isWriting = true;
  try {
    const tableData = await readTable();
    const updated = updater(tableData) || tableData;
    if (updated !== null) {
      await writeTable(updated);
    }
    return updated;
  } finally {
    state.isWriting = false;
  }
}

function createEmptyTable() {
  return {
    phase: 'lobby',
    players: [],
    nextPlayerNum: 1,
    answererId: null,
    candidates: [],
    cardId: null,
    item: null,
    topic: null,
    theme: null,
    hints: {},
    revealed: false,
    attempts: [],
    result: null,
    updatedAt: Date.now()
  };
}

// ---------- 画面遷移 ----------
const SCREENS = ['setup', 'table', 'lobby', 'volunteer', 'pick', 'hint', 'answerer-wait', 'review', 'answer', 'watch', 'result'];

function showScreen(name) {
  SCREENS.forEach(s => {
    const el = document.getElementById('screen-' + s);
    if (el) el.classList.add('hidden');
  });
  const target = document.getElementById('screen-' + name);
  if (target) target.classList.remove('hidden');
  window.scrollTo(0, 0);
}

// ---------- セットアップ ----------
function saveSetup() {
  const token = document.getElementById('setup-token').value.trim();
  const gist = document.getElementById('setup-gist').value.trim();
  if (!token || !gist) {
    alert('トークンとGist IDの両方を入力してください');
    return;
  }
  localStorage.setItem(STORAGE_KEYS.token, token);
  localStorage.setItem(STORAGE_KEYS.gistId, gist);
  state.token = token;
  state.gistId = gist;
  showTableSelect();
}

function toggleHelp() {
  document.getElementById('help-block').classList.toggle('hidden');
}

function resetSetup() {
  if (confirm('セットアップをやり直しますか？')) {
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.gistId);
    location.reload();
  }
}

// ---------- テーブル選択 ----------
function showTableSelect() {
  const grid = document.getElementById('table-grid');
  grid.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const cell = document.createElement('div');
    cell.className = 'table-cell';
    cell.textContent = i;
    cell.onclick = () => selectTable(i);
    grid.appendChild(cell);
  }

  const params = new URLSearchParams(window.location.search);
  const tParam = params.get('table');
  if (tParam) {
    const n = parseInt(tParam);
    if (n >= 1 && n <= 10) selectTable(n);
  }

  showScreen('table');
}

function selectTable(n) {
  state.tableNum = n;
  document.querySelectorAll('#table-grid .table-cell').forEach((c, i) => {
    c.classList.toggle('selected', i + 1 === n);
  });
  document.getElementById('btn-join').disabled = !state.tableNum;
}

async function joinTable() {
  if (!state.tableNum) return;

  try {
    const updated = await updateTable(t => {
      // playersが配列でない場合の防御
      if (!Array.isArray(t.players)) t.players = [];
      const existing = t.players.find(p => p.id === state.playerId);
      if (!existing) {
        t.players.push({
          id: state.playerId,
          name: '',  // 後で振り直し
          joinedAt: Date.now(),
          isGhost: false
        });
      }
      // 全員の番号を振り直し
      renumberPlayers(t);
      return t;
    });
    if (updated && Array.isArray(updated.players)) {
      const me = updated.players.find(p => p.id === state.playerId);
      state.playerName = me ? me.name : 'プレイヤー';
    }
    enterLobby();
  } catch (e) {
    console.error('joinTable error:', e);
    alert('テーブル接続に失敗しました: ' + (e.message || e));
  }
}

// プレイヤー番号を1から順に振り直す
function renumberPlayers(t) {
  // joinedAt 順にソートして番号を振り直す
  t.players.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  t.players.forEach((p, i) => {
    p.name = 'プレイヤー' + (i + 1);
  });
}

// ---------- ロビー ----------
function enterLobby() {
  document.getElementById('lobby-table-num').textContent = state.tableNum;
  showScreen('lobby');
  startPolling();
}

function renderLobby(tableData) {
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  const activeId = getActiveId();
  tableData.players.forEach((p, i) => {
    const chip = document.createElement('div');
    let cls = 'player-chip-with-remove';
    if (i === 0) cls += ' host';
    if (p.id === activeId) cls += ' you';
    chip.className = cls;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name + (p.id === activeId ? '（あなた）' : '');
    chip.appendChild(nameSpan);

    // ❌ボタン（自分以外の場合）
    if (p.id !== activeId) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'chip-remove-btn';
      removeBtn.textContent = '✕';
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        removePlayer(p.id, p.name);
      };
      chip.appendChild(removeBtn);
    }

    list.appendChild(chip);
  });
  document.getElementById('btn-start').disabled = tableData.players.length < 3;

  // 自分が操作可能なプレイヤー一覧（切替UI）
  renderControlSwitcher(tableData);
}

// プレイヤーを削除
async function removePlayer(playerId, playerName) {
  if (!confirm(`${playerName} を削除しますか？`)) return;
  try {
    await updateTable(t => {
      t.players = t.players.filter(p => p.id !== playerId);
      if (t.answererId === playerId) t.answererId = null;
      t.candidates = (t.candidates || []).filter(id => id !== playerId);
      delete t.hints[playerId];
      // 番号振り直し
      renumberPlayers(t);
      return t;
    });
    // 自分が操作していたゴーストを削除した場合、自分のIDに戻す
    if (state.currentControlledId === playerId) {
      state.currentControlledId = null;
    }
  } catch (e) {
    alert('削除失敗: ' + e.message);
  }
}

function renderControlSwitcher(tableData) {
  // 古い「各画面のカード」は非表示にする
  const cards = ['control-switcher-card', 'volunteer-switcher-card', 'hint-switcher-card', 'answer-switcher-card', 'watch-switcher-card', 'review-switcher-card'];
  cards.forEach(id => {
    const card = document.getElementById(id);
    if (card) card.style.display = 'none';
  });

  // フローティングボタンの表示制御
  const fab = document.getElementById('floating-switcher');
  if (!fab) return;

  const controllable = getControllablePlayers(tableData);
  if (controllable.length <= 1) {
    fab.classList.add('hidden');
    return;
  }

  fab.classList.remove('hidden');
  const activeId = getActiveId();
  const activePlayer = tableData.players.find(p => p.id === activeId);
  const label = document.getElementById('fs-current-name');
  if (label && activePlayer) {
    label.textContent = activePlayer.name;
  }

  // モーダルが開いていれば中身も更新
  const modal = document.getElementById('switcher-modal');
  if (modal && !modal.classList.contains('hidden')) {
    renderSwitcherModal(tableData);
  }
}

let lastTableDataCache = null;

function openSwitcherModal() {
  if (!lastTableDataCache) return;
  renderSwitcherModal(lastTableDataCache);
  document.getElementById('switcher-modal').classList.remove('hidden');
}

function closeSwitcherModal() {
  document.getElementById('switcher-modal').classList.add('hidden');
}

function renderSwitcherModal(tableData) {
  const list = document.getElementById('switcher-modal-list');
  if (!list) return;
  const controllable = getControllablePlayers(tableData);
  const activeId = getActiveId();
  list.innerHTML = '';
  controllable.forEach(p => {
    const isActive = p.id === activeId;
    const btn = document.createElement('button');
    btn.className = 'switcher-player-btn' + (isActive ? ' active' : '');

    // プレイヤーの現在の状態を表示
    let status = '';
    if (tableData.answererId === p.id) {
      status = '🎤 回答者';
    } else if (tableData.phase === 'hinting' && tableData.hints[p.id]) {
      status = '✅ ヒント送信済';
    } else if (tableData.phase === 'hinting') {
      status = '✏️ ヒント未入力';
    } else if ((tableData.candidates || []).includes(p.id)) {
      status = '🙋 立候補中';
    }

    btn.innerHTML = `${escapeHtml(p.name)}${isActive ? ' ✓' : ''} ${status ? `<span class="player-status">${status}</span>` : ''}`;
    btn.onclick = () => {
      switchControl(p.id);
      closeSwitcherModal();
    };
    list.appendChild(btn);
  });
}

async function startGame() {
  try {
    await updateTable(t => {
      if (t.players.length < 3) return null;
      t.phase = 'volunteer';
      t.candidates = [];
      t.readyToConfirm = [];
      t.answererId = null;
      t.hints = {};
      t.attempts = [];
      t.cardId = null;
      t.item = null;
      t.topic = null;
      t.theme = null;
      t.revealed = false;
      t.result = null;
      return t;
    });
    state.pickInitialized = false;  // 次のお題選択でランダム化
  } catch (e) {
    alert('ゲーム開始に失敗: ' + e.message);
  }
}

async function leaveTable() {
  if (!confirm('テーブルから抜けますか？')) return;
  try {
    await updateTable(t => {
      // 自分が操作していたゴースト含め全部削除
      const ghostsControlledByMe = (t.players || []).filter(p => p.isGhost && p.controlledBy === state.playerId).map(p => p.id);
      const idsToRemove = [state.playerId, ...ghostsControlledByMe];
      t.players = t.players.filter(p => !idsToRemove.includes(p.id));
      if (idsToRemove.includes(t.answererId)) {
        t.phase = 'lobby';
        t.answererId = null;
      }
      t.candidates = (t.candidates || []).filter(id => !idsToRemove.includes(id));
      idsToRemove.forEach(id => delete t.hints[id]);
      // 番号振り直し
      renumberPlayers(t);
      return t;
    });
  } catch (e) { /* 無視 */ }
  stopPolling();
  stopResetCheckPolling();
  state.tableNum = null;
  state.currentControlledId = null;
  state.hasConfirmedJoin = false;
  // フローティングボタンを隠す
  const fab = document.getElementById('floating-switcher');
  if (fab) fab.classList.add('hidden');
  const resetBtn = document.getElementById('floating-reset');
  if (resetBtn) resetBtn.classList.add('hidden');
  showTableSelect();
}

// ホストがプレイヤーを追加（自分が操作するゴーストプレイヤー）
async function addGhostPlayer() {
  try {
    await updateTable(t => {
      const ghostId = 'g_' + Math.random().toString(36).substring(2, 10);
      t.players.push({
        id: ghostId,
        name: '',
        joinedAt: Date.now(),
        isGhost: true,
        controlledBy: state.playerId  // 誰が操作するか
      });
      renumberPlayers(t);
      return t;
    });
  } catch (e) {
    alert('プレイヤー追加失敗: ' + e.message);
  }
}

// 自分が操作するプレイヤーを切替
function switchControl(pid) {
  state.currentControlledId = pid;
  state.justSwitched = true;  // 切替直後フラグ
  state.lastHintInputOwner = null;  // 強制再描画
  // 入力欄を即座にクリア
  const hintInput = document.getElementById('hint-input');
  if (hintInput) hintInput.value = '';
  const ansInput = document.getElementById('answer-input');
  if (ansInput) ansInput.value = '';
  // 即座に再描画
  pollOnce();
}

// 現在「自分」として扱うプレイヤーIDを取得
function getActiveId() {
  return state.currentControlledId || state.playerId;
}

// 自分が操作可能なプレイヤー一覧
function getControllablePlayers(t) {
  return (t.players || []).filter(p =>
    p.id === state.playerId ||
    (p.isGhost && p.controlledBy === state.playerId)
  );
}

// ---------- 回答者決め画面（ホスト方式） ----------
function renderVolunteerScreen(tableData) {
  const myActiveId = getActiveId();
  const players = tableData.players || [];

  // ホスト（最初に入った人 = プレイヤー1）かどうか判定
  const sortedByJoined = [...players].sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  const hostId = sortedByJoined.length > 0 ? sortedByJoined[0].id : null;
  // 自分（または自分が操作中のゴースト）がホストかどうか
  const myControllable = getControllablePlayers(tableData);
  const isHost = myControllable.some(p => p.id === hostId);
  // ホストとして操作する画面：自分が操作中のプレイヤーがホストの場合
  const meIsHost = myActiveId === hostId;

  const hostArea = document.getElementById('host-decide-area');
  const nonHostArea = document.getElementById('non-host-wait-area');

  if (meIsHost) {
    // ホスト用画面を表示
    if (hostArea) hostArea.style.display = 'block';
    if (nonHostArea) nonHostArea.style.display = 'none';

    // プレイヤーリストを描画（ホスト以外のメンバー）
    const list = document.getElementById('host-player-list');
    if (list) {
      list.innerHTML = '';
      players.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary';
        btn.style.cssText = 'background: white; color: var(--ink);';
        btn.textContent = '🎤 ' + p.name + (p.id === hostId ? '（ホスト）' : '');
        btn.onclick = () => decideAnswerer(p.id);
        list.appendChild(btn);
      });
    }
  } else {
    // 非ホスト用画面を表示
    if (hostArea) hostArea.style.display = 'none';
    if (nonHostArea) nonHostArea.style.display = 'block';
  }
}

// ホストが回答者を決定する
async function decideAnswerer(target) {
  try {
    await updateTable(t => {
      const players = t.players || [];
      if (players.length === 0) return null;

      let chosenId;
      if (target === 'random') {
        const idx = Math.floor(Math.random() * players.length);
        chosenId = players[idx].id;
      } else {
        chosenId = target;
      }
      t.answererId = chosenId;
      t.phase = 'picking';
      t.candidates = [];
      t.readyToConfirm = [];
      t.hints = {};
      t.attempts = [];
      return t;
    });
    // 立候補画面から離れるのでローカル状態クリア
    state.localVolunteerState = {};
    state.localReadyState = {};
    // 通常ポーリングに戻す
    adjustPollingInterval('picking', false, null);
    pollOnce();
  } catch (e) {
    alert('回答者決定失敗: ' + e.message);
  }
}


// ---------- お題選択 ----------
function renderPickScreen() {
  const sel = document.getElementById('pick-card');
  if (sel.options.length === 0) {
    getAllCardIds().forEach(id => {
      const card = getCardById(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${id}番 — ${card.theme}`;
      sel.appendChild(opt);
    });
  }
  // 画面を開くたびにランダムでカードを初期選択（state.pickInitialized 管理）
  if (!state.pickInitialized) {
    const allIds = getAllCardIds();
    const randomId = allIds[Math.floor(Math.random() * allIds.length)];
    sel.value = randomId;
    state.pickInitialized = true;
  }
}

async function pickItem(letter) {
  const cardId = parseInt(document.getElementById('pick-card').value);
  const card = getCardById(cardId);
  if (!card) return;
  const topic = card.items[letter];
  try {
    await updateTable(t => {
      t.cardId = cardId;
      t.item = letter;
      t.topic = topic;
      t.theme = card.theme;
      t.phase = 'hinting';
      t.hints = {};
      return t;
    });
  } catch (e) {
    alert('お題セット失敗: ' + e.message);
  }
}

async function randomPick() {
  const card = getRandomCard();
  const letters = ['A', 'B', 'C', 'D'];
  const letter = letters[Math.floor(Math.random() * 4)];
  const topic = card.items[letter];
  try {
    await updateTable(t => {
      t.cardId = card.id;
      t.item = letter;
      t.topic = topic;
      t.theme = card.theme;
      t.phase = 'hinting';
      t.hints = {};
      return t;
    });
  } catch (e) {
    alert('ランダム選択失敗: ' + e.message);
  }
}

// ---------- ヒント入力 ----------
function renderHintScreen(tableData) {
  document.getElementById('hint-theme').textContent = tableData.theme || '';
  document.getElementById('hint-topic').textContent = tableData.topic || '';
  const answerer = tableData.players.find(p => p.id === tableData.answererId);
  document.getElementById('hint-answerer').textContent = answerer ? answerer.name : '?';

  const activeId = getActiveId();
  const myHint = tableData.hints[activeId];
  const input = document.getElementById('hint-input');
  const btn = document.getElementById('btn-submit-hint');

  // 入力中は再描画をスキップ（フォーカス維持・誤クリア対策）
  if (document.activeElement === input && input.value.length > 0 && !myHint) {
    // ヒント状況リストだけ更新
    renderHintStatusOnly(tableData);
    return;
  }

  // 入力欄をクリアするケース：
  // 1. プレイヤー切替直後
  // 2. このプレイヤーが既に送信済み
  // 3. 違うプレイヤーが操作中になった（前のプレイヤーの内容が残っている）
  if (state.justSwitched || myHint || state.lastHintInputOwner !== activeId) {
    input.value = '';
  }
  state.lastHintInputOwner = activeId;

  if (myHint) {
    input.disabled = true;
    btn.disabled = true;
    btn.textContent = '送信済み ✅';
  } else {
    input.disabled = false;
    btn.disabled = false;
    btn.textContent = '送信 ✨';
  }
  state.justSwitched = false;

  renderHintStatusOnly(tableData);
}

function renderHintStatusOnly(tableData) {
  const activeId = getActiveId();
  const statusList = document.getElementById('hint-status');
  statusList.innerHTML = '';
  const nonAnswerers = tableData.players.filter(p => p.id !== tableData.answererId);
  nonAnswerers.forEach(p => {
    const item = document.createElement('div');
    const submitted = tableData.hints[p.id];
    item.className = 'hint-item' + (submitted ? '' : ' waiting');
    item.innerHTML = `
      <span class="hint-name">${escapeHtml(p.name)}${p.id === activeId ? '（あなた）' : ''}</span>
      <span class="hint-badge ${submitted ? '' : 'waiting'}">${submitted ? '入力済' : '入力中…'}</span>
    `;
    statusList.appendChild(item);
  });
}

async function submitHint() {
  const inputEl = document.getElementById('hint-input');
  const word = inputEl.value.trim();
  if (!word) {
    alert('ヒントを入力してください');
    return;
  }
  const activeId = getActiveId();

  // 押した瞬間に入力欄を即クリア（次のプレイヤーに見えないようにする）
  inputEl.value = '';
  state.lastHintInputOwner = null;

  try {
    await updateTable(t => {
      t.hints[activeId] = { word, dup: false };
      const nonAnswerers = t.players.filter(p => p.id !== t.answererId);
      const allSubmitted = nonAnswerers.every(p => t.hints[p.id]);
      if (allSubmitted) {
        const normalize = s => s.toLowerCase().replace(/\s+/g, '').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
        const counts = {};
        Object.values(t.hints).forEach(h => {
          const norm = normalize(h.word);
          counts[norm] = (counts[norm] || 0) + 1;
        });
        Object.values(t.hints).forEach(h => {
          h.dup = counts[normalize(h.word)] > 1;
        });
        t.phase = 'reviewing';
      }
      return t;
    });
    // ヒント送信後はポーリング再開
    startPolling();
  } catch (e) {
    alert('送信失敗: ' + e.message);
  }
}

// ---------- 回答者待機（進捗表示） ----------
function renderAnswererWait(tableData) {
  const area = document.getElementById('wait-progress');
  if (!area) return;
  if (tableData.phase === 'hinting') {
    const nonAnswerers = tableData.players.filter(p => p.id !== tableData.answererId);
    const submitted = nonAnswerers.filter(p => tableData.hints[p.id]).length;
    area.innerHTML = `<div class="wait-progress-bar">📝 ${submitted} / ${nonAnswerers.length} 人が入力済み</div>`;
  } else if (tableData.phase === 'reviewing') {
    area.innerHTML = `<div class="wait-progress-bar">🔍 ヒント役がかぶりチェック中</div>`;
  } else {
    area.innerHTML = '';
  }
}

// ---------- レビュー ----------
function renderReviewScreen(tableData) {
  document.getElementById('review-topic').textContent = tableData.topic;
  const list = document.getElementById('review-hints');
  list.innerHTML = '';
  Object.entries(tableData.hints).forEach(([pid, h]) => {
    const player = tableData.players.find(p => p.id === pid);
    const item = document.createElement('div');
    item.className = 'hint-item review-clickable' + (h.dup ? ' duplicate' : '');
    item.style.cursor = 'pointer';
    item.innerHTML = `
      <span class="hint-word">${escapeHtml(h.word)}</span>
      <span class="hint-name">${escapeHtml(player ? player.name : '?')}${h.dup ? '・NG ❌' : ''}</span>
    `;
    item.onclick = () => toggleHintDuplicate(pid);
    list.appendChild(item);
  });

  // 説明文を追加
  const note = document.getElementById('review-note');
  if (note) {
    note.innerHTML = '💡 各ヒントをタップすると NG ↔ OK を切替できます';
  }
}

// 手動でヒントの「ダメ」を切替
async function toggleHintDuplicate(pid) {
  try {
    await updateTable(t => {
      if (t.hints && t.hints[pid]) {
        t.hints[pid].dup = !t.hints[pid].dup;
      }
      return t;
    });
  } catch (e) {
    alert('切替失敗: ' + e.message);
  }
}

async function revealHints() {
  try {
    await updateTable(t => {
      t.revealed = true;
      t.phase = 'answering';
      return t;
    });
  } catch (e) {
    alert('公開失敗: ' + e.message);
  }
}

// ---------- 回答 ----------
function renderAnswerScreen(tableData) {
  const list = document.getElementById('answer-hints');
  list.innerHTML = '';
  Object.entries(tableData.hints).forEach(([pid, h]) => {
    if (h.dup) return;
    const player = tableData.players.find(p => p.id === pid);
    const item = document.createElement('div');
    item.className = 'hint-item';
    item.innerHTML = `
      <span class="hint-word">${escapeHtml(h.word)}</span>
      <span class="hint-name">${escapeHtml(player ? player.name : '?')}</span>
    `;
    list.appendChild(item);
  });
  document.getElementById('attempts-left').textContent = 3 - (tableData.attempts ? tableData.attempts.length : 0);

  // 回答履歴を表示（〇✕付き）
  const attemptsArea = document.getElementById('answer-attempts-history');
  if (attemptsArea) {
    const attempts = tableData.attempts || [];
    if (attempts.length === 0) {
      attemptsArea.innerHTML = '';
    } else {
      let html = '<div class="card-label" style="margin-bottom:8px;">📜 これまでの回答</div><div class="hints-list">';
      attempts.forEach((a, i) => {
        const mark = a.correct ? '✅' : '❌';
        const label = a.correct ? '正解！' : 'ハズレ';
        html += `<div class="hint-item ${a.correct ? '' : 'duplicate'}"><span class="hint-word">${i + 1}回目: ${escapeHtml(a.word)}</span><span class="hint-name">${mark} ${label}</span></div>`;
      });
      html += '</div>';
      attemptsArea.innerHTML = html;
    }
  }

  // 切替直後は入力欄クリア
  if (state.justSwitched) {
    const ansInput = document.getElementById('answer-input');
    if (ansInput) ansInput.value = '';
  }
}

async function submitAnswer() {
  const ans = document.getElementById('answer-input').value.trim();
  if (!ans) return;
  try {
    await updateTable(t => {
      const correct = normalizeAnswer(ans) === normalizeAnswer(t.topic);
      t.attempts.push({ word: ans, correct });
      if (correct) {
        t.phase = 'result';
        t.result = 'win';
      } else if (t.attempts.length >= 3) {
        t.phase = 'result';
        t.result = 'lose';
      }
      return t;
    });
    document.getElementById('answer-input').value = '';
    // 回答後は必ずポーリング再開
    startPolling();
  } catch (e) {
    alert('回答送信失敗: ' + e.message);
  }
}

async function giveUp() {
  if (!confirm('降参しますか？')) return;
  try {
    await updateTable(t => {
      t.phase = 'result';
      t.result = 'lose';
      return t;
    });
    startPolling();
  } catch (e) { /* 無視 */ }
}

// 強制正解（ヒント側が「それ実は正解！」と認める）
async function forceCorrect() {
  if (!confirm('回答者の最新回答を「正解」として認めますか？\n\n例：表記ゆれ・同義語などで惜しい場合に使ってください。')) return;
  try {
    await updateTable(t => {
      const attempts = t.attempts || [];
      if (attempts.length === 0) {
        alert('まだ回答がありません');
        return null;
      }
      // 最新の回答を正解にして、ゲーム結果を「勝ち」にする
      attempts[attempts.length - 1].correct = true;
      attempts[attempts.length - 1].forced = true;
      t.phase = 'result';
      t.result = 'win';
      return t;
    });
  } catch (e) {
    alert('強制正解失敗: ' + e.message);
  }
}

function normalizeAnswer(s) {
  if (!s) return '';
  return s.toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[ー－]/g, '');
}

// ---------- 観戦 ----------
function renderWatchScreen(tableData) {
  document.getElementById('watch-topic').textContent = tableData.topic;
  const list = document.getElementById('watch-hints');
  list.innerHTML = '';
  Object.entries(tableData.hints).forEach(([pid, h]) => {
    const player = tableData.players.find(p => p.id === pid);
    const item = document.createElement('div');
    item.className = 'hint-item' + (h.dup ? ' duplicate' : '');
    item.innerHTML = `
      <span class="hint-word">${escapeHtml(h.word)}</span>
      <span class="hint-name">${escapeHtml(player ? player.name : '?')}${h.dup ? '・かぶり' : ''}</span>
    `;
    list.appendChild(item);
  });

  const attemptsList = document.getElementById('watch-attempts');
  attemptsList.innerHTML = '';
  (tableData.attempts || []).forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'hint-item';
    item.innerHTML = `
      <span class="hint-word">${i + 1}回目: ${escapeHtml(a.word)}</span>
      <span class="hint-name">${a.correct ? '✅ 正解' : '❌ ハズレ'}</span>
    `;
    attemptsList.appendChild(item);
  });
  if ((tableData.attempts || []).length === 0) {
    attemptsList.innerHTML = '<div class="hint-item waiting"><span>まだ回答していません</span></div>';
  }

  // 強制正解ボタンの表示制御（誤回答が1つ以上ある場合のみ表示）
  const forceBtn = document.getElementById('btn-force-correct');
  if (forceBtn) {
    const hasIncorrectAttempt = (tableData.attempts || []).some(a => !a.correct);
    if (hasIncorrectAttempt) {
      forceBtn.style.display = 'block';
    } else {
      forceBtn.style.display = 'none';
    }
  }
}

// ---------- 結果 ----------
function renderResultScreen(tableData) {
  const win = tableData.result === 'win';
  document.getElementById('result-emoji').textContent = win ? '🎉' : '😢';
  const resultText = document.getElementById('result-text');
  resultText.textContent = win ? '🎉 正解！ 🎉' : '残念！';
  resultText.className = 'result-text' + (win ? ' win' : '');
  document.getElementById('result-topic').textContent = tableData.topic;

  // 結果カード自体に勝利エフェクト
  const resultCard = document.getElementById('result-card');
  if (resultCard) {
    resultCard.className = 'card yellow' + (win ? ' winning-card' : '');
  }

  // 勝利時の盛り上げメッセージ
  const celebration = document.getElementById('result-celebration');
  if (celebration) {
    if (win) {
      const messages = [
        '🌟 ナイス推理！🌟',
        '🎊 ばっちり！🎊',
        '👏 お見事！👏',
        '✨ さすが！ ✨',
        '🏆 完璧！🏆',
        '🎯 ストライク！🎯'
      ];
      const msg = messages[Math.floor(Math.random() * messages.length)];
      celebration.innerHTML = `<div class="celebration-msg">${msg}</div>`;
    } else {
      celebration.innerHTML = '';
    }
  }

  const list = document.getElementById('result-history');
  list.innerHTML = '';
  (tableData.attempts || []).forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'hint-item';
    let label = a.correct ? '✅ 正解' : '❌ ハズレ';
    if (a.forced) label = '✨ 救済正解！';
    item.innerHTML = `
      <span class="hint-word">${i + 1}回目: ${escapeHtml(a.word)}</span>
      <span class="hint-name">${label}</span>
    `;
    list.appendChild(item);
  });
  if ((tableData.attempts || []).length === 0) {
    list.innerHTML = '<div class="hint-item waiting"><span>降参しました</span></div>';
  }

  // 強制正解ボタン（負け & 回答者でない場合のみ表示）
  const forceBtn = document.getElementById('btn-force-correct-result');
  if (forceBtn) {
    const isAnswerer = tableData.answererId === getActiveId();
    const hasAttempt = (tableData.attempts || []).length > 0;
    if (!win && !isAnswerer && hasAttempt) {
      forceBtn.style.display = 'block';
    } else {
      forceBtn.style.display = 'none';
    }
  }

  // 勝利時は紙吹雪を盛大に追加
  if (win && state.lastResultEmoji !== 'win') {
    confettiBurst();
    setTimeout(() => confettiBurst(), 500);
    setTimeout(() => confettiBurst(), 1000);
    state.lastResultEmoji = 'win';
  } else if (!win) {
    state.lastResultEmoji = 'lose';
  }
}

// 結果画面から強制正解
async function forceCorrectFromResult() {
  if (!confirm('回答者の最新回答を「正解」として認めますか？\n\n惜しい回答だった場合の救済措置です。')) return;
  try {
    await updateTable(t => {
      const attempts = t.attempts || [];
      if (attempts.length === 0) {
        alert('まだ回答がありません');
        return null;
      }
      // 最新の回答を正解にして、ゲーム結果を「勝ち」にする
      attempts[attempts.length - 1].correct = true;
      attempts[attempts.length - 1].forced = true;
      t.result = 'win';
      return t;
    });
  } catch (e) {
    alert('救済正解失敗: ' + e.message);
  }
}

async function nextRound() {
  try {
    await updateTable(t => {
      t.phase = 'volunteer';
      t.candidates = [];
      t.readyToConfirm = [];
      t.answererId = null;
      t.cardId = null;
      t.item = null;
      t.topic = null;
      t.theme = null;
      t.hints = {};
      t.revealed = false;
      t.attempts = [];
      t.result = null;
      return t;
    });
    state.pickInitialized = false;
    state.lastResultEmoji = null;
  } catch (e) {
    alert('次のゲーム開始に失敗: ' + e.message);
  }
}

// ゲームリセット（プレイヤーは残す、ロビーに戻す）
async function resetGame() {
  if (!confirm('このテーブルをリセットしますか？\n\n・プレイヤー全員が退室になります\n・お題・ヒント・回答は全部消えます\n・全員がテーブル選択画面に戻ります')) return;
  try {
    await updateTable(t => {
      // 完全リセット：プレイヤーも含めて全クリア
      t.phase = 'lobby';
      t.players = [];
      t.candidates = [];
      t.readyToConfirm = [];
      t.answererId = null;
      t.cardId = null;
      t.item = null;
      t.topic = null;
      t.theme = null;
      t.hints = {};
      t.revealed = false;
      t.attempts = [];
      t.result = null;
      return t;
    });
    state.pickInitialized = false;
    state.lastHintInputOwner = null;
    state.localVolunteerState = {};
    state.localReadyState = {};
    state.currentControlledId = null;
    // 入力欄もクリア
    const hintInput = document.getElementById('hint-input');
    if (hintInput) hintInput.value = '';
    const ansInput = document.getElementById('answer-input');
    if (ansInput) ansInput.value = '';
    // 自分もテーブル選択画面に戻る
    stopPolling();
    stopResetCheckPolling();
    state.tableNum = null;
    state.hasConfirmedJoin = false;
    // フローティングボタンを隠す
    const fab = document.getElementById('floating-switcher');
    if (fab) fab.classList.add('hidden');
    const resetBtn = document.getElementById('floating-reset');
    if (resetBtn) resetBtn.classList.add('hidden');
    showTableSelect();
  } catch (e) {
    alert('リセット失敗: ' + e.message);
  }
}

// ---------- ポーリング ----------
function startPolling() {
  stopPolling();
  pollOnce();
  state.pollInterval = 3000;  // デフォルト3秒
  state.pollTimer = setInterval(pollOnce, state.pollInterval);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// フェーズに応じてポーリング間隔を切替・停止
// 回答中／ヒント入力中／立候補中はポーリング完全停止（操作を邪魔しない）
function adjustPollingInterval(phase, isAnswerer, tableData) {
  // 回答画面（回答者）：ポーリング停止
  if (phase === 'answering' && isAnswerer) {
    stopPolling();
    return;
  }
  // ヒント入力画面（送信前のヒント役）：ポーリング停止
  if (phase === 'hinting' && !isAnswerer && tableData && !tableData.hints[getActiveId()]) {
    stopPolling();
    return;
  }
  // 立候補画面：通常ポーリングは止めるが、リセット検知だけ別の軽量ポーリングで実行
  if (phase === 'volunteer') {
    stopPolling();
    startResetCheckPolling();
    return;
  }

  // 通常画面のポーリング
  stopResetCheckPolling();
  const targetInterval = (phase === 'lobby') ? 5000 : 2000;
  if (state.pollInterval !== targetInterval || !state.pollTimer) {
    state.pollInterval = targetInterval;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollOnce, targetInterval);
  }
}

// リセット検知だけする軽量ポーリング（立候補画面用）
function startResetCheckPolling() {
  if (state.resetCheckTimer) return;
  state.resetCheckTimer = setInterval(async () => {
    try {
      const tableData = await readTable();
      // 自分がいなくなっている = リセットされた
      const players = tableData.players || [];
      const stillInTable = players.find(p => p.id === state.playerId);
      if (state.tableNum && !stillInTable && state.hasConfirmedJoin) {
        stopPolling();
        stopResetCheckPolling();
        state.tableNum = null;
        state.currentControlledId = null;
        state.localVolunteerState = {};
        state.localReadyState = {};
        state.lastPhase = null;
        state.hasConfirmedJoin = false;
        const fab = document.getElementById('floating-switcher');
        if (fab) fab.classList.add('hidden');
        const resetBtn = document.getElementById('floating-reset');
        if (resetBtn) resetBtn.classList.add('hidden');
        alert('テーブルがリセットされました');
        showTableSelect();
        return;
      }
      // フェーズが変わってたら（誰かが抽選を引き当てた）通常画面遷移
      if (tableData.phase !== 'volunteer') {
        stopResetCheckPolling();
        lastTableDataCache = tableData;
        adjustPollingInterval(tableData.phase, tableData.answererId === getActiveId(), tableData);
        routeByPhase(tableData);
      }
    } catch (e) {
      console.error('Reset check error:', e);
    }
  }, 8000);  // 8秒間隔（軽量に）
}

function stopResetCheckPolling() {
  if (state.resetCheckTimer) {
    clearInterval(state.resetCheckTimer);
    state.resetCheckTimer = null;
  }
}

// 手動更新ボタンから呼ばれる
async function manualRefresh() {
  const btn = document.getElementById('btn-manual-refresh');
  if (btn) {
    btn.disabled = true;
    // 同じ長さの文字列で幅変化を防ぐ
    btn.textContent = '🔄 更新中.........';
  }
  try {
    await pollOnce();
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 最新の状態に更新';
      }
    }, 600);
  }
}

// 回答画面でのヒント手動更新（入力欄を絶対に触らない）
async function manualRefreshAnswer() {
  try {
    const tableData = await readTable();
    lastTableDataCache = tableData;

    // ヒント一覧だけ静かに更新（入力欄には触れない）
    const list = document.getElementById('answer-hints');
    if (list) {
      list.innerHTML = '';
      Object.entries(tableData.hints || {}).forEach(([pid, h]) => {
        if (h.dup) return;
        const player = (tableData.players || []).find(p => p.id === pid);
        const item = document.createElement('div');
        item.className = 'hint-item';
        item.innerHTML = `
          <span class="hint-word">${escapeHtml(h.word)}</span>
          <span class="hint-name">${escapeHtml(player ? player.name : '?')}</span>
        `;
        list.appendChild(item);
      });
    }
    // フェーズが変わってたら（誰かが回答完了など）通常ルートに合流
    if (tableData.phase !== 'answering') {
      // ポーリング再開して画面遷移を任せる
      adjustPollingInterval(tableData.phase, tableData.answererId === getActiveId(), tableData);
      pollOnce();
    }
  } catch (e) {
    console.error('manualRefreshAnswer error:', e);
  }
}

// 立候補画面でみんなの状況を手動更新（自分のボタン状態は変えない）
async function manualRefreshVolunteer() {
  const btn = document.getElementById('btn-refresh-volunteer');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '🔄 更新中.........';
  }
  try {
    const tableData = await readTable();
    lastTableDataCache = tableData;

    // フェーズが変わってたら（誰か他の人の操作で次に進んだ）画面遷移
    if (tableData.phase !== 'volunteer') {
      adjustPollingInterval(tableData.phase, tableData.answererId === getActiveId(), tableData);
      routeByPhase(tableData);
      return;
    }

    // 立候補チップ・準備完了状況だけ更新（ボタン状態はローカル優先のロジックでそのまま守られる）
    renderVolunteerScreen(tableData);

    // 全員準備完了なら抽選判定をローカルでも確認
    // ただし抽選書き込みは元のconfirmAnswerer内で全員揃ったタイミングで実行されているはず
    // 念のため、ローカル状態 + Gist状態を合わせて、もし全員揃ってればもう一度同期トリガー
    await checkAllReadyAndAdvance();
  } catch (e) {
    console.error('manualRefreshVolunteer error:', e);
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 みんなの状況を更新';
      }
    }, 600);
  }
}

// 全員準備完了かを確認して、揃っていれば抽選を実行する
async function checkAllReadyAndAdvance() {
  try {
    const tableData = await readTable();
    if (tableData.phase !== 'volunteer') return;
    const players = tableData.players || [];
    const readyList = tableData.readyToConfirm || [];
    if (players.length === 0) return;
    const allReady = players.every(p => readyList.includes(p.id));
    if (allReady) {
      // 抽選実行
      await updateTable(t => {
        if (t.phase !== 'volunteer') return null;
        const candidates = t.candidates || [];
        let pool;
        if (candidates.length > 0) {
          pool = candidates;
        } else {
          pool = t.players.map(p => p.id);
        }
        const idx = Math.floor(Math.random() * pool.length);
        t.answererId = pool[idx];
        t.phase = 'picking';
        t.candidates = [];
        t.readyToConfirm = [];
        t.hints = {};
        t.attempts = [];
        return t;
      });
      state.localVolunteerState = {};
      state.localReadyState = {};
      // 画面遷移のため再ポーリング
      adjustPollingInterval('picking', false, null);
      pollOnce();
    }
  } catch (e) {
    console.error('checkAllReadyAndAdvance error:', e);
  }
}

async function pollOnce() {
  try {
    const tableData = await readTable();
    lastTableDataCache = tableData;
    routeByPhase(tableData);
  } catch (e) {
    console.error('Poll error:', e);
  }
}

function routeByPhase(t) {
  const isAnswerer = t.answererId === getActiveId();
  let target = 'lobby';

  // フェーズに応じてポーリング間隔を調整（回答中・入力中は停止）
  adjustPollingInterval(t.phase, isAnswerer, t);

  // 自分がテーブルから消えていた場合（誰かがリセットした）はテーブル選択画面に戻る
  // ただし、join直後の最初のポーリングでは判定しない（Gistキャッシュで古いデータが返ることがあるため）
  const players = t.players || [];
  const stillInTable = players.find(p => p.id === state.playerId);
  if (state.tableNum && !stillInTable && state.hasConfirmedJoin) {
    stopPolling();
    state.tableNum = null;
    state.currentControlledId = null;
    state.localVolunteerState = {};
    state.localReadyState = {};
    state.lastPhase = null;
    state.hasConfirmedJoin = false;
    const fab = document.getElementById('floating-switcher');
    if (fab) fab.classList.add('hidden');
    const resetBtn = document.getElementById('floating-reset');
    if (resetBtn) resetBtn.classList.add('hidden');
    alert('テーブルがリセットされました');
    showTableSelect();
    return;
  }
  // 自分がplayersに含まれているのを確認できたら、以降はリセット検知を有効化
  if (stillInTable) {
    state.hasConfirmedJoin = true;
  }

  // 立候補フェーズから離れたらローカル状態クリア
  if (t.phase !== 'volunteer') {
    state.localVolunteerState = {};
    state.localReadyState = {};
  }

  // 全画面で切替UI更新
  renderControlSwitcher(t);

  // リセットボタンの表示制御（ロビー以外で表示）
  const resetBtn = document.getElementById('floating-reset');
  if (resetBtn) {
    if (t.phase && t.phase !== 'lobby') {
      resetBtn.classList.remove('hidden');
    } else {
      resetBtn.classList.add('hidden');
    }
  }

  if (t.phase === 'lobby') {
    target = 'lobby';
    renderLobby(t);
  } else if (t.phase === 'volunteer') {
    target = 'volunteer';
    renderVolunteerScreen(t);
  } else if (t.phase === 'picking') {
    if (isAnswerer) {
      target = 'pick';
      renderPickScreen();
    } else {
      target = 'answerer-wait';
      const area = document.getElementById('wait-progress');
      const answerer = t.players.find(p => p.id === t.answererId);
      if (area && answerer) {
        area.innerHTML = `<div class="wait-progress-bar">🎤 ${escapeHtml(answerer.name)}さんがお題選び中</div>`;
      }
    }
  } else if (t.phase === 'hinting') {
    if (isAnswerer) {
      target = 'answerer-wait';
      renderAnswererWait(t);
    } else {
      target = 'hint';
      renderHintScreen(t);
    }
  } else if (t.phase === 'reviewing') {
    if (isAnswerer) {
      target = 'answerer-wait';
      renderAnswererWait(t);
    } else {
      target = 'review';
      renderReviewScreen(t);
    }
  } else if (t.phase === 'answering') {
    if (isAnswerer) {
      target = 'answer';
      renderAnswerScreen(t);
    } else {
      target = 'watch';
      renderWatchScreen(t);
    }
  } else if (t.phase === 'result') {
    target = 'result';
    renderResultScreen(t);
    if (t.result === 'win' && state.lastPhase !== 'result') {
      confettiBurst();
    }
  }

  const phaseKey = target + '|' + getActiveId();
  if (state.lastPhase !== phaseKey) {
    showScreen(target);
    state.lastPhase = phaseKey;
  }
}

// ---------- QR ----------
let qrMode = 'simple'; // 'simple' or 'invite'

function showQR() {
  if (!state.tableNum) {
    alert('まずテーブルを選んでください');
    return;
  }
  qrMode = 'simple';
  updateQRDisplay();
  document.getElementById('qr-modal').classList.remove('hidden');
}

function toggleQRMode() {
  qrMode = qrMode === 'simple' ? 'invite' : 'simple';
  updateQRDisplay();
}

function updateQRDisplay() {
  const baseUrl = `${window.location.origin}${window.location.pathname}`;
  let url;
  if (qrMode === 'invite') {
    // 招待URL：トークン+Gist+テーブル番号を全部含む
    url = `${baseUrl}?token=${encodeURIComponent(state.token)}&gist=${encodeURIComponent(state.gistId)}&table=${state.tableNum}`;
  } else {
    // シンプルURL：テーブル番号のみ
    url = `${baseUrl}?table=${state.tableNum}`;
  }
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`;
  document.getElementById('qr-img').src = qrSrc;
  document.getElementById('qr-url').textContent = url;

  // モード表示
  const modeLabel = document.getElementById('qr-mode-label');
  const modeDesc = document.getElementById('qr-mode-desc');
  const toggleBtn = document.getElementById('qr-toggle-btn');
  if (qrMode === 'invite') {
    modeLabel.textContent = '🎫 招待URL（トークン入り）';
    modeDesc.textContent = '相手は何も入力せず即プレイ可能。漏れると他人にGistを書き換えられる可能性があるので、知り合いだけに共有してください。';
    toggleBtn.textContent = '🔒 シンプルURLに切替';
  } else {
    modeLabel.textContent = '📱 シンプルURL（トークン無し）';
    modeDesc.textContent = '安全だが、相手は別途トークンの入力が必要です。';
    toggleBtn.textContent = '🎫 招待URLに切替（推奨）';
  }
}

function closeQR() {
  document.getElementById('qr-modal').classList.add('hidden');
}

function copyShareLink() {
  const url = document.getElementById('qr-url').textContent;
  if (navigator.share) {
    navigator.share({ title: 'JUST ONE × BBQ', url }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => alert('URLをコピーしました'));
  } else {
    prompt('URLをコピーしてください', url);
  }
}

// ---------- 紙吹雪 ----------
function confettiBurst() {
  const colors = ['#ff6b9d', '#ffd93d', '#4ecdc4', '#a78bfa', '#6bcb77', '#ff8c42'];
  for (let i = 0; i < 50; i++) {
    setTimeout(() => {
      const confetti = document.createElement('div');
      confetti.className = 'confetti';
      confetti.style.left = Math.random() * 100 + 'vw';
      confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
      confetti.style.animationDuration = (2 + Math.random() * 2) + 's';
      confetti.style.borderRadius = Math.random() > 0.5 ? '50%' : '0';
      document.body.appendChild(confetti);
      setTimeout(() => confetti.remove(), 4000);
    }, i * 30);
  }
}

// ---------- ユーティリティ ----------
function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---------- 初期化 ----------
window.addEventListener('DOMContentLoaded', () => {
  ensurePlayerId();

  // URLパラメータからトークン/Gist ID/テーブル番号を取得（招待URL方式）
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  const urlGist = params.get('gist');
  const urlTable = params.get('table');

  // URLにトークン情報があれば、それを優先的に使用（localStorageにも保存）
  if (urlToken && urlGist) {
    state.token = urlToken;
    state.gistId = urlGist;
    localStorage.setItem(STORAGE_KEYS.token, urlToken);
    localStorage.setItem(STORAGE_KEYS.gistId, urlGist);
    // URLからトークンを消す（履歴に残しすぎないため）
    const cleanUrl = window.location.pathname + (urlTable ? '?table=' + urlTable : '');
    window.history.replaceState({}, '', cleanUrl);
    showTableSelect();
    return;
  }

  // localStorageから取得
  const token = localStorage.getItem(STORAGE_KEYS.token);
  const gist = localStorage.getItem(STORAGE_KEYS.gistId);

  if (!token || !gist) {
    showScreen('setup');
  } else {
    state.token = token;
    state.gistId = gist;
    showTableSelect();
  }
});
