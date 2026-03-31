console.log('PATCH CARREGADO');
/**
 * AutoPostt Frontend Patch v1
 * 
 * Injetar no final do <body> do autopostt-app.html:
 * <script src="autopostt-patch-v1.js"></script>
 * 
 * Blocos implementados:
 * 1. Streaming SSE nos agentes (substitui runAgent com efeito de digitação)
 * 2. Calendário editorial completo (nova página + nav item)
 * 3. Onboarding v2 — step-by-step com save incremental
 * 4. Dashboard upgrades — KPIs reais, atividade real, quota visual
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────
  // BLOCO 1: STREAMING SSE NOS AGENTES
  // Override da função runAgent existente
  // ─────────────────────────────────────────────────────────

  /**
   * Substitui runAgent do app original com versão streaming SSE.
   * Mantém mesma assinatura (slug, tipo, rede) para compatibilidade total.
   * Fallback automático para endpoint não-streaming se SSE falhar.
   */
  window.runAgent = async function runAgentStreaming(slug, tipo, rede) {
    const inputEl = document.getElementById('ag-' + slug + '-in');
    const tomEl   = document.getElementById('ag-' + slug + '-tom');
    if (!inputEl) return;

    const input = inputEl.value.trim();
    if (!input) { window.toast?.('Descreva sua ideia antes de gerar'); return; }

    const tom = tomEl?.value || '';
    const emptyEl   = document.getElementById('ag-' + slug + '-empty');
    const skEl      = document.getElementById('ag-' + slug + '-sk');
    const outEl     = document.getElementById('ag-' + slug + '-out');
    const contentEl = document.getElementById('ag-' + slug + '-content');

    if (emptyEl)   emptyEl.style.display = 'none';
    if (outEl)     outEl.classList.remove('vis');
    if (skEl)      skEl.classList.add('vis');

    // Set streaming skeleton text (typing cursor)
    if (contentEl) {
      contentEl.innerHTML = '';
      contentEl.style.whiteSpace = 'pre-wrap';
    }

    try {
      const mediaFiles = (window._agentMedia?.[slug] || []).slice(0, 3);
      const _vmData    = localStorage.getItem('autopostt_visual_memory');
      const _vmNotes   = _vmData ? (JSON.parse(_vmData).notes || '') : '';

      const body = { agent: slug, input, tom, tipo, rede, visualMemoryNotes: _vmNotes };
      if (mediaFiles.length) body.mediaFiles = mediaFiles;

      // Try streaming first
      const streamOk = await _tryStreamAgent(slug, body, skEl, outEl, contentEl);

      if (!streamOk) {
        // Fallback: non-streaming
        const BASE = window.API_BASE || '';
        const token = localStorage.getItem('gerai_token') || window.token || '';
        const res = await fetch(BASE + '/api/user/generate-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Erro na geração');
        if (skEl)      skEl.classList.remove('vis');
        if (contentEl) contentEl.textContent = data.content;
        if (outEl)     outEl.classList.add('vis');
        window.toast?.('Conteúdo gerado!', 'ok');
        if (window.me) { window.me.quota_used = (window.me.quota_used || 0) + 1; window.updateQuota?.(); }
      }

    } catch (e) {
      if (skEl)    skEl.classList.remove('vis');
      if (emptyEl) emptyEl.style.display = 'flex';
      window.toast?.(e.message, 'err');
    }
  };

  async function _tryStreamAgent(slug, body, skEl, outEl, contentEl) {
    return new Promise((resolve) => {
      try {
        const BASE  = window.API_BASE || '';
        const token = localStorage.getItem('gerai_token') || window.token || '';
        const ctrl  = new AbortController();
        const timeout = setTimeout(() => { ctrl.abort(); resolve(false); }, 30000);

        fetch(BASE + '/api/user/generate-content-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify(body),
          signal: ctrl.signal
        }).then(res => {
          if (!res.ok || !res.body) { clearTimeout(timeout); resolve(false); return; }

          clearTimeout(timeout);

          // Show output area immediately for streaming
          if (skEl)  skEl.classList.remove('vis');
          if (outEl) outEl.classList.add('vis');
          if (contentEl) { contentEl.textContent = ''; contentEl.innerHTML = '<span class="stream-cursor"></span>'; }

          const reader = res.body.getReader();
          const dec    = new TextDecoder();
          let buffer   = '';
          let fullText = '';

          function pump() {
            reader.read().then(({ done, value }) => {
              if (done) {
                // Final cleanup: remove cursor, apply markdown-style formatting
                if (contentEl) {
                  contentEl.innerHTML = _formatAgentOutput(fullText);
                }
                if (window.me) { window.me.quota_used = (window.me.quota_used || 0) + 1; window.updateQuota?.(); }
                window.toast?.('Conteúdo gerado!', 'ok');
                resolve(true);
                return;
              }

              buffer += dec.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop(); // incomplete line stays in buffer

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                  const evt = JSON.parse(line.slice(6));
                  if (evt.type === 'start') {
                    // Already showing output
                  } else if (evt.type === 'delta') {
                    fullText += evt.text;
                    // Incremental render with cursor
                    if (contentEl) {
                      contentEl.innerHTML = _formatAgentOutput(fullText) + '<span class="stream-cursor"></span>';
                      // Auto-scroll
                      const panel = contentEl.closest('.agent-out-panel, .agent-result');
                      if (panel) panel.scrollTop = panel.scrollHeight;
                    }
                  } else if (evt.type === 'error') {
                    resolve(false);
                  }
                } catch { /* skip malformed line */ }
              }

              pump();
            }).catch(() => resolve(false));
          }

          pump();
        }).catch(() => { clearTimeout(timeout); resolve(false); });

      } catch { resolve(false); }
    });
  }

  /**
   * Formata a saída do agente: negrito, seções, emojis
   */
  function _formatAgentOutput(text) {
    if (!text) return '';
    // Escape HTML first
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Bold: **texto** ou ━━ SEÇÃO ━━
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(━+\s*[A-ZÁÉÍÓÚÀÂÊÔÃÕÜÇÑ][^\n]*━*)/g, '<strong style="color:var(--a,#F5C518)">$1</strong>');
    // Line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  // Inject streaming cursor CSS
  _injectStreamCSS();

  function _injectStreamCSS() {
    if (document.getElementById('ap-stream-css')) return;
    const style = document.createElement('style');
    style.id = 'ap-stream-css';
    style.textContent = `
      .stream-cursor {
        display: inline-block;
        width: 2px;
        height: 1em;
        background: var(--a, #F5C518);
        margin-left: 1px;
        vertical-align: text-bottom;
        animation: stream-blink 0.7s step-end infinite;
        border-radius: 1px;
      }
      @keyframes stream-blink {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0; }
      }

      /* ── CALENDAR PAGE ── */
      .cal-pg { padding: 28px 32px; }
      .cal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
      .cal-header-left h2 { font-size: 18px; font-weight: 700; letter-spacing: -.4px; }
      .cal-header-left p  { font-size: 12px; color: var(--t2); margin-top: 2px; }

      .cal-stats { display: flex; gap: 10px; margin-bottom: 24px; }
      .cal-stat {
        flex: 1; background: var(--bg2); border: 1px solid var(--b1);
        border-radius: var(--r2); padding: 14px 16px;
      }
      .cal-stat-n { font-size: 22px; font-weight: 700; letter-spacing: -1px; }
      .cal-stat-l { font-size: 10px; color: var(--t2); text-transform: uppercase; letter-spacing: .08em; margin-top: 4px; }

      .cal-month-nav {
        display: flex; align-items: center; gap: 12px; margin-bottom: 20px;
      }
      .cal-month-nav-btn {
        width: 32px; height: 32px; border-radius: var(--r);
        background: var(--bg3); border: 1px solid var(--b1);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        color: var(--t1); transition: all .12s; font-family: var(--f);
      }
      .cal-month-nav-btn:hover { border-color: var(--b2); color: var(--t0); }
      .cal-month-title { font-size: 15px; font-weight: 700; letter-spacing: -.3px; min-width: 180px; }

      .cal-grid {
        display: grid; grid-template-columns: repeat(7, 1fr);
        border: 1px solid var(--b1); border-radius: var(--r3);
        overflow: hidden; background: var(--b1); gap: 1px;
      }
      .cal-day-header {
        background: var(--bg2); padding: 8px 4px; text-align: center;
        font-size: 10px; font-weight: 700; color: var(--t2);
        text-transform: uppercase; letter-spacing: .08em;
      }
      .cal-day {
        background: var(--bg1); min-height: 90px; padding: 8px;
        cursor: pointer; transition: background .1s; position: relative;
      }
      .cal-day:hover { background: var(--bg2); }
      .cal-day.today { background: var(--adim); }
      .cal-day.today .cal-day-n { color: var(--a); font-weight: 700; }
      .cal-day.other-month { background: var(--bg2); opacity: .5; }
      .cal-day-n { font-size: 11px; font-weight: 500; color: var(--t2); margin-bottom: 4px; }
      .cal-post-chip {
        display: block; font-size: 10px; font-weight: 600;
        padding: 2px 6px; border-radius: 3px; margin-bottom: 2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        cursor: pointer; transition: opacity .1s;
      }
      .cal-post-chip:hover { opacity: .8; }
      .cal-post-chip.status-idea    { background: rgba(245,197,24,.12); color: #F5C518; }
      .cal-post-chip.status-draft   { background: rgba(75,120,255,.12); color: #7599FF; }
      .cal-post-chip.status-ready   { background: rgba(34,211,122,.12); color: #22D37A; }
      .cal-post-chip.status-published { background: rgba(255,255,255,.06); color: var(--t2); }
      .cal-day-add {
        position: absolute; bottom: 4px; right: 4px;
        width: 18px; height: 18px; border-radius: 3px;
        background: var(--b1); border: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        color: var(--t3); font-size: 14px; opacity: 0;
        transition: all .12s; font-family: var(--f); line-height: 1;
      }
      .cal-day:hover .cal-day-add { opacity: 1; }
      .cal-day-add:hover { background: var(--adim); color: var(--a); }

      /* POST MODAL */
      .cal-modal-bg {
        position: fixed; inset: 0; background: rgba(0,0,0,.6);
        backdrop-filter: blur(4px); z-index: 1000;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none; transition: opacity .2s;
      }
      .cal-modal-bg.open { opacity: 1; pointer-events: all; }
      .cal-modal {
        background: var(--bg1); border: 1px solid var(--b2);
        border-radius: var(--r4); width: 100%; max-width: 480px;
        padding: 28px; box-shadow: 0 24px 80px rgba(0,0,0,.5);
        transform: translateY(8px); transition: transform .2s;
      }
      .cal-modal-bg.open .cal-modal { transform: translateY(0); }
      .cal-modal-hd {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 20px;
      }
      .cal-modal-title { font-size: 15px; font-weight: 700; letter-spacing: -.3px; }
      .cal-modal-x {
        width: 28px; height: 28px; border-radius: var(--r);
        background: var(--bg3); border: 1px solid var(--b1);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        color: var(--t2); font-size: 16px; font-family: var(--f);
        transition: all .1s;
      }
      .cal-modal-x:hover { background: var(--bg2); color: var(--t0); border-color: var(--b2); }

      .cal-modal .form-row { margin-bottom: 14px; }
      .cal-modal .form-row label { font-size: 11px; font-weight: 700; color: var(--t2); text-transform: uppercase; letter-spacing: .07em; display: block; margin-bottom: 6px; }
      .cal-modal .form-row input,
      .cal-modal .form-row select,
      .cal-modal .form-row textarea {
        width: 100%; background: var(--bg3); border: 1px solid var(--b1);
        border-radius: var(--r2); padding: 10px 12px;
        font-size: 13px; color: var(--t0); font-family: var(--f);
        transition: border-color .1s; outline: none; resize: vertical;
      }
      .cal-modal .form-row input:focus,
      .cal-modal .form-row select:focus,
      .cal-modal .form-row textarea:focus { border-color: var(--a); }

      .cal-status-row { display: flex; gap: 6px; margin-bottom: 14px; }
      .cal-status-chip {
        flex: 1; padding: 7px 4px; border-radius: var(--r);
        border: 1px solid var(--b1); background: var(--bg3);
        font-size: 11px; font-weight: 600; text-align: center;
        cursor: pointer; transition: all .1s; color: var(--t2);
      }
      .cal-status-chip:hover { border-color: var(--b2); }
      .cal-status-chip.on.s-idea     { background: rgba(245,197,24,.12); border-color: rgba(245,197,24,.3); color: #F5C518; }
      .cal-status-chip.on.s-draft    { background: rgba(75,120,255,.12); border-color: rgba(75,120,255,.3); color: #7599FF; }
      .cal-status-chip.on.s-ready    { background: rgba(34,211,122,.12); border-color: rgba(34,211,122,.3); color: #22D37A; }
      .cal-status-chip.on.s-published { background: rgba(255,255,255,.06); border-color: var(--b2); color: var(--t1); }

      .cal-modal-footer { display: flex; gap: 8px; margin-top: 20px; }
      .cal-modal-footer .btn { flex: 1; }
      .cal-del-btn {
        width: 36px; flex-shrink: 0; background: rgba(255,68,68,.1);
        border: 1px solid rgba(255,68,68,.2); border-radius: var(--r2);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        color: var(--red, #FF4444); transition: all .1s; font-family: var(--f);
      }
      .cal-del-btn:hover { background: rgba(255,68,68,.2); }

      /* LIST VIEW */
      .cal-list-item {
        display: flex; align-items: flex-start; gap: 12px;
        padding: 12px; border-radius: var(--r2); border: 1px solid var(--b1);
        background: var(--bg2); margin-bottom: 8px; cursor: pointer;
        transition: border-color .12s;
      }
      .cal-list-item:hover { border-color: var(--b2); }
      .cal-list-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; }
      .cal-list-meta { font-size: 11px; color: var(--t2); margin-top: 3px; }
      .cal-list-network { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
      .cal-empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; text-align: center; gap: 10px; }
      .cal-empty-state svg { color: var(--t3); }
      .cal-empty-state p { font-size: 12px; color: var(--t2); max-width: 200px; line-height: 1.55; }

      /* VIEW TOGGLE */
      .cal-view-toggle {
        display: flex; gap: 1px; background: var(--bg3); border: 1px solid var(--b1);
        border-radius: var(--r2); padding: 3px;
      }
      .cal-view-btn {
        padding: 5px 12px; border-radius: var(--r); font-size: 11px; font-weight: 600;
        color: var(--t2); cursor: pointer; transition: all .1s;
        background: none; border: none; font-family: var(--f);
      }
      .cal-view-btn.on { background: var(--bg2); color: var(--t0); box-shadow: 0 1px 4px rgba(0,0,0,.2); }

      /* ONBOARDING v2 */
      .ob2-wrap {
        width: 100%; max-width: 520px; margin: 0 auto;
        padding: 0 20px;
      }
      .ob2-progress {
        height: 2px; background: var(--b1); border-radius: 1px; margin-bottom: 40px;
      }
      .ob2-progress-fill {
        height: 100%; background: var(--a); border-radius: 1px;
        transition: width .4s var(--ease-out);
      }
      .ob2-step { display: none; animation: ob2-in .25s var(--ease-out); }
      .ob2-step.on { display: block; }
      @keyframes ob2-in {
        from { opacity: 0; transform: translateX(16px); }
        to   { opacity: 1; transform: translateX(0); }
      }
      .ob2-eyebrow {
        font-size: 10px; font-weight: 700; color: var(--a);
        text-transform: uppercase; letter-spacing: .12em; margin-bottom: 10px;
      }
      .ob2-title { font-size: 24px; font-weight: 700; letter-spacing: -.5px; margin-bottom: 8px; }
      .ob2-sub   { font-size: 13px; color: var(--t1); line-height: 1.65; margin-bottom: 28px; }
      .ob2-options { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
      .ob2-option {
        display: flex; align-items: center; gap: 14px; padding: 14px 16px;
        background: var(--bg2); border: 1px solid var(--b1); border-radius: var(--r3);
        cursor: pointer; transition: all .12s;
      }
      .ob2-option:hover { border-color: var(--b2); background: var(--bg3); }
      .ob2-option.on { border-color: rgba(245,197,24,.35); background: var(--adim); }
      .ob2-option.on .ob2-opt-name { color: var(--a); }
      .ob2-opt-ico {
        width: 36px; height: 36px; border-radius: var(--r2);
        background: var(--bg3); display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; font-size: 18px;
      }
      .ob2-option.on .ob2-opt-ico { background: var(--adim2); }
      .ob2-opt-name { font-size: 13px; font-weight: 600; }
      .ob2-opt-desc { font-size: 11px; color: var(--t2); margin-top: 1px; }
      .ob2-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
      .ob2-chip {
        padding: 7px 16px; border-radius: 100px;
        background: var(--bg2); border: 1px solid var(--b1);
        font-size: 12px; font-weight: 500; color: var(--t1);
        cursor: pointer; transition: all .12s; user-select: none;
      }
      .ob2-chip:hover { border-color: var(--b2); color: var(--t0); }
      .ob2-chip.on { background: var(--adim); border-color: rgba(245,197,24,.3); color: var(--a); font-weight: 600; }
      .ob2-input-row { margin-bottom: 20px; }
      .ob2-input-row label { font-size: 11px; font-weight: 700; color: var(--t2); text-transform: uppercase; letter-spacing: .07em; display: block; margin-bottom: 6px; }
      .ob2-input-row input, .ob2-input-row textarea {
        width: 100%; background: var(--bg2); border: 1px solid var(--b1);
        border-radius: var(--r2); padding: 12px 14px;
        font-size: 13px; color: var(--t0); font-family: var(--f);
        outline: none; resize: none; transition: border-color .1s;
      }
      .ob2-input-row input:focus, .ob2-input-row textarea:focus { border-color: var(--a); }
      .ob2-colors { display: flex; gap: 10px; margin-bottom: 24px; }
      .ob2-color-item { flex: 1; }
      .ob2-color-item label { font-size: 10px; font-weight: 700; color: var(--t2); text-transform: uppercase; letter-spacing: .07em; display: block; margin-bottom: 6px; }
      .ob2-color-swatch {
        height: 44px; border-radius: var(--r2); border: 1px solid var(--b2);
        cursor: pointer; position: relative; overflow: hidden;
      }
      .ob2-color-swatch input[type="color"] {
        position: absolute; inset: -4px; width: calc(100% + 8px); height: calc(100% + 8px);
        border: none; cursor: pointer; opacity: 0; padding: 0;
      }
      .ob2-color-fill { position: absolute; inset: 0; pointer-events: none; }
      .ob2-color-hex { font-size: 10px; color: var(--t2); font-family: monospace; margin-top: 4px; text-align: center; }
      .ob2-nav { display: flex; gap: 8px; }
      .ob2-nav .btn { flex: 1; padding: 13px; font-size: 13px; font-weight: 700; }
      .ob2-nav .btn-back {
        width: 44px; flex: 0 0 44px; background: var(--bg3);
        border: 1px solid var(--b1); border-radius: var(--r2);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        color: var(--t1); transition: all .1s; font-family: var(--f);
      }
      .ob2-nav .btn-back:hover { border-color: var(--b2); color: var(--t0); }
      .ob2-skip { text-align: center; margin-top: 14px; font-size: 12px; color: var(--t3); }
      .ob2-skip a { color: var(--t2); cursor: pointer; text-decoration: underline; }
      .ob2-skip a:hover { color: var(--t1); }

      /* Saving indicator */
      .ob2-saving {
        display: none; align-items: center; gap: 6px;
        font-size: 11px; color: var(--a); margin-bottom: 10px;
      }
      .ob2-saving.on { display: flex; }
      .ob2-saving-dot {
        width: 6px; height: 6px; border-radius: 50%; background: var(--a);
        animation: ob2-pulse 1.2s ease-in-out infinite;
      }
      @keyframes ob2-pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
    `;
    document.head.appendChild(style);
  }


  // ─────────────────────────────────────────────────────────
  // BLOCO 2: CALENDÁRIO EDITORIAL
  // Injeta nova página + nav item + modal
  // ─────────────────────────────────────────────────────────

  function _injectCalendar() {
    // 1. Nav item
    const sbSect = document.querySelector('.sb-sect');
    if (sbSect && !document.getElementById('ni-calendar')) {
      const calNav = document.createElement('div');
      calNav.className = 'ni';
      calNav.id = 'ni-calendar';
      calNav.setAttribute('onclick', "nav('calendar',this)");
      calNav.innerHTML = `
        <span class="ni-ico">
          <svg class="ico ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
        </span>
        Calendário
        <span class="ni-badge"><span class="badge bdg-a" style="font-size:9px;padding:1px 6px">Novo</span></span>
      `;
      // Insert after "Histórico" nav item
      const histNav = [...document.querySelectorAll('.ni')].find(n => n.textContent.trim().includes('Histórico'));
      if (histNav && histNav.nextSibling) {
        histNav.parentNode.insertBefore(calNav, histNav.nextSibling);
      } else {
        sbSect.appendChild(calNav);
      }
    }

    // 2. Page container
    if (!document.getElementById('pg-calendar')) {
      const main = document.querySelector('.main');
      if (!main) return;

      const page = document.createElement('div');
      page.className = 'pg cal-pg';
      page.id = 'pg-calendar';
      page.innerHTML = `
        <div class="cal-header">
          <div class="cal-header-left">
            <h2>Calendário Editorial</h2>
            <p>Planeje, organize e acompanhe seus conteúdos</p>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <div class="cal-view-toggle">
              <button class="cal-view-btn on" id="cal-view-month" onclick="calSetView('month')">Mês</button>
              <button class="cal-view-btn" id="cal-view-list"  onclick="calSetView('list')">Lista</button>
            </div>
            <button class="btn btn-p btn-sm" onclick="calOpenNew()">
              <svg style="width:13px;height:13px;fill:none;stroke:#fff;stroke-width:2.5" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Novo post
            </button>
          </div>
        </div>

        <!-- Stats -->
        <div class="cal-stats" id="cal-stats-row">
          <div class="cal-stat"><div class="cal-stat-n" id="cs-total">—</div><div class="cal-stat-l">Total</div></div>
          <div class="cal-stat"><div class="cal-stat-n" style="color:#F5C518" id="cs-idea">—</div><div class="cal-stat-l">Ideias</div></div>
          <div class="cal-stat"><div class="cal-stat-n" style="color:#7599FF" id="cs-draft">—</div><div class="cal-stat-l">Rascunhos</div></div>
          <div class="cal-stat"><div class="cal-stat-n" style="color:#22D37A" id="cs-ready">—</div><div class="cal-stat-l">Prontos</div></div>
          <div class="cal-stat"><div class="cal-stat-n" style="color:var(--t2)" id="cs-pub">—</div><div class="cal-stat-l">Publicados</div></div>
        </div>

        <!-- Month nav -->
        <div class="cal-month-nav">
          <button class="cal-month-nav-btn" onclick="calPrevMonth()" aria-label="Mês anterior">
            <svg style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.5" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="cal-month-title" id="cal-month-title">—</div>
          <button class="cal-month-nav-btn" onclick="calNextMonth()" aria-label="Próximo mês">
            <svg style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.5" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
          <button class="btn btn-g btn-sm" onclick="calGoToday()" style="margin-left:4px">Hoje</button>
        </div>

        <!-- Calendar grid (month view) -->
        <div id="cal-month-view">
          <div class="cal-grid" id="cal-grid">
            <div class="cal-day-header">Dom</div>
            <div class="cal-day-header">Seg</div>
            <div class="cal-day-header">Ter</div>
            <div class="cal-day-header">Qua</div>
            <div class="cal-day-header">Qui</div>
            <div class="cal-day-header">Sex</div>
            <div class="cal-day-header">Sáb</div>
            <div id="cal-grid-days"></div>
          </div>
        </div>

        <!-- List view -->
        <div id="cal-list-view" style="display:none">
          <div id="cal-list-items"></div>
        </div>
      `;

      // Insert before first .pg
      const firstPg = main.querySelector('.pg');
      if (firstPg) main.insertBefore(page, firstPg);
      else main.appendChild(page);
    }

    // 3. Modal
    if (!document.getElementById('cal-modal-bg')) {
      const modal = document.createElement('div');
      modal.className = 'cal-modal-bg';
      modal.id = 'cal-modal-bg';
      modal.innerHTML = `
        <div class="cal-modal" id="cal-modal">
          <div class="cal-modal-hd">
            <div class="cal-modal-title" id="cal-modal-title">Novo post</div>
            <button class="cal-modal-x" onclick="calCloseModal()">×</button>
          </div>

          <div class="ob2-saving" id="cal-saving">
            <div class="ob2-saving-dot"></div> Salvando...
          </div>

          <div class="form-row">
            <label>Título</label>
            <input type="text" id="cal-f-title" placeholder="Nome do post ou ideia..." maxlength="100">
          </div>

          <div class="form-row">
            <label>Conteúdo / Copy</label>
            <textarea id="cal-f-content" rows="4" placeholder="Cole aqui o texto gerado ou escreva manualmente..."></textarea>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-row">
              <label>Formato</label>
              <select id="cal-f-format">
                <option value="post">Post único</option>
                <option value="carrossel">Carrossel</option>
                <option value="reels">Reels</option>
                <option value="story">Story</option>
                <option value="anuncio">Anúncio</option>
                <option value="thumb">Thumbnail</option>
              </select>
            </div>
            <div class="form-row">
              <label>Rede social</label>
              <select id="cal-f-network">
                <option value="instagram">Instagram</option>
                <option value="linkedin">LinkedIn</option>
                <option value="youtube">YouTube</option>
                <option value="tiktok">TikTok</option>
                <option value="facebook">Facebook</option>
              </select>
            </div>
          </div>

          <div class="form-row">
            <label>Data de publicação</label>
            <input type="date" id="cal-f-date">
          </div>

          <div class="form-row">
            <label>Status</label>
            <div class="cal-status-row">
              <div class="cal-status-chip on s-idea"    onclick="calSetStatus(this,'idea')"    >Ideia</div>
              <div class="cal-status-chip s-draft"      onclick="calSetStatus(this,'draft')"   >Rascunho</div>
              <div class="cal-status-chip s-ready"      onclick="calSetStatus(this,'ready')"   >Pronto</div>
              <div class="cal-status-chip s-published"  onclick="calSetStatus(this,'published')">Publicado</div>
            </div>
          </div>

          <div class="cal-modal-footer">
            <button class="cal-del-btn" id="cal-del-btn" onclick="calDeletePost()" style="display:none" title="Excluir">
              <svg style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
            <button class="btn btn-g btn-sm" style="flex:1" onclick="calCloseModal()">Cancelar</button>
            <button class="btn btn-p btn-sm" style="flex:2" onclick="calSavePost()">Salvar</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) calCloseModal(); });
    }
  }

  // Calendar state
  let _calYear   = new Date().getFullYear();
  let _calMonth  = new Date().getMonth() + 1;
  let _calPosts  = [];
  let _calEditing = null;
  let _calStatus = 'idea';
  let _calView   = 'month';
  const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const STATUS_COLOR = { idea:'#F5C518', draft:'#7599FF', ready:'#22D37A', published:'#888' };

  window.calSetView = function(v) {
    _calView = v;
    document.getElementById('cal-month-view').style.display = v === 'month' ? 'block' : 'none';
    document.getElementById('cal-list-view').style.display  = v === 'list'  ? 'block' : 'none';
    document.getElementById('cal-view-month').classList.toggle('on', v === 'month');
    document.getElementById('cal-view-list').classList.toggle('on',  v === 'list');
    if (v === 'list') _renderCalList();
  };

  window.calPrevMonth = function() {
    if (_calMonth === 1) { _calMonth = 12; _calYear--; } else _calMonth--;
    loadCalendar();
  };
  window.calNextMonth = function() {
    if (_calMonth === 12) { _calMonth = 1; _calYear++; } else _calMonth++;
    loadCalendar();
  };
  window.calGoToday = function() {
    const now = new Date();
    _calYear = now.getFullYear(); _calMonth = now.getMonth() + 1;
    loadCalendar();
  };

  window.loadCalendar = async function() {
    const titleEl = document.getElementById('cal-month-title');
    if (titleEl) titleEl.textContent = MONTHS_PT[_calMonth - 1] + ' ' + _calYear;
    try {
      const BASE = window.API_BASE || '';
      const token = localStorage.getItem('gerai_token') || window.token || '';
      const res = await fetch(`${BASE}/api/user/calendar?month=${_calMonth}&year=${_calYear}`, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const data = await res.json();
      if (data.ok) {
        _calPosts = data.posts || [];
        _updateCalStats(data.stats || {});
        _renderCalGrid();
        if (_calView === 'list') _renderCalList();
      }
    } catch (e) {
      // Offline: render empty grid
      _calPosts = [];
      _renderCalGrid();
    }
  };

  function _updateCalStats(stats) {
    const s = el => document.getElementById(el);
    if (s('cs-total')) s('cs-total').textContent = stats.total || 0;
    if (s('cs-idea'))  s('cs-idea').textContent  = stats.idea  || 0;
    if (s('cs-draft')) s('cs-draft').textContent = stats.draft || 0;
    if (s('cs-ready')) s('cs-ready').textContent = stats.ready || 0;
    if (s('cs-pub'))   s('cs-pub').textContent   = stats.published || 0;
  }

  function _renderCalGrid() {
    const container = document.getElementById('cal-grid-days');
    const gridEl    = document.getElementById('cal-grid');
    if (!container || !gridEl) return;

    const firstDay = new Date(_calYear, _calMonth - 1, 1).getDay();
    const daysInMonth = new Date(_calYear, _calMonth, 0).getDate();
    const prevMonthDays = new Date(_calYear, _calMonth - 1, 0).getDate();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

    const postsByDate = {};
    for (const p of _calPosts) {
      if (!p.scheduled_at) continue;
      const d = p.scheduled_at.slice(0, 10);
      if (!postsByDate[d]) postsByDate[d] = [];
      postsByDate[d].push(p);
    }

    const cells = [];
    // Prev month
    for (let i = firstDay - 1; i >= 0; i--) {
      cells.push({ day: prevMonthDays - i, cur: false });
    }
    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${_calYear}-${String(_calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      cells.push({ day: d, cur: true, dateStr, posts: postsByDate[dateStr] || [] });
    }
    // Next month filler (complete 6 rows)
    let nextDay = 1;
    while (cells.length % 7 !== 0) {
      cells.push({ day: nextDay++, cur: false });
    }

    container.style.cssText = 'display:contents';
    container.innerHTML = cells.map(c => {
      const isToday = c.cur && c.dateStr === todayStr;
      const cls = ['cal-day', !c.cur ? 'other-month' : '', isToday ? 'today' : ''].filter(Boolean).join(' ');
      const chips = (c.posts || []).slice(0, 3).map(p =>
        `<span class="cal-post-chip status-${p.status}" onclick="calEditPost('${p.id}');event.stopPropagation()" title="${_esc(p.title)}">${_esc(p.title)}</span>`
      ).join('');
      const more = (c.posts || []).length > 3 ? `<span style="font-size:9px;color:var(--t3);padding:2px 6px">+${c.posts.length - 3} mais</span>` : '';
      const addBtn = c.cur ? `<button class="cal-day-add" onclick="calOpenNew('${c.dateStr}');event.stopPropagation()" title="Adicionar post">+</button>` : '';
      return `<div class="${cls}" onclick="${c.cur ? `calOpenNew('${c.dateStr}')` : ''}">
        <div class="cal-day-n">${c.day}</div>
        ${chips}${more}${addBtn}
      </div>`;
    }).join('');

    // Re-insert day headers + days into grid
    const headers = [...gridEl.querySelectorAll('.cal-day-header')];
    gridEl.innerHTML = '';
    headers.forEach(h => gridEl.appendChild(h));
    gridEl.appendChild(container);
  }

  function _renderCalList() {
    const el = document.getElementById('cal-list-items');
    if (!el) return;
    if (!_calPosts.length) {
      el.innerHTML = `<div class="cal-empty-state">
        <svg style="width:32px;height:32px;fill:none;stroke:currentColor;stroke-width:1.5" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <p>Nenhum post planejado para este mês.<br>Clique em "Novo post" para começar.</p>
      </div>`;
      return;
    }
    const sorted = [..._calPosts].sort((a, b) => {
      if (!a.scheduled_at) return 1;
      if (!b.scheduled_at) return -1;
      return a.scheduled_at.localeCompare(b.scheduled_at);
    });
    el.innerHTML = sorted.map(p => {
      const color = STATUS_COLOR[p.status] || '#888';
      const date = p.scheduled_at ? new Date(p.scheduled_at + 'T00:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'short'}) : 'Sem data';
      return `<div class="cal-list-item" onclick="calEditPost('${p.id}')">
        <div class="cal-list-dot" style="background:${color}"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(p.title)}</div>
          <div class="cal-list-meta">${date} · <span class="cal-list-network">${p.network || '—'}</span> · ${p.format || 'post'}</div>
        </div>
        <span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:3px;background:${color}22;color:${color}">${p.status}</span>
      </div>`;
    }).join('');
  }

  window.calOpenNew = function(dateStr) {
    _calEditing = null;
    _calStatus = 'idea';
    document.getElementById('cal-modal-title').textContent = 'Novo post';
    document.getElementById('cal-f-title').value    = '';
    document.getElementById('cal-f-content').value  = '';
    document.getElementById('cal-f-format').value   = 'post';
    document.getElementById('cal-f-network').value  = 'instagram';
    document.getElementById('cal-f-date').value     = dateStr || '';
    document.getElementById('cal-del-btn').style.display = 'none';
    _calSetStatusUI('idea');
    document.getElementById('cal-modal-bg').classList.add('open');
    setTimeout(() => document.getElementById('cal-f-title').focus(), 100);
  };

  window.calEditPost = function(id) {
    const post = _calPosts.find(p => p.id === id);
    if (!post) return;
    _calEditing = post;
    _calStatus  = post.status || 'idea';
    document.getElementById('cal-modal-title').textContent = 'Editar post';
    document.getElementById('cal-f-title').value   = post.title || '';
    document.getElementById('cal-f-content').value = post.content || '';
    document.getElementById('cal-f-format').value  = post.format || 'post';
    document.getElementById('cal-f-network').value = post.network || 'instagram';
    document.getElementById('cal-f-date').value    = post.scheduled_at?.slice(0,10) || '';
    document.getElementById('cal-del-btn').style.display = 'flex';
    _calSetStatusUI(post.status || 'idea');
    document.getElementById('cal-modal-bg').classList.add('open');
  };

  window.calCloseModal = function() {
    document.getElementById('cal-modal-bg').classList.remove('open');
    _calEditing = null;
  };

  window.calSetStatus = function(el, status) {
    _calStatus = status;
    _calSetStatusUI(status);
  };

  function _calSetStatusUI(status) {
    document.querySelectorAll('.cal-status-chip').forEach(c => c.classList.remove('on'));
    const active = document.querySelector(`.cal-status-chip.s-${status}`);
    if (active) active.classList.add('on');
  }

  window.calSavePost = async function() {
    const title   = document.getElementById('cal-f-title').value.trim();
    const content = document.getElementById('cal-f-content').value.trim();
    const format  = document.getElementById('cal-f-format').value;
    const network = document.getElementById('cal-f-network').value;
    const dateVal = document.getElementById('cal-f-date').value;

    if (!title) { window.toast?.('Título obrigatório', 'err'); return; }

    const savingEl = document.getElementById('cal-saving');
    if (savingEl) savingEl.classList.add('on');

    const payload = { title, content, format, network, status: _calStatus, scheduled_at: dateVal || null };
    const BASE  = window.API_BASE || '';
    const token = localStorage.getItem('gerai_token') || window.token || '';

    try {
      let res;
      if (_calEditing) {
        res = await fetch(`${BASE}/api/user/calendar/${_calEditing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
          body: JSON.stringify(payload)
        });
      } else {
        res = await fetch(`${BASE}/api/user/calendar`, {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
          body: JSON.stringify(payload)
        });
      }
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Erro ao salvar');
      window.toast?.(_calEditing ? 'Post atualizado!' : 'Post criado!', 'ok');
      calCloseModal();
      loadCalendar();
    } catch (e) {
      window.toast?.(e.message, 'err');
    } finally {
      if (savingEl) savingEl.classList.remove('on');
    }
  };

  window.calDeletePost = async function() {
    if (!_calEditing) return;
    if (!confirm(`Excluir "${_calEditing.title}"?`)) return;
    const BASE  = window.API_BASE || '';
    const token = localStorage.getItem('gerai_token') || window.token || '';
    try {
      const res  = await fetch(`${BASE}/api/user/calendar/${_calEditing.id}`, {
        method: 'DELETE',
        headers: { 'Authorization':'Bearer '+token }
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Erro ao excluir');
      window.toast?.('Post excluído', 'ok');
      calCloseModal();
      loadCalendar();
    } catch (e) { window.toast?.(e.message, 'err'); }
  };


  // ─────────────────────────────────────────────────────────
  // BLOCO 3: ONBOARDING v2
  // Reescreve o HTML do sc-onboard com nova UX step-by-step
  // Salva progresso incremental via /api/user/onboard-step
  // ─────────────────────────────────────────────────────────

  function _injectOnboardingV2() {
    const ob = document.getElementById('sc-onboard');
    if (!ob || ob.dataset.v2) return;
    ob.dataset.v2 = '1';

    ob.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:40px 20px">
        <div class="ob2-wrap">
          <div class="ob2-progress"><div class="ob2-progress-fill" id="ob2-fill" style="width:14%"></div></div>

          <!-- STEP 1: Profissão -->
          <div class="ob2-step on" id="ob2-s1">
            <div class="ob2-eyebrow">Passo 1 de 7</div>
            <h1 class="ob2-title">Qual é sua profissão?</h1>
            <p class="ob2-sub">A IA vai calibrar o tom, linguagem e abordagem de conteúdo com base no que você faz.</p>
            <div class="ob2-options" id="ob2-prof-options">
              <div class="ob2-option on" data-v="Empreendedor / Empresário" onclick="ob2Pick(this,'ob2-prof-options','ob2-prof')">
                <div class="ob2-opt-ico">🏢</div><div><div class="ob2-opt-name">Empreendedor / Empresário</div><div class="ob2-opt-desc">Dono de negócio, startup, empresa</div></div>
              </div>
              <div class="ob2-option" data-v="Profissional Liberal / Especialista" onclick="ob2Pick(this,'ob2-prof-options','ob2-prof')">
                <div class="ob2-opt-ico">🎯</div><div><div class="ob2-opt-name">Profissional Liberal / Especialista</div><div class="ob2-opt-desc">Consultor, coach, médico, advogado...</div></div>
              </div>
              <div class="ob2-option" data-v="Criador de Conteúdo / Influenciador" onclick="ob2Pick(this,'ob2-prof-options','ob2-prof')">
                <div class="ob2-opt-ico">📱</div><div><div class="ob2-opt-name">Criador de Conteúdo / Influenciador</div><div class="ob2-opt-desc">Digital creator, influencer, streamer</div></div>
              </div>
              <div class="ob2-option" data-v="Gestor de Marketing / Agência" onclick="ob2Pick(this,'ob2-prof-options','ob2-prof')">
                <div class="ob2-opt-ico">📊</div><div><div class="ob2-opt-name">Gestor de Marketing / Agência</div><div class="ob2-opt-desc">Cria conteúdo para clientes</div></div>
              </div>
            </div>
            <input type="hidden" id="ob2-prof" value="Empreendedor / Empresário">
            <div class="ob2-nav">
              <button class="btn btn-p" onclick="ob2Next(1,{profissao:document.getElementById('ob2-prof').value})">Continuar →</button>
            </div>
          </div>

          <!-- STEP 2: Nicho -->
          <div class="ob2-step" id="ob2-s2">
            <div class="ob2-eyebrow">Passo 2 de 7</div>
            <h1 class="ob2-title">Qual é o seu nicho?</h1>
            <p class="ob2-sub">O nicho define o vocabulário, referências e profundidade do conteúdo gerado.</p>
            <div class="ob2-input-row">
              <label>Seu nicho de atuação</label>
              <input type="text" id="ob2-nicho" placeholder="Ex: Vendas B2B, Emagrecimento, Investimentos, Marketing Digital..." maxlength="80">
            </div>
            <div class="ob2-input-row">
              <label>Público-alvo principal</label>
              <input type="text" id="ob2-publico" placeholder="Ex: Diretores comerciais, Mulheres 25-40, Pequenos empresários..." maxlength="80">
            </div>
            <div class="ob2-nav">
              <button class="ob2-nav btn-back" onclick="ob2Back(2)">←</button>
              <button class="btn btn-p" onclick="ob2Next(2,{nicho:document.getElementById('ob2-nicho').value,publico:document.getElementById('ob2-publico').value})">Continuar →</button>
            </div>
            <div class="ob2-skip"><a onclick="ob2Next(2,{nicho:'negócios',publico:'profissionais'})">Pular por agora</a></div>
          </div>

          <!-- STEP 3: Tom de Voz -->
          <div class="ob2-step" id="ob2-s3">
            <div class="ob2-eyebrow">Passo 3 de 7</div>
            <h1 class="ob2-title">Tom de voz</h1>
            <p class="ob2-sub">Como você se comunica com sua audiência? Selecione os que descrevem sua personalidade de marca.</p>
            <div class="ob2-chips" id="ob2-tom-chips">
              <div class="ob2-chip on" onclick="ob2ToggleChip(this)">Autoridade</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">Provocativo</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">Educativo</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">Inspiracional</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">Descontraído</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">Premium</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">Técnico</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">Empático</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">Direto</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">Storytelling</div>
            </div>
            <div class="ob2-nav">
              <button class="ob2-nav btn-back" onclick="ob2Back(3)">←</button>
              <button class="btn btn-p" onclick="ob2Next(3,{tom:[...document.querySelectorAll('#ob2-tom-chips .ob2-chip.on')].map(c=>c.textContent).join(', ')})">Continuar →</button>
            </div>
          </div>

          <!-- STEP 4: Cores -->
          <div class="ob2-step" id="ob2-s4">
            <div class="ob2-eyebrow">Passo 4 de 7</div>
            <h1 class="ob2-title">Identidade visual</h1>
            <p class="ob2-sub">Suas cores são aplicadas automaticamente em todos os conteúdos visuais gerados.</p>
            <div class="ob2-colors">
              <div class="ob2-color-item">
                <label>Cor primária</label>
                <div class="ob2-color-swatch" style="background:#F5C518">
                  <input type="color" id="ob2-c1" value="#F5C518" oninput="ob2ColorUpdate(this,'ob2-c1')">
                  <div class="ob2-color-fill" id="ob2-c1-fill" style="background:#F5C518"></div>
                </div>
                <div class="ob2-color-hex" id="ob2-c1-hex">#F5C518</div>
              </div>
              <div class="ob2-color-item">
                <label>Cor de fundo</label>
                <div class="ob2-color-swatch" style="background:#0D0D0F">
                  <input type="color" id="ob2-c2" value="#0D0D0F" oninput="ob2ColorUpdate(this,'ob2-c2')">
                  <div class="ob2-color-fill" id="ob2-c2-fill" style="background:#0D0D0F"></div>
                </div>
                <div class="ob2-color-hex" id="ob2-c2-hex">#0D0D0F</div>
              </div>
              <div class="ob2-color-item">
                <label>Cor de texto</label>
                <div class="ob2-color-swatch" style="background:#F5F4F0">
                  <input type="color" id="ob2-c3" value="#F5F4F0" oninput="ob2ColorUpdate(this,'ob2-c3')">
                  <div class="ob2-color-fill" id="ob2-c3-fill" style="background:#F5F4F0"></div>
                </div>
                <div class="ob2-color-hex" id="ob2-c3-hex">#F5F4F0</div>
              </div>
            </div>
            <div style="font-size:11px;font-weight:700;color:var(--t2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Paletas prontas</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px">
              <button class="btn btn-g btn-sm" onclick="ob2ApplyPalette('#F5C518','#0D0D0F','#F5F4F0')">AutoPostt</button>
              <button class="btn btn-g btn-sm" onclick="ob2ApplyPalette('#003DA5','#FFFFFF','#1A1A1A')">Azul Corporativo</button>
              <button class="btn btn-g btn-sm" onclick="ob2ApplyPalette('#E8302A','#0A0A0A','#F5F5F5')">Vermelho Bold</button>
              <button class="btn btn-g btn-sm" onclick="ob2ApplyPalette('#00A86B','#0D1117','#F0FFF4')">Verde Tech</button>
              <button class="btn btn-g btn-sm" onclick="ob2ApplyPalette('#8B5CF6','#0F0A1E','#FAF5FF')">Roxo Premium</button>
            </div>
            <div class="ob2-nav">
              <button class="ob2-nav btn-back" onclick="ob2Back(4)">←</button>
              <button class="btn btn-p" onclick="ob2Next(4,{cores:document.getElementById('ob2-c1').value+', '+document.getElementById('ob2-c2').value+', '+document.getElementById('ob2-c3').value})">Continuar →</button>
            </div>
          </div>

          <!-- STEP 5: Estilo Visual -->
          <div class="ob2-step" id="ob2-s5">
            <div class="ob2-eyebrow">Passo 5 de 7</div>
            <h1 class="ob2-title">Estilo visual</h1>
            <p class="ob2-sub">Define o DNA visual dos seus posts — composição, tipografia, atmosfera.</p>
            <div class="ob2-options" id="ob2-estilo-options">
              <div class="ob2-option on" data-v="Dark Premium" onclick="ob2Pick(this,'ob2-estilo-options','ob2-estilo')">
                <div class="ob2-opt-ico">🖤</div><div><div class="ob2-opt-name">Dark Premium</div><div class="ob2-opt-desc">Fundo escuro, tipografia forte, acentos vibrantes</div></div>
              </div>
              <div class="ob2-option" data-v="Clean Minimalista" onclick="ob2Pick(this,'ob2-estilo-options','ob2-estilo')">
                <div class="ob2-opt-ico">⬜</div><div><div class="ob2-opt-name">Clean Minimalista</div><div class="ob2-opt-desc">Espaço em branco, linhas finas, elegância</div></div>
              </div>
              <div class="ob2-option" data-v="Corporativo Profissional" onclick="ob2Pick(this,'ob2-estilo-options','ob2-estilo')">
                <div class="ob2-opt-ico">💼</div><div><div class="ob2-opt-name">Corporativo Profissional</div><div class="ob2-opt-desc">Estruturado, confiável, hierarquia clara</div></div>
              </div>
              <div class="ob2-option" data-v="Vibrante e Criativo" onclick="ob2Pick(this,'ob2-estilo-options','ob2-estilo')">
                <div class="ob2-opt-ico">🎨</div><div><div class="ob2-opt-name">Vibrante e Criativo</div><div class="ob2-opt-desc">Cores fortes, energia, personalidade marcante</div></div>
              </div>
            </div>
            <input type="hidden" id="ob2-estilo" value="Dark Premium">
            <div class="ob2-nav">
              <button class="ob2-nav btn-back" onclick="ob2Back(5)">←</button>
              <button class="btn btn-p" onclick="ob2Next(5,{estilo:document.getElementById('ob2-estilo').value})">Continuar →</button>
            </div>
          </div>

          <!-- STEP 6: Redes Sociais -->
          <div class="ob2-step" id="ob2-s6">
            <div class="ob2-eyebrow">Passo 6 de 7</div>
            <h1 class="ob2-title">Onde você publica?</h1>
            <p class="ob2-sub">Selecionamos os agentes e formatos certos para cada plataforma.</p>
            <div class="ob2-chips" id="ob2-redes-chips" style="margin-bottom:24px">
              <div class="ob2-chip on" onclick="ob2ToggleChip(this)">Instagram</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">LinkedIn</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">YouTube</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">TikTok</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">Facebook</div>
              <div class="ob2-chip" onclick="ob2ToggleChip(this)">Twitter/X</div>
            </div>
            <div class="ob2-nav">
              <button class="ob2-nav btn-back" onclick="ob2Back(6)">←</button>
              <button class="btn btn-p" onclick="ob2Next(6,{redes:[...document.querySelectorAll('#ob2-redes-chips .ob2-chip.on')].map(c=>c.textContent).join(', ')})">Continuar →</button>
            </div>
          </div>

          <!-- STEP 7: Confirmação -->
          <div class="ob2-step" id="ob2-s7">
            <div class="ob2-eyebrow">Tudo pronto!</div>
            <h1 class="ob2-title">Seu perfil está configurado</h1>
            <p class="ob2-sub">A IA já tem tudo que precisa para criar conteúdo com a identidade da sua marca aplicada automaticamente.</p>
            <div style="background:var(--bg2);border:1px solid var(--b1);border-radius:var(--r3);padding:20px;margin-bottom:24px">
              <div style="font-size:11px;font-weight:700;color:var(--a);text-transform:uppercase;letter-spacing:.1em;margin-bottom:14px">Resumo do perfil</div>
              <div id="ob2-summary" style="font-size:12px;color:var(--t1);line-height:1.9"></div>
            </div>
            <div class="ob2-nav">
              <button class="btn btn-p" id="ob2-finish-btn" onclick="ob2Finish()">
                <svg style="width:16px;height:16px;fill:none;stroke:#fff;stroke-width:2.5" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Entrar no AutoPostt Studio
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Onboarding v2 state
  const _ob2Data = {};
  let _ob2Step = 1;

  window.ob2Pick = function(el, groupId, inputId) {
    document.querySelectorAll('#' + groupId + ' .ob2-option').forEach(o => o.classList.remove('on'));
    el.classList.add('on');
    const inp = document.getElementById(inputId);
    if (inp) inp.value = el.dataset.v || el.querySelector('.ob2-opt-name').textContent;
  };

  window.ob2ToggleChip = function(el) { el.classList.toggle('on'); };

  window.ob2ColorUpdate = function(inp, id) {
    const fill = document.getElementById(id + '-fill');
    const hex  = document.getElementById(id + '-hex');
    if (fill) fill.style.background = inp.value;
    if (hex)  hex.textContent = inp.value.toUpperCase();
  };

  window.ob2ApplyPalette = function(c1, c2, c3) {
    ['ob2-c1','ob2-c2','ob2-c3'].forEach((id, i) => {
      const c = [c1,c2,c3][i];
      const inp  = document.getElementById(id);
      const fill = document.getElementById(id + '-fill');
      const hex  = document.getElementById(id + '-hex');
      if (inp)  inp.value = c;
      if (fill) fill.style.background = c;
      if (hex)  hex.textContent = c.toUpperCase();
    });
  };

  window.ob2Next = async function(step, data) {
    if (data) Object.assign(_ob2Data, data);

    // Save step progress to backend
    const token = localStorage.getItem('gerai_token') || window.token || '';
    if (token) {
      try {
        const BASE = window.API_BASE || '';
        await fetch(BASE + '/api/user/onboard-step', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
          body: JSON.stringify({ step, data })
        });
      } catch { /* non-blocking */ }
    }

    _ob2Step = step + 1;
    const pct = Math.round(_ob2Step / 7 * 100);
    const fill = document.getElementById('ob2-fill');
    if (fill) fill.style.width = pct + '%';

    document.querySelectorAll('.ob2-step').forEach(s => s.classList.remove('on'));
    const next = document.getElementById('ob2-s' + _ob2Step);
    if (next) next.classList.add('on');

    // Pre-fill step 7 summary
    if (_ob2Step === 7) _ob2BuildSummary();
  };

  window.ob2Back = function(step) {
    _ob2Step = step - 1;
    const pct = Math.round(_ob2Step / 7 * 100);
    const fill = document.getElementById('ob2-fill');
    if (fill) fill.style.width = pct + '%';
    document.querySelectorAll('.ob2-step').forEach(s => s.classList.remove('on'));
    const prev = document.getElementById('ob2-s' + _ob2Step);
    if (prev) prev.classList.add('on');
  };

  function _ob2BuildSummary() {
    const el = document.getElementById('ob2-summary');
    if (!el) return;
    const rows = [
      ['Profissão', _ob2Data.profissao || '—'],
      ['Nicho', _ob2Data.nicho || '—'],
      ['Público', _ob2Data.publico || '—'],
      ['Tom de voz', _ob2Data.tom || '—'],
      ['Cores', _ob2Data.cores || '—'],
      ['Estilo visual', _ob2Data.estilo || '—'],
      ['Redes sociais', _ob2Data.redes || '—'],
    ];
    el.innerHTML = rows.map(r =>
      `<div style="display:flex;gap:8px;border-bottom:1px solid var(--b0);padding:5px 0">
        <span style="font-weight:600;color:var(--t0);min-width:110px;flex-shrink:0">${r[0]}</span>
        <span style="color:var(--t2)">${r[1]}</span>
      </div>`
    ).join('');
  }

  window.ob2Finish = async function() {
    const btn = document.getElementById('ob2-finish-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<svg style="width:16px;height:16px;fill:none;stroke:#fff;stroke-width:2;animation:spin .8s linear infinite" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Salvando...'; }

    const token = localStorage.getItem('gerai_token') || window.token || '';
    try {
      const BASE = window.API_BASE || '';
      const res = await fetch(BASE + '/api/user/profile', {
        method: 'PUT',
        headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
        body: JSON.stringify({ ..._ob2Data, onboard_step: 7 })
      });
      const data = await res.json();
      if (data.ok) {
        if (window.me) Object.assign(window.me, data.user || _ob2Data);
      }
    } catch { /* save local */ }

    localStorage.setItem('gerai_ob_done', '1');
    if (window._ob2Data?.cores) {
      const cs = _ob2Data.cores.split(',').map(s => s.trim());
      window.saveBrand?.({ cores: cs });
    }

    window.toast?.('Perfil configurado! Bem-vindo ao AutoPostt.', 'ok');
    window.bootApp?.(true);
  };


  // ─────────────────────────────────────────────────────────
  // BLOCO 4: DASHBOARD — KPIs REAIS + nav.calendar
  // Patch no loadDashboard para mostrar dados reais
  // ─────────────────────────────────────────────────────────

  const _origLoadDashboard = window.loadDashboard;
  window.loadDashboard = async function() {
    // Call original if exists
    if (_origLoadDashboard) {
      try { await _origLoadDashboard(); } catch { /* continue */ }
    }

    // Inject real KPI data from backend
    try {
      const BASE  = window.API_BASE || '';
      const token = localStorage.getItem('gerai_token') || window.token || '';
      if (!token) return;

      const [genRes, calRes] = await Promise.allSettled([
        fetch(`${BASE}/api/user/generations`, { headers: { 'Authorization':'Bearer '+token } }).then(r => r.json()),
        fetch(`${BASE}/api/user/calendar`, { headers: { 'Authorization':'Bearer '+token } }).then(r => r.json())
      ]);

      const gens = genRes.status === 'fulfilled' && genRes.value.ok ? genRes.value.generations || [] : [];
      const calStats = calRes.status === 'fulfilled' && calRes.value.ok ? calRes.value.stats || {} : {};

      // Update KPI values if elements exist
      const kpiRow = document.querySelector('.kpi-row');
      if (kpiRow) {
        const kpis = kpiRow.querySelectorAll('.kpi');
        if (kpis.length >= 1) {
          const valEl = kpis[0]?.querySelector('.kpi-val');
          if (valEl) valEl.textContent = gens.length;
        }
        if (kpis.length >= 2) {
          const valEl = kpis[1]?.querySelector('.kpi-val');
          if (valEl) valEl.textContent = calStats.ready || 0;
        }
      }

      // Update recent activity with real generations
      if (gens.length) {
        const actContainer = document.querySelector('.act-row')?.parentElement;
        if (actContainer) {
          const recentGens = gens.slice(0, 5);
          const iconMap = {
            legenda: `<svg class="ico ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
            'roteiro-yt': `<svg class="ico ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 0 0 1.46 6.42 29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.41 19.6C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.95A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58z"/><polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02"/></svg>`,
            imagem: `<svg class="ico ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
          };
          const netBadge = { instagram:'bdg-a', linkedin:'bdg-b', youtube:'bdg-g', tiktok:'bdg-n' };
          const actHTML = recentGens.map(g => {
            const ico = iconMap[g.feature] || iconMap.imagem;
            const net = g.network || 'instagram';
            const badge = netBadge[net] || 'bdg-n';
            const name = g.concept_name || g.feature || 'Conteúdo';
            const ago = window.timeAgo?.(g.created_at) || '—';
            return `<div class="act-row">
              <div class="act-ico">${ico}</div>
              <div class="act-body">
                <div class="act-name">${_esc(name)}</div>
                <div class="act-meta"><span class="badge ${badge}">${net}</span></div>
              </div>
              <div class="act-time">${ago}</div>
            </div>`;
          }).join('');

          const titleEl = actContainer.querySelector('.t-sm.fw-7');
          if (titleEl) {
            actContainer.innerHTML = '';
            actContainer.appendChild(titleEl.cloneNode(true));
            actContainer.insertAdjacentHTML('beforeend', actHTML);
          }
        }
      }

    } catch { /* non-blocking */ }
  };


  // ─────────────────────────────────────────────────────────
  // PATCH: nav() override — add calendar route
  // ─────────────────────────────────────────────────────────

  const _origNav = window.nav;
  window.nav = function(p, el) {
    if (p === 'calendar') {
      document.querySelectorAll('.pg').forEach(x => x.classList.remove('on'));
      document.querySelectorAll('.agent-pg').forEach(x => x.classList.remove('on'));
      document.querySelectorAll('.ni').forEach(x => x.classList.remove('on'));

      const calPg = document.getElementById('pg-calendar');
      if (calPg) calPg.classList.add('on');
      if (el && el.classList) el.classList.add('on');

      const curEl = document.getElementById('tb-cur');
      if (curEl) curEl.textContent = 'Calendário';

      loadCalendar();
      return;
    }
    if (_origNav) _origNav(p, el);
  };

  // Add calendar to crumbs map if it exists
  if (window.crumbs) window.crumbs['calendar'] = 'Calendário';


  // ─────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _init() {
    _injectCalendar();
    _injectOnboardingV2();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
