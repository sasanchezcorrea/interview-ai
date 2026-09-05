/* voice-client.js — the panel's voice, streamed clause by clause.
 *
 *   <script src="/voice-client.js"></script>
 *
 *   IAIVoice.begin({lang})   a new cue owns the voice; whatever was speaking stops
 *   IAIVoice.push(chunk)     one clause, the moment it closes
 *   IAIVoice.end()           no more text for this cue
 *   IAIVoice.cancel()        silence, now
 *
 * Two engines behind that API. With an ElevenLabs key on the server, clauses go up a
 * WebSocket and PCM comes back while the sentence is still being written. Without one,
 * `speechSynthesis` speaks the same clauses — the same call sites, the same ordering.
 * Nothing here ever sees the API key: the server holds it and relays.
 *
 * Optional: IAIVoice.configure({base, onEvent, log}) before the first begin().
 *   base    origin of the sidecar (default: same origin as the page)
 *   onEvent ({type, ...}) — "engine", "first-audio" (ms), "voice", "error", "end"
 */
(function () {
  "use strict";

  var cfg = { base: "", onEvent: null, log: true };
  var health = null;          // last /voice/health, or null until fetched
  var healthAt = 0;

  // One utterance at a time. `gen` invalidates everything from the cue before it:
  // late audio frames and late onstart callbacks check it and drop themselves.
  var gen = 0;
  var cue = null;             // { gen, lang, t0, engine, firstAudio, broken }

  var ws = null;              // socket to the sidecar's voice relay
  var wsReady = null;         // promise resolving when OPEN, or rejecting
  var actx = null, cursor = 0, sources = new Set(), pcmRate = 24000;

  function emit(ev) { try { cfg.onEvent && cfg.onEvent(ev); } catch (e) {} }
  function log() { if (cfg.log) console.log.apply(console, ["[voice]"].concat([].slice.call(arguments))); }

  /* ── browser voices, ranked by quality ────────────────────────────────────
     macOS ships one good voice per language and a crowd of novelty ones (Eddy, Flo,
     Grandma…), and Chrome hands them over in an order that means nothing. Score instead
     of naming names: the tier words Apple puts in the voiceURI (siri/premium/enhanced)
     decide it when the good voices are installed, and until then `default` — the macOS
     system voice, always a real adult voice — carries the pick. */
  function tierOf(v) {
    var s = ((v.voiceURI || "") + " " + (v.name || "")).toLowerCase();
    if (/siri/.test(s)) return { score: 400, tier: "siri" };
    if (/premium/.test(s)) return { score: 300, tier: "premium" };
    if (/enhanced/.test(s)) return { score: 200, tier: "enhanced" };
    return { score: 0, tier: "compact" };
  }
  // Apple's character voices carry the same name across a dozen locales; a real voice is
  // unique to its own. Counting names is what keeps "Grandpa" out of a job interview
  // without a hand-written list of every joke voice Apple ever shipped.
  function nameSpread(all) {
    var langs = {};
    all.forEach(function (v) {
      var n = (v.name || "").replace(/\s*\(.*\)$/, "").trim().toLowerCase();
      (langs[n] = langs[n] || {})[(v.lang || "").slice(0, 2)] = 1;
    });
    return function (v) {
      var n = (v.name || "").replace(/\s*\(.*\)$/, "").trim().toLowerCase();
      return Object.keys(langs[n] || {}).length;
    };
  }
  // ponytail: the spread rule already demotes the multilingual character voices; this
  // catches the en-US-only jokes (Zarvox, Bad News…) that share no name with anything.
  // A joke voice in a live interview is unrecoverable, so it gets a second guard.
  var NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|fred|good news|hysterical|jester|junior|kathy|organ|pipe organ|princess|ralph|superstar|trinoids|whisper|wobble|zarvox)$/i;

  function rankVoices(lang) {
    var all = (window.speechSynthesis ? speechSynthesis.getVoices() : []) || [];
    if (!all.length) return [];
    var spread = nameSpread(all);
    var want = (lang || "en-US").replace("_", "-").toLowerCase();
    var want2 = want.slice(0, 2);
    return all
      .map(function (v) {
        var vl = (v.lang || "").replace("_", "-").toLowerCase();
        if (vl.slice(0, 2) !== want2) return null;            // wrong language, no score can save it
        var t = tierOf(v), s = t.score;
        s += vl === want ? 40 : 10;                           // es-ES beats es-MX for an es-ES cue
        if (v.default) s += 25;                               // the macOS system voice is never a joke
        if (spread(v) >= 3) s -= 100;                         // Eddy in fourteen languages is a cartoon
        if (NOVELTY.test((v.name || "").trim())) s -= 500;
        if (v.localService === false) s -= 5;                 // a network voice adds a round trip we cannot afford
        return { voice: v, score: s, tier: t.tier, name: v.name, lang: v.lang };
      })
      .filter(Boolean)
      .sort(function (a, b) { return b.score - a.score; });
  }

  var chosen = {};   // lang → ranked[0], so the log line prints once per language
  function pickVoice(lang) {
    var key = lang || "auto";
    if (chosen[key] && chosen[key].voice) return chosen[key];
    var r = rankVoices(lang);
    if (!r.length) return null;
    chosen[key] = r[0];
    log("voz " + lang + " → " + r[0].name + " (" + r[0].tier + ", score " + r[0].score + ")" +
        (r[0].tier === "compact" ? "  ⚠ compacta: instala la versión Premium en Ajustes del Sistema" : ""));
    emit({ type: "voice", lang: lang, name: r[0].name, tier: r[0].tier, score: r[0].score });
    return r[0];
  }
  // Chrome fills the voice list asynchronously; a pick made before it lands is the wrong one.
  if (window.speechSynthesis) speechSynthesis.addEventListener("voiceschanged", function () { chosen = {}; });

  /* ── engine A: browser ────────────────────────────────────────────────── */
  // No cancel() between clauses — speechSynthesis queues, so clause after clause chains
  // into one sentence with no gap. Only a new cue cancels.
  function speakLocal(text, lang) {
    if (!window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = lang || "en-US";
    var p = pickVoice(u.lang);
    if (p) { u.voice = p.voice; u.lang = p.voice.lang; }
    // A compact voice reads flat; a touch of speed pulls it away from screen-reader cadence
    // and, in an interview, gets the cue out sooner. The good voices need no help.
    u.rate = p && p.tier !== "compact" ? 1.0 : 1.08;
    u.pitch = 1.0;
    u.volume = 1.0;
    var g = gen;
    u.onstart = function () { if (g === gen) markFirstAudio("browser"); };
    speechSynthesis.speak(u);
  }

  /* ── engine B: ElevenLabs, relayed by the sidecar ──────────────────────── */
  function audioCtx() {
    if (!actx) {
      // Built at the stream's own rate so the browser resamples instead of us.
      actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: pcmRate });
    }
    if (actx.state === "suspended") actx.resume();
    return actx;
  }
  /** Raw PCM16 chunks are independently decodable — no container, no MediaSource, and each
   *  chunk is scheduled end-to-end against a moving cursor so the sentence plays gapless. */
  function playPcm(bytes) {
    var ctx = audioCtx();
    var n = bytes.byteLength >> 1;
    if (!n) return;
    var i16 = new Int16Array(bytes.buffer, bytes.byteOffset, n);
    var buf = ctx.createBuffer(1, n, pcmRate);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < n; i++) ch[i] = i16[i] / 32768;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    var now = ctx.currentTime;
    // 20 ms of slack on (re)start: scheduling at exactly currentTime underruns and clicks.
    if (cursor < now) cursor = now + 0.02;
    src.start(cursor);
    cursor += buf.duration;
    sources.add(src);
    src.onended = function () { sources.delete(src); };
    markFirstAudio("elevenlabs");
  }
  function stopPcm() {
    sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
    sources.clear();
    cursor = 0;
  }

  function connect() {
    if (ws && ws.readyState <= 1) return wsReady;
    wsReady = new Promise(function (resolve, reject) {
      var url = health && health.wsUrl;
      if (!url) return reject(new Error("sin wsUrl"));
      var s = new WebSocket(url);
      s.binaryType = "arraybuffer";
      s.onopen = function () { ws = s; resolve(s); };
      s.onerror = function () { reject(new Error("websocket de voz no accesible")); };
      s.onclose = function () { if (ws === s) { ws = null; wsReady = null; } };
      s.onmessage = function (ev) {
        if (typeof ev.data !== "string") { if (cue && !cue.broken) playPcm(new Uint8Array(ev.data)); return; }
        var m = {};
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === "error") {
          // Anything the relay could not do — bad key, quota, model refused — means the rest
          // of this cue has to come out of the local voice rather than out of silence.
          log("relay: " + m.error);
          emit({ type: "error", where: "elevenlabs", error: m.error });
          if (cue) {
            cue.broken = true;
            if (!cue.firstAudio && cue.pending) speakLocal(cue.pending, cue.lang);
            cue.pending = "";
            emit({ type: "engine", engine: "browser", reason: m.error });   // the cue really is local now
          }
        } else if (m.type === "end") {
          emit({ type: "end", engine: "elevenlabs" });
        } else if (m.type === "rate" && m.rate) {
          pcmRate = m.rate;   // the relay names the sample rate; the context is built from it
        }
      };
    });
    return wsReady;
  }

  function send(obj) {
    return connect().then(function (s) { s.send(JSON.stringify(obj)); }).catch(function (e) {
      if (cue) cue.broken = true;
      emit({ type: "error", where: "transport", error: e.message });
    });
  }

  /* ── health ───────────────────────────────────────────────────────────── */
  function refreshHealth(force) {
    if (!force && health && Date.now() - healthAt < 30000) return Promise.resolve(health);
    return fetch(cfg.base + "/voice/health", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (h) { health = h; healthAt = Date.now(); return h; })
      .catch(function (e) { health = { provider: "browser", keyPresent: false, lastError: String(e.message || e) }; healthAt = Date.now(); return health; });
  }

  function markFirstAudio(engine) {
    if (!cue || cue.firstAudio) return;
    cue.firstAudio = performance.now();
    var ms = Math.round(cue.firstAudio - cue.t0);
    log("primer audio en " + ms + " ms (" + engine + ")");
    emit({ type: "first-audio", ms: ms, engine: engine });
  }

  /* ── public API ───────────────────────────────────────────────────────── */
  var IAIVoice = {
    configure: function (o) { Object.assign(cfg, o || {}); return IAIVoice; },

    /** Preload health and the browser voice list so the first cue pays for neither. */
    warm: function () { refreshHealth(true); rankVoices("es-ES"); return IAIVoice; },

    health: function () { return refreshHealth(true); },

    /** {browser:[{name,lang,tier,score}], server:{...}} — what the picker in the test page shows. */
    voices: function (lang) {
      return refreshHealth(false).then(function (h) {
        return fetch(cfg.base + "/voice/voices", { cache: "no-store" }).then(function (r) { return r.json(); })
          .catch(function (e) { return { voices: [], reason: String(e.message || e) }; })
          .then(function (server) {
            return {
              browser: rankVoices(lang).map(function (r) { return { name: r.name, lang: r.lang, tier: r.tier, score: r.score }; }),
              server: server,
              health: h
            };
          });
      });
    },

    /** A new cue. Whatever was speaking stops; `lang` may be omitted and set by push(). */
    begin: function (opts) {
      IAIVoice.cancel();
      gen++;
      // t0 is stamped by the first push(), not here: the number that matters is text-in to
      // audio-out, and begin() fires ~880 ms earlier, while the brain is still thinking.
      cue = { gen: gen, lang: (opts && opts.lang) || null, t0: 0, engine: "browser", firstAudio: 0, broken: false, pending: "" };
      return refreshHealth(false).then(function (h) {
        if (!cue || cue.gen !== gen) return;                  // cancelled while health was in flight
        cue.engine = h && h.provider === "elevenlabs" ? "elevenlabs" : "browser";
        emit({ type: "engine", engine: cue.engine, reason: (h && h.lastError) || null });
        if (cue.engine !== "elevenlabs") return;
        return send({ type: "begin", lang: cue.lang, voiceId: (opts && opts.voiceId) || undefined });
      });
    },

    /** One clause. Called the moment the brain closes one — never with the whole sentence. */
    push: function (text) {
      var t = (text || "").trim();
      if (!t || !/[\p{L}\p{N}]/u.test(t)) return;              // a lone "—" has nothing to say
      if (!cue) IAIVoice.begin({});
      if (!cue.t0) cue.t0 = performance.now();
      if (!cue.lang) cue.lang = guessLang(t);
      if (cue.engine === "elevenlabs" && !cue.broken) {
        cue.pending += (cue.pending ? " " : "") + t;
        // A trailing space is not cosmetic: the model uses it as the word boundary and will
        // otherwise glue the next clause onto this one's last word.
        send({ type: "push", text: t + " ", lang: cue.lang });
      } else {
        speakLocal(t, cue.lang);
      }
    },

    /** No more text for this cue. Audio keeps playing until it runs out. */
    end: function () {
      if (!cue) return;
      if (cue.engine === "elevenlabs" && !cue.broken) send({ type: "end" });
    },

    cancel: function () {
      gen++;
      cue = null;
      if (window.speechSynthesis) speechSynthesis.cancel();
      stopPcm();
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "cancel" }));
    },

    /** Override the automatic pick for one language — the test page's voice picker. */
    prefer: function (lang, name) {
      var r = rankVoices(lang).filter(function (v) { return v.name === name; })[0];
      if (r) chosen[lang] = r; else delete chosen[lang];
      return !!r;
    },

    /** Exposed for the test page and for a panel that wants to show the pick. */
    rank: rankVoices,
    _state: function () { return { health: health, cue: cue, engine: cue && cue.engine }; }
  };

  function guessLang(t) {
    return /[áéíóúñ¿¡]|\b(el|la|los|que|de|en|con|para|una|es|un|pero|porque|como|cuando)\b/i.test(t) ? "es-ES" : "en-US";
  }
  IAIVoice.guessLang = guessLang;

  window.IAIVoice = IAIVoice;
})();
