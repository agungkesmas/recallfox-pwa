// src/views/focus.js — Tab Fokus: Pomodoro timer + RecallTape
// v1.14.0 (Concept v3): alat harian paling sering dipakai naik jadi tab sendiri.
// Logika Pomodoro di-port setia dari addon lib/pomodoro.js (preset 25/5, 50/10,
// 52/17, 90/20; long break 15m tiap 4 siklus; state sticky).
// Logika Tape di-port setia dari addon lib/tape.js (parser ala CalcTape).
// LOCAL-FIRST: state disimpan di localStorage. TANPA schema Supabase, tanpa sync
// — sama seperti addon (alat ini memang per-device di addon).
//
// Non-disruptif: view ini TIDAK ikut di-re-render realtime/polling (main.js),
// jadi timer tidak pernah ter-reset oleh sinkronisasi vault/notes.

import { evaluate, formatNumber, toPlainText, toMarkdown, loadSession, saveSession } from '../lib/tape.js';
import { createFileItem } from '../sync.js';

// ============================================================
// Pomodoro — port dari addon lib/pomodoro.js
// ============================================================

const POMO_KEY = 'rf_pomo_state_v1';
const LONG_BREAK_MIN = 15;
const PRESETS = {
  '25/5': { work: 25, break: 5 },
  '50/10': { work: 50, break: 10 },
  '52/17': { work: 52, break: 17 },
  '90/20': { work: 90, break: 20 }
};
const MODE_LABEL = { focus: 'FOKUS', break: 'ISTIRAHAT', longBreak: 'ISTIRAHAT PANJANG' };

function getPreset(preset, customWork, customBreak) {
  if (preset === 'custom') {
    const w = Math.max(1, Math.min(120, parseInt(customWork) || 25));
    const b = Math.max(1, Math.min(30, parseInt(customBreak) || 5));
    return { work: w, break: b };
  }
  return PRESETS[preset] || PRESETS['25/5'];
}

function createInitialState() {
  return {
    preset: '25/5', customWork: 25, customBreak: 5,
    mode: 'focus', remaining: 25 * 60,
    running: false, cycles: 0, soundOn: true,
    updatedAt: Date.now()
  };
}

// Mode berikutnya — mirror nextState() addon: tiap 4 fokus → long break 15m
function nextState(state) {
  const p = getPreset(state.preset, state.customWork, state.customBreak);
  let mode = state.mode;
  let cycles = state.cycles;
  let remaining;
  if (mode === 'focus') {
    cycles += 1;
    if (cycles % 4 === 0) {
      mode = 'longBreak';
      remaining = LONG_BREAK_MIN * 60;
    } else {
      mode = 'break';
      remaining = p.break * 60;
    }
  } else {
    mode = 'focus';
    remaining = p.work * 60;
  }
  return { ...state, mode, remaining, cycles, running: false, updatedAt: Date.now() };
}

function modeDuration(state) {
  const p = getPreset(state.preset, state.customWork, state.customBreak);
  if (state.mode === 'focus') return p.work * 60;
  if (state.mode === 'break') return p.break * 60;
  return LONG_BREAK_MIN * 60;
}

function formatMMSS(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

let _pomoState = null;

function loadPomoState() {
  if (_pomoState) return _pomoState;
  try {
    const raw = localStorage.getItem(POMO_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s.remaining === 'number') {
        // Catch-up: kalau timer tertinggal jalan selama app ditutup, hitung sisa
        if (s.running && s.updatedAt) {
          const elapsed = Math.floor((Date.now() - s.updatedAt) / 1000);
          let rem = s.remaining - elapsed;
          let guard = 0;
          while (rem <= 0 && guard < 24) {
            // Mode selesai saat app tertutup — maju ke mode berikutnya
            const dur = modeDurationOf(s);
            rem += dur;
            s.mode = s.mode === 'focus'
              ? (((s.cycles + 1) % 4 === 0) ? 'longBreak' : 'break')
              : 'focus';
            if (s.mode !== 'focus') s.cycles += 1;
            guard++;
          }
          s.remaining = rem;
        }
        s.updatedAt = Date.now();
        _pomoState = s;
        return _pomoState;
      }
    }
  } catch (e) {}
  _pomoState = createInitialState();
  return _pomoState;
}

// durasi mode utk state mentah saat catch-up (sebelum state final)
function modeDurationOf(s) {
  const p = getPreset(s.preset, s.customWork, s.customBreak);
  if (s.mode === 'focus') return p.work * 60;
  if (s.mode === 'break') return p.break * 60;
  return LONG_BREAK_MIN * 60;
}

function savePomoState() {
  if (!_pomoState) return;
  _pomoState.updatedAt = Date.now();
  try { localStorage.setItem(POMO_KEY, JSON.stringify(_pomoState)); } catch (e) {}
}

// Timer berjalan global (sticky ala addon pomodoro) — tetap jalan walau pindah tab
let _pomoInterval = null;
let _audioCtx = null;

function ensureAudio() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  if (_audioCtx && _audioCtx.state === 'suspended') { try { _audioCtx.resume(); } catch (e) {} }
  return _audioCtx;
}

// Bell lembut dua nada (pengganti bell-soft.mp3 addon; tanpa aset tambahan)
function chime() {
  const st = loadPomoState();
  if (!st.soundOn || !_audioCtx) return;
  try {
    const t = _audioCtx.currentTime;
    [[660, 0], [880, 0.22]].forEach(([freq, off]) => {
      const osc = _audioCtx.createOscillator();
      const gain = _audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + off);
      gain.gain.exponentialRampToValueAtTime(0.18, t + off + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.9);
      osc.connect(gain).connect(_audioCtx.destination);
      osc.start(t + off);
      osc.stop(t + off + 1);
    });
  } catch (e) {}
}

function startPomoTicker() {
  if (_pomoInterval) return;
  _pomoInterval = setInterval(() => {
    const st = loadPomoState();
    if (!st.running) return;
    st.remaining -= 1;
    if (st.remaining <= 0) {
      st.remaining = 0;
      chime();
      const ns = nextState(st);
      _pomoState = ns;
    }
    savePomoState();
    updatePomoDom();
  }, 1000);
}

// Update DOM timer kalau sedang tampil (elemen ada) + document.title
function updatePomoDom() {
  const st = loadPomoState();
  const tEl = document.getElementById('pomoTime');
  if (tEl) {
    tEl.textContent = formatMMSS(Math.max(0, st.remaining));
    const dur = modeDuration(st) || 1;
    const frac = Math.max(0, Math.min(1, st.remaining / dur));
    const fg = document.getElementById('pomoRingFg');
    if (fg) {
      const c = 2 * Math.PI * 54;
      fg.setAttribute('stroke-dashoffset', String(c * (1 - frac)));
    }
    const mEl = document.getElementById('pomoMode');
    if (mEl) mEl.textContent = MODE_LABEL[st.mode] || 'FOKUS';
    const ring = document.getElementById('pomoRingFg');
    if (ring) ring.setAttribute('class', 'ring-fg' + (st.mode === 'focus' ? '' : ' brk'));
    const big = document.getElementById('pomoPlay');
    if (big) {
      big.innerHTML = st.running
        ? '<svg viewBox="0 0 24 24"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>';
      big.setAttribute('class', 'big' + (st.mode === 'focus' ? '' : ' brk'));
    }
    // Siklus dots + label
    const wrap = document.getElementById('pomoCyc');
    if (wrap) {
      const n = st.cycles % 4;
      let html = '';
      for (let i = 0; i < 4; i++) html += '<i class="' + (i < n ? 'on' : '') + '"></i>';
      wrap.innerHTML = html;
      const lb = document.getElementById('pomoCycLb');
      if (lb) lb.textContent = n + '/4';
    }
    const bell = document.getElementById('pomoBell');
    if (bell) bell.textContent = st.soundOn ? 'Bell aktif' : 'Bell mati';
  }
  // Sticky title ala addon pomodoro
  document.title = st.running
    ? formatMMSS(Math.max(0, st.remaining)) + ' · ' + (MODE_LABEL[st.mode] || '') + ' — RecallFox'
    : 'RecallFox PWA';
}

// ============================================================
// Render view
// ============================================================

const IC = {
  timer: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7.5"/><path d="M12 10v3.5l2.5 1.5"/><path d="M9.5 2.5h5"/></svg>',
  tape: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h4"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M8 3v5h7V3"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/></svg>',
  clear: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  reset: '<svg viewBox="0 0 24 24"><path d="M4 10a8 8 0 1 1 2 6"/><path d="M4 5v5h5"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M9 5v14M17 6l-8 6 8 6"/></svg>'
};

const SAMPLE_TAPE = '250000 Gaji utama\n+ 2,5jt Bonus projek\n- 150rb Belanja mingguan\n= Subtotal\n+ 11% PPN\n/ 2 Bagi 2 orang';

let _segMode = 'timer'; // preferensi segmen terakhir

export function renderFocus(user, onRefresh) {
  const main = document.getElementById('appMain');
  if (!main) return;
  const st = loadPomoState();
  startPomoTicker();

  const p = getPreset(st.preset, st.customWork, st.customBreak);
  const presetKeys = Object.keys(PRESETS).concat(['custom']);

  main.innerHTML = `
    <div class="fokus">
      <div class="seg" id="fokusSeg">
        <button id="segTimerBtn" class="${_segMode === 'timer' ? 'on' : ''}">${IC.timer}Timer</button>
        <button id="segTapeBtn" class="${_segMode === 'tape' ? 'on amb' : ''}">${IC.tape}Tape</button>
      </div>

      <!-- ===== SEGMENT: TIMER ===== -->
      <div id="segTimer" style="display:${_segMode === 'timer' ? '' : 'none'}">
        <div class="timerwrap">
          <div class="ringwrap">
            <svg viewBox="0 0 120 120">
              <circle class="ring-bg" cx="60" cy="60" r="54"/>
              <circle id="pomoRingFg" class="ring-fg${st.mode === 'focus' ? '' : ' brk'}" cx="60" cy="60" r="54"
                stroke-dasharray="339.292" stroke-dashoffset="0" transform="rotate(-90 60 60)"/>
            </svg>
            <div class="ringin">
              <div class="t sg" id="pomoTime">${formatMMSS(Math.max(0, st.remaining))}</div>
              <div class="m" id="pomoMode">${MODE_LABEL[st.mode] || 'FOKUS'}</div>
            </div>
          </div>
        </div>
        <div class="presets" id="pomoPresets">
          ${presetKeys.map(k => {
            const label = k === 'custom' ? ('Custom ' + p.work + '/' + p.break) : k;
            return '<span class="pch' + (st.preset === k ? ' on' : '') + '" data-preset="' + k + '">' + label + '</span>';
          }).join('')}
        </div>
        <div class="custom-row" id="pomoCustomRow" style="display:${st.preset === 'custom' ? '' : 'none'}">
          <label>Fokus <input type="number" id="cwInput" min="1" max="120" value="${st.customWork}">m</label>
          <label>Istirahat <input type="number" id="cbInput" min="1" max="30" value="${st.customBreak}">m</label>
          <button class="custom-apply" id="cwApply">Terapkan</button>
        </div>
        <div class="ctr">
          <button class="sm" id="pomoReset" title="Reset">${IC.reset}</button>
          <button class="big${st.mode === 'focus' ? '' : ' brk'}" id="pomoPlay" title="Mulai / Jeda">${
            st.running
              ? '<svg viewBox="0 0 24 24"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>'
              : '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>'
          }</button>
          <button class="sm" id="pomoSkip" title="Lewati ke mode berikutnya">${IC.skip}</button>
        </div>
        <div class="fmeta">
          <span>Siklus<b class="cyc" id="pomoCyc">${
            (() => { const n = st.cycles % 4; let h = ''; for (let i = 0; i < 4; i++) h += '<i class="' + (i < n ? 'on' : '') + '"></i>'; return h; })()
          }</b><span id="pomoCycLb">${st.cycles % 4}/4</span></span>
          <span>·</span>
          <span id="pomoPresetLb">${st.preset === 'custom' ? 'Custom' : st.preset}</span>
          <span>·</span>
          <button id="pomoBell" class="bellbtn">${st.soundOn ? 'Bell aktif' : 'Bell mati'}</button>
        </div>
      </div>

      <!-- ===== SEGMENT: TAPE ===== -->
      <div id="segTape" style="display:${_segMode === 'tape' ? '' : 'none'}">
        <div class="tapehead">
          <h2>RecallTape</h2>
          <button class="gh-dark" id="tapeNew" title="Pita baru (bersihkan)">${IC.clear}</button>
        </div>
        <div class="tape-edit">
          <textarea id="tapeInput" rows="6" spellcheck="false"
            placeholder="250000 Gaji utama&#10;+ 50k Bonus projek&#10;- 20rb Makan siang&#10;= Subtotal&#10;* 2 Pajak 2x"></textarea>
        </div>
        <div class="receipt" id="tapeReceipt"></div>
        <div class="tstatus" id="tapeStatus"><span class="tdot"></span><span id="tapeStatusTx">auto-format ala CalcTape — 50k / 2,5jt / +19% jalan semua</span></div>
        <div class="tacts">
          <button id="tapeCopy">${IC.copy}Copy</button>
          <button id="tapeSave">${IC.save}Vault</button>
          <button id="tapeSample">${IC.spark}Contoh</button>
          <button id="tapeClear">${IC.clear}Bersih</button>
        </div>
        <div class="tstatus" style="opacity:.55"><span class="tdot"></span>local-first · tersimpan otomatis di perangkat ini</div>
      </div>
    </div>
  `;

  // ---------- segmen ----------
  const segTimerBtn = document.getElementById('segTimerBtn');
  const segTapeBtn = document.getElementById('segTapeBtn');
  const segTimer = document.getElementById('segTimer');
  const segTape = document.getElementById('segTape');
  function setSeg(mode) {
    _segMode = mode;
    segTimerBtn.className = mode === 'timer' ? 'on' : '';
    segTapeBtn.className = mode === 'tape' ? 'on amb' : '';
    segTimer.style.display = mode === 'timer' ? '' : 'none';
    segTape.style.display = mode === 'tape' ? '' : 'none';
    if (mode === 'timer') updatePomoDom();
  }
  segTimerBtn.addEventListener('click', () => setSeg('timer'));
  segTapeBtn.addEventListener('click', () => setSeg('tape'));

  // ---------- pomodoro handlers ----------
  document.getElementById('pomoPlay').addEventListener('click', () => {
    ensureAudio();
    const s = loadPomoState();
    s.running = !s.running;
    savePomoState();
    updatePomoDom();
  });
  document.getElementById('pomoReset').addEventListener('click', () => {
    const s = loadPomoState();
    s.remaining = modeDuration(s);
    s.running = false;
    savePomoState();
    updatePomoDom();
  });
  document.getElementById('pomoSkip').addEventListener('click', () => {
    const s = loadPomoState();
    _pomoState = nextState(s);
    savePomoState();
    updatePomoDom();
  });
  document.getElementById('pomoBell').addEventListener('click', () => {
    const s = loadPomoState();
    s.soundOn = !s.soundOn;
    savePomoState();
    updatePomoDom();
  });
  document.querySelectorAll('#pomoPresets .pch').forEach(ch => {
    ch.addEventListener('click', () => {
      const key = ch.dataset.preset;
      const s = loadPomoState();
      s.preset = key;
      s.mode = 'focus';
      s.remaining = getPreset(key, s.customWork, s.customBreak).work * 60;
      s.running = false;
      savePomoState();
      // re-render preset chips + custom row tanpa rebuild seluruh view
      document.querySelectorAll('#pomoPresets .pch').forEach(c => {
        const k = c.dataset.preset;
        const pp = getPreset(k, s.customWork, s.customBreak);
        c.className = 'pch' + (s.preset === k ? ' on' : '');
        c.textContent = k === 'custom' ? ('Custom ' + pp.work + '/' + pp.break) : k;
      });
      document.getElementById('pomoCustomRow').style.display = key === 'custom' ? '' : 'none';
      const plb = document.getElementById('pomoPresetLb');
      if (plb) plb.textContent = key === 'custom' ? 'Custom' : key;
      updatePomoDom();
    });
  });
  const cwApply = document.getElementById('cwApply');
  if (cwApply) {
    cwApply.addEventListener('click', () => {
      const s = loadPomoState();
      s.customWork = parseInt(document.getElementById('cwInput').value) || 25;
      s.customBreak = parseInt(document.getElementById('cbInput').value) || 5;
      s.mode = 'focus';
      s.remaining = getPreset('custom', s.customWork, s.customBreak).work * 60;
      s.running = false;
      savePomoState();
      document.querySelectorAll('#pomoPresets .pch').forEach(c => {
        if (c.dataset.preset === 'custom') c.textContent = 'Custom ' + s.customWork + '/' + s.customBreak;
      });
      updatePomoDom();
    });
  }

  // ---------- tape ----------
  const tapeInput = document.getElementById('tapeInput');
  const receipt = document.getElementById('tapeReceipt');
  const statusTx = document.getElementById('tapeStatusTx');
  const statusWrap = document.getElementById('tapeStatus');
  tapeInput.value = loadSession();

  function renderTape() {
    const text = tapeInput.value;
    saveSession(text);
    const tape = evaluate(text);
    const rows = [];
    for (const e of tape.entries) {
      if (e.kind === 'comment') {
        rows.push('<div class="tl dim"><span>' + esc(e.note) + '</span><span></span></div>');
      } else if (e.kind === 'note') {
        rows.push('<div class="tl dim"><span>' + esc(e.note) + '</span><span></span></div>');
      } else if (e.kind === 'subtotal') {
        rows.push('<div class="tl sub"><span>= ' + esc(e.note || 'Subtotal') + '</span><span>' + formatNumber(e.display) + '</span></div>');
      } else {
        const sym = { '+': '+', '-': '−', '*': '×', '/': '÷' }[e.op] || '+';
        const amt = formatNumber(e.amount) + (e.isPercent ? '%' : '');
        const label = (e.note ? sym + ' ' + amt + ' ' + e.note : sym + ' ' + amt);
        rows.push('<div class="tl"><span>' + esc(label) + '</span><span>' + formatNumber(e.display) + '</span></div>');
      }
    }
    rows.push('<div class="tl res"><span>HASIL</span><span>' + formatNumber(tape.grandTotal) + '</span></div>');
    receipt.innerHTML = rows.join('');
    if (tape.error) {
      statusTx.textContent = tape.error;
      statusWrap.classList.add('err');
    } else {
      const nLines = tape.entries.filter(e => e.kind === 'op').length;
      statusTx.textContent = nLines
        ? ('auto-format ala CalcTape · ' + nLines + ' baris terhitung')
        : 'auto-format ala CalcTape — 50k / 2,5jt / +19% jalan semua';
      statusWrap.classList.remove('err');
    }
  }

  let _tapeDeb = null;
  tapeInput.addEventListener('input', () => {
    clearTimeout(_tapeDeb);
    _tapeDeb = setTimeout(renderTape, 180);
  });
  renderTape();

  document.getElementById('tapeCopy').addEventListener('click', async () => {
    const text = toPlainText(evaluate(tapeInput.value));
    try {
      await navigator.clipboard.writeText(text);
      statusTx.textContent = 'Pita disalin ke clipboard ✓';
    } catch (e) {
      statusTx.textContent = 'Gagal menyalin: ' + e.message;
    }
  });
  document.getElementById('tapeSave').addEventListener('click', async () => {
    if (!tapeInput.value.trim()) { statusTx.textContent = 'Pita masih kosong'; return; }
    const tape = evaluate(tapeInput.value);
    const btn = document.getElementById('tapeSave');
    btn.disabled = true;
    try {
      const d = new Date();
      const stamp = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' +
        d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      const result = await createFileItem(user, {
        title: 'Pita ' + stamp,
        body: toMarkdown(tape, { title: 'RecallTape ' + stamp }),
        tags: ['tape', 'md'],
        source: { kind: 'md', mime: 'text/markdown', fileName: 'pita-' + Date.now() + '.md', size: 0, uploadedFrom: 'pwa-tape', capturedAt: new Date().toISOString() }
      });
      if (result.ok) statusTx.textContent = 'Tersimpan ke Vault ✓ (tag: tape)';
      else statusTx.textContent = 'Gagal simpan: ' + (result.error || 'unknown');
    } catch (e) {
      statusTx.textContent = 'Gagal simpan: ' + e.message;
    }
    btn.disabled = false;
  });
  document.getElementById('tapeSample').addEventListener('click', () => {
    tapeInput.value = SAMPLE_TAPE;
    renderTape();
  });
  document.getElementById('tapeNew').addEventListener('click', confirmNewTape);
  document.getElementById('tapeClear').addEventListener('click', confirmNewTape);
  function confirmNewTape() {
    if (tapeInput.value.trim() && !confirm('Bersihkan pita? Teks saat ini akan hilang (sudah tersimpan? salin dulu).')) return;
    tapeInput.value = '';
    renderTape();
  }

  updatePomoDom();
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
