/* =========================================================================
   COVERAGE X-RAY - app.js
   Todos os valores vem de PLAY_DATA (play_data.js), extraido dos CSVs reais.
   Nenhum dado, jogador, evento ou estatistica e inventado aqui.
   ========================================================================= */

(function () {
  "use strict";

  // ---------- fonte de dados (abstracao) ----------
  // Hoje: tracking histórico do dataset. No futuro, bastaria trocar esta
  // constante e a origem de PLAY_DATA por um feed de tracking em tempo real,
  // sem mudar o restante da interface. NAO ha conexao online neste protótipo.
  const DATA_SOURCE = "HISTORICAL_TRACKING";

  // ---------- refs de dados reais ----------
  const D = PLAY_DATA;
  const players = D.players;
  const tracks = D.tracks;      // { nflId: [ {f,x,y,s,a,o,dir,event}, ... ] }
  const ball = D.ball;

  // frames disponiveis (a partir dos dados reais)
  const allFrames = ball.map(b => b.f);
  const FRAME_MIN = Math.min(...allFrames);
  const FRAME_MAX = Math.max(...allFrames);

  // ---------- dimensoes do campo (padrao NFL Big Data Bowl) ----------
  // x: 0-120 jardas (inclui as 2 end zones de 10). y: 0-53.3.
  const FIELD_X = 120;
  const FIELD_Y = 53.3;

  // ---------- canvas ----------
  const canvas = document.getElementById("field");
  const ctx = canvas.getContext("2d");
  const CW = canvas.width;   // 1200
  const CH = canvas.height;  // 534

  const scaleX = CW / FIELD_X;
  const scaleY = CH / FIELD_Y;

  // converte coordenada de campo -> pixel do canvas
  function toPx(x, y) {
    return { px: x * scaleX, py: CH - y * scaleY };
  }

  // ---------- classificacao de jogadores (real, via team + pff_role) ----------
  const offenseTeam = D.play.possessionTeam;
  const playerById = {};
  players.forEach(p => { playerById[p.nflId] = p; });

  function isOffense(p) { return p.team === offenseTeam; }
  function isRoute(p) { return p.role === "Pass Route"; }
  function isCoverage(p) { return p.role === "Coverage"; }
  function isDefender(p) { return !isOffense(p); }

  function colorFor(p) {
    if (isOffense(p)) return isRoute(p) ? "#ffd75e" : "#f5b301";
    return isCoverage(p) ? "#ff8fa3" : "#ff5470";
  }

  // ---------- frames-chave (reais, lidos do event) ----------
  function frameOfEvent(names) {
    for (const b of ball) {
      if (names.includes(b.event)) return b.f;
    }
    // fallback: procurar em qualquer jogador
    for (const id in tracks) {
      for (const s of tracks[id]) {
        if (names.includes(s.event)) return s.f;
      }
    }
    return null;
  }
  const SNAP_FRAME = frameOfEvent(["ball_snap"]);
  const RELEASE_FRAME = frameOfEvent(["pass_forward", "pass_shovel"])
                     || frameOfEvent(["autoevent_passforward"]);

  // fase da jogada a partir do frame atual
  function phaseOf(frame) {
    if (SNAP_FRAME && frame < SNAP_FRAME) return "PRÉ-SNAP";
    if (SNAP_FRAME && frame === SNAP_FRAME) return "SNAP";
    if (RELEASE_FRAME && frame >= RELEASE_FRAME) return "PÓS-LANÇAMENTO";
    return "LANÇAMENTO"; // entre snap e release = desenvolvimento do passe
  }

  // ---------- helpers de amostra por frame ----------
  const sampleCache = {};
  function sampleAt(nflId, frame) {
    const key = nflId + "|" + frame;
    if (key in sampleCache) return sampleCache[key];
    const arr = tracks[nflId];
    let found = null;
    for (const s of arr) { if (s.f === frame) { found = s; break; } }
    sampleCache[key] = found;
    return found;
  }
  function ballAt(frame) {
    for (const b of ball) if (b.f === frame) return b;
    return null;
  }

  function dist(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
  }

  // diferenca angular tratando o ciclo de 360 graus (retorna 0..180)
  function angleDelta(a, b) {
    if (a == null || b == null) return 0;
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
  }

  // ---------- matchup: receiver vs defender mais proximo (real x/y) ----------
  // Para cada receiver em rota, encontra o defender de coverage mais proximo
  // no snap, e acompanha essa separacao ao longo dos frames.
  const receivers = players.filter(isRoute);
  const defenders = players.filter(isCoverage);

  function nearestDefenderAt(recId, frame) {
    const r = sampleAt(recId, frame);
    if (!r) return null;
    let best = null, bestD = Infinity;
    for (const d of defenders) {
      const ds = sampleAt(d.nflId, frame);
      if (!ds) continue;
      const dd = dist(r.x, r.y, ds.x, ds.y);
      if (dd < bestD) { bestD = dd; best = { defender: d, sample: ds, sep: dd }; }
    }
    return best;
  }

  // define o par de foco: o receiver+defender com MENOR separacao no snap
  // (proxy simples e transparente para "matchup principal" da jogada)
  function pickFocusPair() {
    const f = SNAP_FRAME || FRAME_MIN;
    let best = null, bestD = Infinity;
    for (const rec of receivers) {
      const nd = nearestDefenderAt(rec.nflId, f);
      if (nd && nd.sep < bestD) { bestD = nd.sep; best = { rec, def: nd.defender }; }
    }
    return best;
  }
  const focusPair = pickFocusPair();

  /* =========================================================================
     MOVEMENT PREDICTION (dados historicos reais, em predictions.js)
     PREDICTIONS.byPlayer[nflId] = { role, samples, moves: [{dx,dy,prob,count}] | null }
     Os vetores dx,dy sao deslocamentos medios observados (em jardas) do snap
     ate ~1s depois, ja orientados p/ o ataque = +X. A jogada atual e 'right',
     entao +X aponta para a direita do campo (mesmo sentido do ataque).
     ========================================================================= */
  const HAS_PRED = (typeof PREDICTIONS !== "undefined") && PREDICTIONS.byPlayer;
  const ARROW_COLORS = ["#ff3b3b", "#ff9f1c", "#ffd60a"];
  let selectedPlayerId = focusPair ? focusPair.rec.nflId : (players[0] && players[0].nflId);
  let showPrediction = true;

  // as predicoes so fazem sentido ANTES do pass release
  function predictionVisible(frame) {
    if (!showPrediction) return false;
    if (!RELEASE_FRAME) return true;
    return frame < RELEASE_FRAME;
  }

  function predFor(nflId) {
    if (!HAS_PRED) return null;
    return PREDICTIONS.byPlayer[nflId] || null;
  }

  // amplia o vetor (em jardas) para ficar visivel no campo sem distorcer a direcao
  const PRED_GAIN = 2.4;
  function drawPrediction(nflId, frame) {
    const pred = predFor(nflId);
    const s = sampleAt(nflId, frame);
    if (!pred || !pred.moves || !s) return;
    const origin = toPx(s.x, s.y);

    // pulsacao muito leve, so na seta mais provavel, para parecer "viva"
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 400);

    // desenha da menos provavel para a mais provavel, para a vermelha ficar por cima
    for (let i = pred.moves.length - 1; i >= 0; i--) {
      const m = pred.moves[i];
      const fx = s.x + m.dx * PRED_GAIN;
      const fy = s.y + m.dy * PRED_GAIN;
      const tip = toPx(fx, fy);
      const col = ARROW_COLORS[i] || "#ffd60a";
      const isMain = i === 0;

      // hierarquia visual: principal grossa e opaca, secundarias finas e discretas
      const width = isMain ? 5 : (i === 1 ? 3 : 2);
      const alpha = isMain ? 0.95 : (i === 1 ? 0.55 : 0.4);

      const ang = Math.atan2(tip.py - origin.py, tip.px - origin.px);

      // brilho pulsante sob a seta principal
      if (isMain) {
        ctx.save();
        ctx.globalAlpha = 0.25 + 0.25 * pulse;
        ctx.strokeStyle = col;
        ctx.lineWidth = width + 6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(origin.px, origin.py);
        ctx.lineTo(tip.px, tip.py);
        ctx.stroke();
        ctx.restore();
      }

      // linha da trajetoria
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = col;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(origin.px, origin.py);
      ctx.lineTo(tip.px, tip.py);
      ctx.stroke();

      // cabeca da seta (proporcional a importancia)
      const ah = isMain ? 13 : 9;
      ctx.beginPath();
      ctx.moveTo(tip.px, tip.py);
      ctx.lineTo(tip.px - ah * Math.cos(ang - Math.PI / 7), tip.py - ah * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(tip.px - ah * Math.cos(ang + Math.PI / 7), tip.py - ah * Math.sin(ang + Math.PI / 7));
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();

      // rótulo de probabilidade junto da ponta (principal maior)
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.font = isMain ? "bold 14px Segoe UI" : "bold 11px Segoe UI";
      ctx.textAlign = "center";
      // pequeno recuo do rótulo para nao colar na ponta
      const lx = tip.px + Math.cos(ang) * 12;
      const ly = tip.py + Math.sin(ang) * 12 - 6;
      ctx.fillText(m.prob + "%", lx, ly);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // qual jogador esta sob o ponto (px,py) do canvas, no frame atual
  function playerAtPixel(px, py, frame) {
    let best = null, bestD = Infinity;
    for (const p of players) {
      const s = sampleAt(p.nflId, frame);
      if (!s) continue;
      const pt = toPx(s.x, s.y);
      const d = Math.hypot(pt.px - px, pt.py - py);
      if (d < 14 && d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function separationAt(frame) {
    if (!focusPair) return null;
    const r = sampleAt(focusPair.rec.nflId, frame);
    const d = sampleAt(focusPair.def.nflId, frame);
    if (!r || !d) return null;
    return dist(r.x, r.y, d.x, d.y);
  }

  /* =========================================================================
     COVERAGE REVEAL SCORE (CRS)  - metrica derivada, 0..100
     Combina 3 sinais reais medidos entre o SNAP e o PASS RELEASE:
       1) mudanca de direcao media dos defensores (graus)  -> defesa "girou"
       2) mudanca de velocidade media dos defensores (yd/s) -> defesa "reagiu"
       3) mudanca de separacao do par de foco (yd)          -> a jogada "abriu"
     Cada sinal e normalizado para 0..1 por um teto simples e transparente,
     depois combinados com pesos iguais e escalados para 0..100.
     ========================================================================= */
  const CRS_CFG = {
    // tetos de normalizacao (valores acima disso contam como 1.0)
    // calibrados na jogada validada: dDir medio ~68 graus, dSpd ~3.9 yd/s,
    // dSep ~5.5 yd -> tetos escolhidos para nao saturar em 1.0.
    maxDirChange: 120,  // graus
    maxSpdChange: 6,    // yd/s
    maxSepChange: 10,   // yd
    weights: { dir: 1, spd: 1, sep: 1 }
  };

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function computeCRS() {
    if (!SNAP_FRAME || !RELEASE_FRAME) return null;

    // 1) mudanca de direcao media dos defensores (snap -> release)
    let dirSum = 0, dirN = 0;
    for (const d of defenders) {
      const s0 = sampleAt(d.nflId, SNAP_FRAME);
      const s1 = sampleAt(d.nflId, RELEASE_FRAME);
      if (s0 && s1) { dirSum += angleDelta(s0.dir, s1.dir); dirN++; }
    }
    const dirAvg = dirN ? dirSum / dirN : 0;

    // 2) mudanca de velocidade media dos defensores (|s_release - s_snap|)
    let spdSum = 0, spdN = 0;
    for (const d of defenders) {
      const s0 = sampleAt(d.nflId, SNAP_FRAME);
      const s1 = sampleAt(d.nflId, RELEASE_FRAME);
      if (s0 && s1 && s0.s != null && s1.s != null) {
        spdSum += Math.abs(s1.s - s0.s); spdN++;
      }
    }
    const spdAvg = spdN ? spdSum / spdN : 0;

    // 3) mudanca de separacao do par de foco (|sep_release - sep_snap|)
    const sep0 = separationAt(SNAP_FRAME);
    const sep1 = separationAt(RELEASE_FRAME);
    const sepChange = (sep0 != null && sep1 != null) ? Math.abs(sep1 - sep0) : 0;

    // normaliza
    const nDir = clamp01(dirAvg / CRS_CFG.maxDirChange);
    const nSpd = clamp01(spdAvg / CRS_CFG.maxSpdChange);
    const nSep = clamp01(sepChange / CRS_CFG.maxSepChange);

    const w = CRS_CFG.weights;
    const wSum = w.dir + w.spd + w.sep;
    const score = ((nDir * w.dir + nSpd * w.spd + nSep * w.sep) / wSum) * 100;

    return {
      score: Math.round(score),
      parts: {
        dirAvg, spdAvg, sepChange,
        nDir, nSpd, nSep
      }
    };
  }

  /* =========================================================================
     RENDER DO CAMPO
     ========================================================================= */
  function drawField() {
    // gramado
    ctx.fillStyle = "#0e3d24";
    ctx.fillRect(0, 0, CW, CH);

    // faixas alternadas a cada 10 jardas (visual)
    for (let yard = 0; yard < FIELD_X; yard += 10) {
      const p = toPx(yard, FIELD_Y);
      ctx.fillStyle = (yard / 10) % 2 === 0 ? "#0e3d24" : "#0c3620";
      ctx.fillRect(p.px, 0, 10 * scaleX, CH);
    }

    // end zones
    ctx.fillStyle = "rgba(41,224,168,.10)";
    ctx.fillRect(toPx(0, FIELD_Y).px, 0, 10 * scaleX, CH);
    ctx.fillRect(toPx(110, FIELD_Y).px, 0, 10 * scaleX, CH);

    // linhas de jardas a cada 5
    ctx.strokeStyle = "rgba(255,255,255,.25)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.font = "12px Segoe UI";
    ctx.textAlign = "center";
    for (let yard = 10; yard <= 110; yard += 5) {
      const p = toPx(yard, FIELD_Y);
      ctx.beginPath();
      ctx.moveTo(p.px, 0);
      ctx.lineTo(p.px, CH);
      ctx.stroke();

      // numeros a cada 10 (10..50..10 no padrao de campo)
      if (yard % 10 === 0 && yard > 10 && yard < 110) {
        let n = yard - 10;               // 0..100
        let label = n <= 50 ? n : 100 - n;
        if (label === 0) continue;
        ctx.fillText(String(label), p.px, 22);
        ctx.fillText(String(label), p.px, CH - 12);
      }
    }

    // hash marks
    ctx.strokeStyle = "rgba(255,255,255,.18)";
    for (let yard = 11; yard < 110; yard++) {
      const top = toPx(yard, FIELD_Y - 18.5);
      const bot = toPx(yard, 18.5);
      ctx.beginPath(); ctx.moveTo(top.px, top.py - 4); ctx.lineTo(top.px, top.py + 4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bot.px, bot.py - 4); ctx.lineTo(bot.px, bot.py + 4); ctx.stroke();
    }

    // linha de scrimmage (absoluteYardline nao exportado; usamos a bola no snap)
    const snapBall = ballAt(SNAP_FRAME || FRAME_MIN);
    if (snapBall) {
      const p = toPx(snapBall.x, FIELD_Y);
      ctx.strokeStyle = "rgba(56,189,248,.8)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(p.px, 0); ctx.lineTo(p.px, CH); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawPlayers(frame) {
    // setas de predicao (somente pre-release e para o jogador selecionado)
    if (predictionVisible(frame) && selectedPlayerId) {
      drawPrediction(selectedPlayerId, frame);
    }

    // linha de foco receiver-defender
    if (focusPair) {
      const r = sampleAt(focusPair.rec.nflId, frame);
      const d = sampleAt(focusPair.def.nflId, frame);
      if (r && d) {
        const pr = toPx(r.x, r.y), pd = toPx(d.x, d.y);
        ctx.strokeStyle = "rgba(41,224,168,.75)";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(pr.px, pr.py); ctx.lineTo(pd.px, pd.py); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // jogadores
    for (const p of players) {
      const s = sampleAt(p.nflId, frame);
      if (!s) continue;
      const pt = toPx(s.x, s.y);
      const col = colorFor(p);

      // direcao (seta) quando ha movimento
      if (s.dir != null && s.s != null && s.s > 0.3) {
        const rad = (s.dir) * Math.PI / 180;
        // dir: 0=+y (para cima no campo). Convertendo p/ canvas.
        const dx = Math.sin(rad), dy = -Math.cos(rad);
        ctx.strokeStyle = "rgba(255,255,255,.55)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(pt.px, pt.py);
        ctx.lineTo(pt.px + dx * 16, pt.py + dy * 16);
        ctx.stroke();
      }

      // corpo
      ctx.beginPath();
      ctx.arc(pt.px, pt.py, 9, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,.55)";
      ctx.stroke();

      // numero da camisa
      if (p.jersey != null) {
        ctx.fillStyle = "#11202b";
        ctx.font = "bold 10px Segoe UI";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(p.jersey), pt.px, pt.py);
        ctx.textBaseline = "alphabetic";
      }

      // realce do par de foco
      if (focusPair && (p.nflId === focusPair.rec.nflId || p.nflId === focusPair.def.nflId)) {
        ctx.beginPath();
        ctx.arc(pt.px, pt.py, 13, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(41,224,168,.9)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // realce do jogador selecionado para predicao
      if (p.nflId === selectedPlayerId) {
        ctx.beginPath();
        ctx.arc(pt.px, pt.py, 15, 0, Math.PI * 2);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // bola
    const b = ballAt(frame);
    if (b) {
      const pt = toPx(b.x, b.y);
      ctx.beginPath();
      ctx.ellipse(pt.px, pt.py, 6, 4, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#b06a2c";
      ctx.fill();
      ctx.strokeStyle = "#3a2410";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function render(frame) {
    ctx.clearRect(0, 0, CW, CH);
    drawField();
    drawPlayers(frame);
  }

  /* =========================================================================
     PAINEIS / METRICAS
     ========================================================================= */
  // setText tolerante: ignora silenciosamente IDs que nao existem na tela
  function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  // ordinal PT-BR do down
  function downLabel(d) {
    const map = { "1": "1º DOWN", "2": "2º DOWN", "3": "3º DOWN", "4": "4º DOWN" };
    return map[String(d)] || (d != null ? d + "º DOWN" : "—");
  }

  function fillStaticInfo() {
    // metrica discreta de cobertura, abaixo do campo
    setText("mCoverage", D.play.pff_passCoverage || "—");

    // barra compacta de info da jogada (posse = "casa" da barra)
    setText("sbHome", D.play.possessionTeam || "—");
    setText("sbAway", D.play.defensiveTeam || "—");
    const yd = D.play.yardsToGo != null ? D.play.yardsToGo + " JARDAS" : "";
    setText("sbDown", downLabel(D.play.down) + (yd ? " · " + yd : ""));
    const q = D.play.quarter != null ? "Q" + D.play.quarter : "";
    setText("sbClock", (q ? q + " · " : "") + (D.play.gameClock || ""));

    // seletor de jogada (so 1 no MVP, mas ja fica pronto)
    const sel = document.getElementById("playSelect");
    if (sel) {
      const opt = document.createElement("option");
      opt.value = D.gameId + "-" + D.playId;
      opt.textContent = `${D.play.possessionTeam} x ${D.play.defensiveTeam} — ${D.play.playDescription}`;
      sel.appendChild(opt);
    }
  }

  // eventos do tracking -> rotulo curto em PT-BR
  const eventLabelPT = {
    "ball_snap": "Snap",
    "pass_forward": "Lançamento",
    "autoevent_passforward": "Lançamento (auto)",
    "pass_arrived": "Bola chegou",
    "pass_outcome_caught": "Recepção",
    "pass_outcome_incomplete": "Passe incompleto",
    "tackle": "Tackle"
  };

  // fase -> texto do indicador de MOMENTO na barra
  function momentText(phase) {
    if (phase === "PÓS-LANÇAMENTO") return "MOMENTO: PÓS-LANÇAMENTO";
    if (phase === "LANÇAMENTO") return "MOMENTO: LANÇAMENTO";
    return "MOMENTO: PRÉ-LANÇAMENTO"; // PRÉ-SNAP e SNAP
  }

  function updateFramePanels(frame) {
    // fase
    const phase = phaseOf(frame);
    setText("phaseBanner", phase);
    setText("sbMoment", momentText(phase));
    // chips
    document.querySelectorAll(".phase-chip").forEach(chip => {
      chip.classList.toggle("active", chip.dataset.phase === phase);
    });

    // quadro + evento
    setText("frameLabel", `FRAME ${frame} / ${FRAME_MAX}`);
    const b = ballAt(frame);
    const ev = (b && b.event && b.event !== "None") ? b.event : "";
    const evPT = ev ? (eventLabelPT[ev] || ev) : "";
    setText("eventLabel", evPT ? "● " + evPT : "");

    // separacao atual (real) - metrica discreta abaixo do campo
    const sep = separationAt(frame);
    setText("mSeparation", sep != null ? sep.toFixed(2) + " jd" : "—");
  }

  function fillCRS() {
    const crs = computeCRS();
    setText("mCRS", crs ? String(crs.score) : "N/D");
  }

  /* =========================================================================
     PAINEL: MOVEMENT PROBABILITY + COACH'S PLAY SUGGESTION
     ========================================================================= */
  // pff_role -> rotulo em PT-BR para exibicao
  const rolePT = {
    "Coverage": "Cobertura",
    "Pass Rush": "Pressão ao QB",
    "Pass Route": "Rota de passe",
    "Pass Block": "Proteção",
    "Pass": "Quarterback"
  };
  function roleLabel(role) { return role ? (rolePT[role] || role) : ""; }

  // converte um vetor (dx,dy) em texto de direcao no vocabulario do campo (PT-BR).
  // jogada 'right' -> +dx = para frente (campo adentro), -dx = para trás;
  // +dy = para a esquerda, -dy = para a direita (ponto de vista da transmissão).
  function describeDirection(dx, dy) {
    const parts = [];
    if (dx > 0.4) parts.push("para frente");
    else if (dx < -0.4) parts.push("para trás");
    if (dy > 0.4) parts.push("pela esquerda");
    else if (dy < -0.4) parts.push("pela direita");
    if (parts.length === 0) return "mantendo a posição";
    return parts.join(" ");
  }
  // lado oposto ao movimento dominante (para a sugestao do tecnico)
  function oppositeSide(dy) { return dy >= 0 ? "o lado direito" : "o lado esquerdo"; }

  function fillPredictionPanel(frame) {
    const nameEl = document.getElementById("predPlayerName");
    const listEl = document.getElementById("predList");
    const coachEl = document.getElementById("coachText");
    if (!nameEl || !listEl) return;

    const p = selectedPlayerId ? playerById[selectedPlayerId] : null;
    if (!p) {
      nameEl.textContent = "Selecione um jogador no campo";
      listEl.innerHTML = "";
      return;
    }

    const roleTxt = p.role ? " · " + roleLabel(p.role) : "";
    nameEl.textContent = `${p.name} #${p.jersey} (${p.pos})${roleTxt}`;

    const pred = predFor(selectedPlayerId);

    // sem dados suficientes -> mensagem honesta
    if (!pred || !pred.moves) {
      listEl.innerHTML = `<li class="pred-insufficient">Dados históricos insuficientes</li>`;
      if (coachEl) {
        coachEl.className = "coach-text muted";
        coachEl.textContent = "Evidências históricas insuficientes para uma sugestão confiável.";
      }
      return;
    }

    // pos-release: as setas somem, mostramos aviso curto
    if (!predictionVisible(frame)) {
      listEl.innerHTML = `<li class="pred-insufficient">Previsão exibida apenas antes do lançamento.</li>`;
    } else {
      const ordinal = ["Mais provável", "2ª possibilidade", "3ª possibilidade"];
      listEl.innerHTML = pred.moves.map((m, i) => {
        const col = ARROW_COLORS[i] || "#ffd60a";
        const dir = describeDirection(m.dx, m.dy);
        return `
          <li class="pred-row">
            <span class="pred-swatch" style="background:${col}"></span>
            <span class="pred-label">${ordinal[i] || "Possibilidade"} — ${dir}</span>
            <span class="pred-pct" style="color:${col}">${m.prob}%</span>
          </li>`;
      }).join("");
    }

    // sugestao do tecnico: baseada SO no padrao observado
    if (coachEl) fillCoachSuggestion(p, pred, coachEl);
  }

  function fillCoachSuggestion(player, pred, coachEl) {
    // sem movimentos historicos -> sem sugestao confiavel
    if (!pred || !pred.moves || pred.moves.length === 0) {
      coachEl.className = "coach-text muted";
      coachEl.textContent = "Evidências históricas insuficientes para uma sugestão confiável.";
      return;
    }
    const top = pred.moves[0];
    const dir = describeDirection(top.dx, top.dy);

    // sugestao transparente baseada no papel e na direcao dominante
    let sugestao;
    const role = player.role || "";
    if (role === "Coverage") {
      sugestao = `explorar ${oppositeSide(top.dy)}, longe de onde a cobertura tende a se deslocar`;
    } else if (role === "Pass Rush") {
      sugestao = "um passe rápido ou tela, saindo da linha de pressão";
    } else if (role === "Pass Route") {
      sugestao = "uma combinação de rotas que aproveite esse espaço à frente";
    } else if (role === "Pass") {
      sugestao = "um rollout que acompanhe o recuo típico do QB";
    } else {
      sugestao = "uma jogada que aproveite o espaço que esse movimento abre";
    }

    // so sugere se houver dominancia razoavel (>= 40%) e amostra suficiente
    if (top.prob >= 40 && pred.samples >= PREDICTIONS.meta.minSamples) {
      coachEl.className = "coach-text";
      coachEl.textContent =
        `Os padrões históricos indicam maior probabilidade de movimento ${dir} ` +
        `(${top.prob}%). O técnico pode ${sugestao}.`;
    } else {
      coachEl.className = "coach-text muted";
      coachEl.textContent = "Evidências históricas insuficientes para uma sugestão confiável.";
    }
  }

  /* =========================================================================
     TIMELINE / ANIMACAO
     ========================================================================= */
  const slider = document.getElementById("slider");
  slider.min = FRAME_MIN;
  slider.max = FRAME_MAX;
  slider.value = FRAME_MIN;

  let currentFrame = FRAME_MIN;
  let playing = false;
  let rafId = null;
  let lastTs = 0;
  const FPS = 10; // NGS ~10 frames/seg
  const FRAME_MS = 1000 / FPS;

  function goToFrame(f) {
    currentFrame = Math.max(FRAME_MIN, Math.min(FRAME_MAX, f));
    slider.value = currentFrame;
    render(currentFrame);
    updateFramePanels(currentFrame);
    fillPredictionPanel(currentFrame);
  }

  // loop leve de pulsacao das setas quando a jogada esta PAUSADA
  // (so redesenha o campo, nao avanca o frame nem toca em dados)
  let pulseRaf = null;
  function pulseLoop() {
    if (playing) { pulseRaf = null; return; } // durante o play o tick ja redesenha
    if (predictionVisible(currentFrame) && selectedPlayerId) {
      render(currentFrame);
    }
    pulseRaf = requestAnimationFrame(pulseLoop);
  }
  function startPulse() { if (!pulseRaf) pulseRaf = requestAnimationFrame(pulseLoop); }

  function tick(ts) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    const elapsed = ts - lastTs;
    if (elapsed >= FRAME_MS) {
      lastTs = ts;
      if (currentFrame >= FRAME_MAX) {
        playing = false;
        startPulse(); // volta a pulsar ao terminar a jogada
        return;
      }
      goToFrame(currentFrame + 1);
    }
    rafId = requestAnimationFrame(tick);
  }

  function play() {
    if (playing) return;
    if (currentFrame >= FRAME_MAX) goToFrame(FRAME_MIN);
    playing = true;
    lastTs = 0;
    if (pulseRaf) { cancelAnimationFrame(pulseRaf); pulseRaf = null; }
    rafId = requestAnimationFrame(tick);
  }
  function pause() {
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    startPulse(); // retoma a pulsacao suave das setas
  }
  function reset() {
    pause();
    goToFrame(FRAME_MIN);
  }

  // ---------- controles ----------
  document.getElementById("btnPlay").addEventListener("click", play);
  document.getElementById("btnPause").addEventListener("click", pause);
  document.getElementById("btnReset").addEventListener("click", reset);
  slider.addEventListener("input", e => {
    pause();
    goToFrame(parseInt(e.target.value, 10));
  });

  // clique no campo seleciona o jogador mais proximo -> mostra suas predicoes
  canvas.addEventListener("click", e => {
    const rect = canvas.getBoundingClientRect();
    // o canvas e escalado por CSS; converte pixel de tela -> pixel interno
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * sx;
    const py = (e.clientY - rect.top) * sy;
    const hit = playerAtPixel(px, py, currentFrame);
    if (hit) {
      selectedPlayerId = hit.nflId;
      render(currentFrame);
      fillPredictionPanel(currentFrame);
    }
  });
  canvas.style.cursor = "pointer";

  // toggle liga/desliga as setas de predicao
  const togglePred = document.getElementById("togglePred");
  if (togglePred) {
    togglePred.addEventListener("change", () => {
      showPrediction = togglePred.checked;
      render(currentFrame);
      fillPredictionPanel(currentFrame);
    });
  }

  // ---------- phase chips ----------
  function buildPhaseChips() {
    const wrap = document.getElementById("phaseMarkers");
    const phases = ["PRÉ-SNAP", "SNAP", "LANÇAMENTO", "PÓS-LANÇAMENTO"];
    wrap.innerHTML = phases.map(ph =>
      `<div class="phase-chip" data-phase="${ph}">${ph}</div>`
    ).join("");
  }

  /* =========================================================================
     INIT
     ========================================================================= */
  function init() {
    buildPhaseChips();
    fillStaticInfo();
    fillCRS();
    goToFrame(FRAME_MIN);
    startPulse(); // inicia a pulsacao suave das setas (jogada comeca pausada)
    console.log("[Raio-X do Movimento] fonte:", DATA_SOURCE,
                "snap:", SNAP_FRAME, "release:", RELEASE_FRAME,
                "predicoes:", HAS_PRED ? "ok" : "ausente");
  }

  init();
})();
