/*
 * Echo's live humanoid: the particle figure from the Mac control panel
 * (Echo Mac/renderer/humanoid-core.js), unchanged except for the phone
 * binding at the bottom. It reads body[data-status] for Echo's state and
 * assembles itself each time Home is opened (window.echoCore.replay()).
 */
(function () {
  "use strict";

  var TAU = Math.PI * 2;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  /* Table-driven sine. At this particle count the per-frame Math.sin calls
     alone would blow the frame budget. */
  var SIN_N = 8192, SIN_MASK = SIN_N - 1, SIN_K = SIN_N / TAU;
  var SIN_T = new Float32Array(SIN_N);
  for (var si = 0; si < SIN_N; si++) SIN_T[si] = Math.sin((si / SIN_N) * TAU);
  function fsin(x) { return SIN_T[(x * SIN_K) & SIN_MASK]; }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------
     Bust silhouette. Units: head half-height = 0.5, origin at head
     centre. hw(y) is the half-width of the body at that height.
  ----------------------------------------------------------------*/
  /* Y_TOP sits above the crown so the Gaussian below has zeros to blend
     into — ending the domain at the crown flattened it into a chopped top. */
  var Y_TOP = -0.60, Y_BOTTOM = 1.62;

  /* Measured off the reference: crown, temple, cheekbone, jaw angle, chin —
     an ellipse gives none of these, which is what made the edge read as a
     drawn line rather than a head. */
  var HEAD_PROFILE = [
    [-0.520, 0.000], [-0.508, 0.092], [-0.488, 0.156], [-0.455, 0.222],
    [-0.410, 0.276], [-0.350, 0.322], [-0.280, 0.352], [-0.200, 0.371],
    [-0.110, 0.381], [-0.020, 0.382], [0.060, 0.374], [0.140, 0.358],
    [0.210, 0.336], [0.275, 0.310], [0.335, 0.286], [0.390, 0.262],
    [0.440, 0.232], [0.490, 0.196], [0.530, 0.140], [0.562, 0.000]
  ];
  /* Neck, trapezius, deltoid. */
  var BODY_PROFILE = [
    [0.330, 0.200], [0.430, 0.207], [0.520, 0.218], [0.580, 0.236],
    [0.640, 0.268], [0.700, 0.326], [0.760, 0.412], [0.820, 0.522],
    [0.880, 0.650], [0.940, 0.788], [1.000, 0.920], [1.060, 1.038],
    [1.130, 1.142], [1.210, 1.226], [1.300, 1.282], [1.400, 1.318],
    [1.500, 1.338], [1.620, 1.354]
  ];

  /* Straight linear sampling — the curvature comes from the Gaussian pass
     below. Spline interpolation over these unevenly spaced knots is what
     kept breaking the skull into flats. */
  function profileAt(table, y) {
    var n = table.length;
    if (y <= table[0][0] || y >= table[n - 1][0]) return 0;
    var i = 1;
    while (i < n - 1 && y > table[i][0]) i++;
    var a = table[i - 1], b = table[i];
    return a[1] + (b[1] - a[1]) * ((y - a[0]) / (b[0] - a[0]));
  }

  var LUT_N = 768, LUT = new Float32Array(LUT_N);
  (function buildProfile() {
    for (var i = 0; i < LUT_N; i++) {
      var y = Y_TOP + (i / (LUT_N - 1)) * (Y_BOTTOM - Y_TOP);
      var hw = Math.max(profileAt(HEAD_PROFILE, y), profileAt(BODY_PROFILE, y));
      /* ears sit proud of the cheek line */
      if (y > -0.14 && y < 0.20) {
        var e = Math.exp(-Math.pow((y - 0.025) / 0.075, 2));
        hw += 0.042 * e;
      }
      /* squared: a dome apex is a cusp in width but a parabola in width²,
         so smoothing here rounds the crown instead of drawing a spike on it */
      LUT[i] = hw * hw;
    }
    var sigma = 7.5, rad = 20, kern = new Float32Array(rad * 2 + 1), sum = 0;
    for (var kk = -rad; kk <= rad; kk++) {
      var g = Math.exp(-(kk * kk) / (2 * sigma * sigma));
      kern[kk + rad] = g; sum += g;
    }
    for (var kn = 0; kn < kern.length; kn++) kern[kn] /= sum;
    var tmp = new Float32Array(LUT_N);
    for (var k2 = 0; k2 < LUT_N; k2++) {
      var acc = 0;
      for (var m = -rad; m <= rad; m++) {
        acc += LUT[clamp(k2 + m, 0, LUT_N - 1)] * kern[m + rad];
      }
      tmp[k2] = acc > 0 ? Math.sqrt(acc) : 0;
    }
    LUT.set(tmp);
    /* The blur smears a hairline width above the crown; left in, it draws a
       thin spike out of the top of the head. Cut it back to the first
       sample wide enough to be a real dome. */
    for (var z = 0; z < LUT_N && LUT[z] < 0.052; z++) LUT[z] = 0;
  })();

  function halfWidth(y) {
    var f = ((y - Y_TOP) / (Y_BOTTOM - Y_TOP)) * (LUT_N - 1);
    if (f <= 0 || f >= LUT_N - 1) return 0;
    var i = f | 0;
    return LUT[i] + (LUT[i + 1] - LUT[i]) * (f - i);
  }

  /* Figure buffer covers x ∈ [-1.62, 1.62], y ∈ [-1.02, 1.66]. Sized per
     stage: at this density a buffer that is too small merges the dots into
     a smooth glow instead of a particle field. */
  function figMetrics(figW) {
    var u = figW / 3.24;
    return { w: figW, h: Math.round(2.68 * u), u: u, ox: figW / 2, oy: 1.02 * u };
  }

  /* ---------------------------------------------------------------
     Point cloud: head scan rows + torso flow lines.
  ----------------------------------------------------------------*/
  function buildCloud() {
    var xs = [], ys = [], us = [], parts = [], phs = [], sx = [], sy = [], st = [], dz = [], sd = [], sm = [];
    var rnd = mulberry32(20260920);

    function push(x, y, u, part) {
      xs.push(x); ys.push(y); us.push(u); parts.push(part);
      phs.push(rnd() * TAU);
      var ang = rnd() * TAU, dist = 1.1 + rnd() * 1.9;
      sx.push(x + Math.cos(ang) * dist);
      sy.push(y + Math.sin(ang) * dist * 0.62);
      st.push(rnd());
      /* How far this point stands off the skull's axis, as if the head were
         an ellipsoid. Turning the head is then a real rotation of those
         depths rather than a slide: the face sweeps across while the
         silhouette, which sits at zero depth, stays put. */
      var d = 0;
      if (part === 0 && y < 0.58) {
        var q = 1 - (x / 0.385) * (x / 0.385) - (y / 0.62) * (y / 0.62);
        if (q > 0) d = Math.sqrt(q);
      }
      dz.push(d);

      /* Body shading and plating. Both are fixed in body space, so they are
         baked here and cost nothing per frame. Lit only at the rim, the
         torso read as a flat cut-out; this gives it a curved shell with a
         key light off the upper left, then cuts armour seams into it. */
      var shade = 0, seam = 0;
      if (part === 1 || part === 2) {
        var au = u < 0 ? -u : u;
        var nz = Math.sqrt(Math.max(0, 1 - au * au));
        var spec = Math.exp(-Math.pow((u + 0.25) / 0.42, 2));
        /* Wide range on purpose: a shallow gradient just reads as an evenly
           lit cut-out again. The right flank falls to about half the lit
           chest, which is what makes the shell look round. */
        shade = 0.26 + 0.80 * Math.pow(nz, 1.3) * (0.50 + 0.50 * spec) + 0.38 * Math.pow(au, 3.5);

        var dYoke = y - (0.86 + 0.09 * u * u);                    /* clavicle */
        var dPec = y - (1.21 - 0.10 * u * u);                     /* chest plate */
        var stern = y > 0.94 ? au * 0.55 : 9;                     /* sternum */
        var delt = y > 0.82 ? Math.abs(au - 0.64) * 0.5 : 9;      /* deltoid cap */
        seam = Math.max(
          Math.exp(-Math.pow(dYoke / 0.016, 2)),
          Math.exp(-Math.pow(dPec / 0.016, 2)),
          Math.exp(-Math.pow(stern / 0.016, 2)),
          Math.exp(-Math.pow(delt / 0.016, 2))
        );
        /* A lit lip on the upper side of each groove — the catch of light on
           a plate edge is what sells it as armour rather than a drawn line. */
        shade += 0.40 * Math.max(
          Math.exp(-Math.pow((dYoke + 0.028) / 0.013, 2)),
          Math.exp(-Math.pow((dPec + 0.028) / 0.013, 2))
        );
      }
      sd.push(shade); sm.push(seam);
    }

    /* Scan rows across the skull. They are not straight: in the reference
       they dome over the crown and sag into U-curves through the face, the
       way latitude lines sit on a head. Baked in, since the curve is fixed. */
    var ARC_K = 0.22, ARC_Y0 = -0.06;
    for (var y = Y_TOP + 0.008; y < 0.575; y += 0.0235) {
      var hw = halfWidth(y);
      if (hw <= 0.004) continue;
      var step = 0.0028;
      for (var x = -hw; x <= hw + 1e-6; x += step) {
        var u0 = x / hw;
        var arc = ARC_K * (y - ARC_Y0) * (1 - u0 * u0) * (hw / 0.385);
        push(x, y + arc, u0, 0);
      }
    }

    /* Flow lines down the body. The count thins where the body is narrow:
       a fixed count crushes all 72 lines into the neck and packs it solid,
       so lines are dropped to hold roughly even spacing everywhere. */
    var LINES = 72, TARGET_GAP = 0.017;
    for (var i = 0; i <= LINES; i++) {
      var u = -1 + (2 * i) / LINES;
      for (var yy = 0.315; yy < Y_BOTTOM; yy += 0.0050) {
        var w = halfWidth(yy);
        if (w <= 0.004) continue;
        var keep = Math.round(TARGET_GAP / ((2 * w) / LINES));
        if (keep > 1 && i % keep !== 0) continue;
        push(u * w, yy, u, yy < 0.80 ? 1 : 2);
      }
    }

    /* The edge itself is a dense band of particles, not a stroked path — a
       vector outline is what made the figure read as a diagram. */
    /* Stepped by arc length, not by scanline. The silhouette runs almost
       horizontally over the crown, so a fixed y-step spread those samples
       far apart in x and tore a gap in the outline at top centre. */
    var RIM_STEP = 0.0042, acc = RIM_STEP, pvx = 0, pvy = 0, havePrev = false;
    for (var ry = Y_TOP; ry < Y_BOTTOM; ry += 0.0012) {
      var rw = halfWidth(ry);
      if (rw <= 0.004) { havePrev = false; continue; }
      if (havePrev) acc += Math.sqrt((rw - pvx) * (rw - pvx) + (ry - pvy) * (ry - pvy));
      pvx = rw; pvy = ry; havePrev = true;
      if (acc < RIM_STEP) continue;
      acc = 0;
      for (var side = -1; side <= 1; side += 2) {
        for (var q = 0; q < 3; q++) {
          /* wider, bell-shaped scatter feathers the boundary — a tight
             jitter made the edge read as a hard cut, worst down the neck */
          var jit = (rnd() + rnd() + rnd() - 1.5) * 0.021;
          push(side * (rw + jit), ry, side, 3);
        }
      }
    }

    return {
      n: xs.length,
      x: Float32Array.from(xs), y: Float32Array.from(ys),
      u: Float32Array.from(us), part: Uint8Array.from(parts),
      ph: Float32Array.from(phs),
      sx: Float32Array.from(sx), sy: Float32Array.from(sy),
      st: Float32Array.from(st), dz: Float32Array.from(dz),
      sd: Float32Array.from(sd), sm: Float32Array.from(sm)
    };
  }

  /* Energy veins: one down the neck, branching into the chest. */
  function buildVeins() {
    var rnd = mulberry32(7714), veins = [];
    function trace(x0, y0, y1, drift, seedPhase) {
      var pts = [], x = x0;
      for (var y = y0; y < y1; y += 0.012) {
        x += (rnd() - 0.5) * 0.012 + drift * 0.012;
        var w = halfWidth(y);
        pts.push([clamp(x, -w * 0.9, w * 0.9), y]);
      }
      veins.push({ pts: pts, phase: seedPhase });
    }
    trace(0.0, 0.42, 1.30, 0, 0);
    trace(-0.02, 0.86, 1.34, -0.30, 0.35);
    trace(0.03, 0.90, 1.38, 0.34, 0.62);
    trace(-0.01, 1.02, 1.42, -0.62, 0.18);
    trace(0.02, 1.06, 1.46, 0.66, 0.80);
    return veins;
  }

  var CLOUD = buildCloud();
  var VEINS = buildVeins();
  /* Four times the points at the same per-point alpha would wash the figure
     out; this trades brightness back for density. */
  var DENSITY_GAIN = 1.55;

  /* ---------------------------------------------------------------
     Additive plotting into an ImageData buffer.
  ----------------------------------------------------------------*/
  function splat(d, w, h, x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return;
    var xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi;
    var i = (yi * w + xi) * 4;
    var w00 = (1 - fx) * (1 - fy) * a, w10 = fx * (1 - fy) * a;
    var w01 = (1 - fx) * fy * a, w11 = fx * fy * a;
    d[i] += r * w00; d[i + 1] += g * w00; d[i + 2] += b * w00; d[i + 3] += 255 * w00;
    d[i + 4] += r * w10; d[i + 5] += g * w10; d[i + 6] += b * w10; d[i + 7] += 255 * w10;
    var j = i + w * 4;
    d[j] += r * w01; d[j + 1] += g * w01; d[j + 2] += b * w01; d[j + 3] += 255 * w01;
    d[j + 4] += r * w11; d[j + 5] += g * w11; d[j + 6] += b * w11; d[j + 7] += 255 * w11;
  }

  /* ---------------------------------------------------------------
     Live state, read off the panel itself: body[data-status] and the
     --level voice amplitude the bridge already publishes.
  ----------------------------------------------------------------*/
  var shared = {
    status: "idle",
    expression: "attentive", expressionAt: 0,
    level: 0,
    assembleAt: performance.now(),
    /* where the head is looking, and where it wants to look: -1..1 on each
       axis, measured from the centre of the stage */
    gazeX: 0, gazeY: 0, wantX: 0, wantY: 0,
    /* Speaking on the phone: the figure bursts apart (ex 0 → 1), some of its
       particles spell the first words (ws 0 → 1, at `words` in figure units),
       and it gathers back together afterwards (ex → 0). */
    ex: 0, exTarget: 0, ws: 0, wsTarget: 0, words: null, wordsN: 0
  };

  var root = document.documentElement;

  function updateLevel(now, dt) {
    shared.status = String(document.body.dataset.status || "idle").toLowerCase();
    /* Inline style, not getComputedStyle — the bridge sets the variable
       there, and reading it this way costs no style recalculation. */
    var raw = parseFloat(root.style.getPropertyValue("--level"));
    var target = raw > 0 ? clamp(raw, 0, 1) : 0;

    /* While Echo SPEAKS, --level is always 0 and the mouth could never move.
       The only level the bridge sends is the microphone's (listener.on("level")
       in main.ts), and it reports 0 unless it is actively capturing — but
       capture is paused for the whole time Echo is talking, so `speakAmp` below
       was structurally pinned at zero and the talking animation never once ran.

       This is a VISUALISATION of speech, not a measurement of it: the player
       does not report its own output amplitude today. A real envelope would
       come from the RMS of the PCM in player.play() sampled against playedMs.
       A genuine level, if one ever arrives, still wins — this only fills in
       when there is no signal at all. */
    if (shared.status === "speaking" && target === 0) {
      var st = now / 1000;
      /* Speech-rate syllables (~4.5Hz) over a slower phrase envelope, with a
         third tone so the pattern does not read as a loop. */
      var syllable = 0.5 + 0.5 * fsin(st * 28.3);
      var phrase = 0.55 + 0.45 * fsin(st * 5.1 + 1.7);
      var jitter = 0.5 + 0.5 * fsin(st * 71.3 + 0.4);
      target = clamp(0.12 + syllable * phrase * 0.72 + jitter * 0.08, 0, 1);
    }
    /* The bridge throttles to one update per 80ms, so follow it rather than
       snapping, or the core steps instead of moving. */
    shared.level += (target - shared.level) * Math.min(1, dt * 0.014);
    if (shared.level < 0.0005) shared.level = 0;

    /* Follow the pointer with a little lag — snapping to it reads as a
       texture being dragged, not as something choosing to look. */
    /* Out in under a second; back together at the pace of the opening. */
    var exRate = shared.exTarget > shared.ex ? dt / 900 : dt / 2100;
    shared.ex = shared.exTarget > shared.ex ? Math.min(shared.exTarget, shared.ex + exRate) : Math.max(shared.exTarget, shared.ex - exRate);
    var wsRate = dt / 700;
    shared.ws = shared.wsTarget > shared.ws ? Math.min(shared.wsTarget, shared.ws + wsRate) : Math.max(shared.wsTarget, shared.ws - wsRate);
    if (shared.ws === 0 && shared.wsTarget === 0) { shared.words = null; shared.wordsN = 0; }

    var ease = Math.min(1, dt * 0.005);
    shared.gazeX += (shared.wantX - shared.gazeX) * ease;
    shared.gazeY += (shared.wantY - shared.gazeY) * ease;
  }

  /* ---------------------------------------------------------------
     Stage renderer.
  ----------------------------------------------------------------*/
  function createStage(canvas, opts) {
    var ctx = canvas.getContext("2d");
    var FG = figMetrics(opts.figW || 1200);
    var FIG_W = FG.w, FIG_H = FG.h, FIG_U = FG.u, FIG_OX = FG.ox, FIG_OY = FG.oy;
    var stride = opts.stride || 1;
    var strideGain = Math.sqrt(stride);
    var fig = document.createElement("canvas");
    fig.width = FIG_W; fig.height = FIG_H;
    var fctx = fig.getContext("2d");
    var img = fctx.createImageData(FIG_W, FIG_H);
    var data = img.data;

    var W = 0, H = 0, dpr = 1;
    var ringEl = document.createElement("canvas"), ringCtx = ringEl.getContext("2d");
    var GLOW_W = Math.round(FIG_W / 6), GLOW_H = Math.round(FIG_H / 6);
    var glowEl = document.createElement("canvas"), glowCtx = glowEl.getContext("2d");
    glowEl.width = GLOW_W; glowEl.height = GLOW_H;
    glowCtx.imageSmoothingQuality = "high";
    var sparks = [];
    var rnd = mulberry32(opts.seed || 991);
    /* Spray leaves the skull along its own normal, over the whole upper
       hemisphere — in the reference it hugs the sides of the head, not just
       the crown. */
    for (var i = 0; i < 520; i++) {
      sparks.push({
        a: (rnd() - 0.5) * 4.0, life: rnd(), speed: 0.3 + rnd() * 0.85,
        seed: rnd(), big: rnd() > 0.84, lat: 0.5 + rnd() * 0.9,
        vx: (rnd() - 0.5) * 0.36
      });
    }
    var rings = [];
    var visible = true;

    function resize() {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      dpr = Math.min(window.devicePixelRatio || 1, opts.dprCap || 2);
      W = Math.round(rect.width * dpr);
      H = Math.round(rect.height * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W; canvas.height = H;
        /* half-res: the rings are soft, and this layer is cleared and
           re-punched every frame */
        ringEl.width = Math.max(2, W >> 1); ringEl.height = Math.max(2, H >> 1);
      }
    }

    var io = new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; }, { threshold: 0.02 });
    io.observe(canvas);

    function statusTint(status) {
      if (status === "error") return { rim: [255, 120, 104], deep: [176, 58, 54], core: [255, 78, 52], hot: [255, 178, 140] };
      if (status === "asleep") return { rim: [96, 168, 200], deep: [30, 90, 124], core: [150, 118, 84], hot: [198, 168, 126] };
      if (shared.expression === "curious") return { rim: [206, 186, 255], deep: [106, 88, 210], core: [169, 139, 255], hot: [242, 229, 255] };
      if (shared.expression === "celebrate" || shared.expression === "encouraging") return { rim: [156, 255, 211], deep: [38, 180, 135], core: [62, 230, 176], hot: [220, 255, 230] };
      return { rim: [168, 244, 255], deep: [38, 162, 216], core: [255, 126, 24], hot: [255, 232, 168] };
    }

    var n0 = CLOUD.n;
    function draw(now) {
      if (!W || !H) return;
      var t = now * 0.001;
      var status = shared.status;
      var reactionAge = Math.max(0, (now - shared.expressionAt) / 1000);
      var reaction = reduceMotion ? 0 : Math.max(0, 1 - reactionAge / 12);
      if (reactionAge > 12 && shared.expression !== "attentive") { shared.expression = "attentive"; document.body.dataset.expression = "attentive"; }
      var level = shared.level;
      var tint = statusTint(status);

      /* assembly progress */
      var assembleMs = now - shared.assembleAt;
      var assemble = reduceMotion ? 1 : clamp(assembleMs / 2100, 0, 1);

      /* per-state dials */
      var coreAmp, coreR, wobble, sparkRate, dim;
      if (status === "speaking") { coreAmp = 0.85 + level * 0.9; coreR = 1 + level * 0.55; wobble = 1 + level * 2.6; sparkRate = 1.1; dim = 1; }
      else if (status === "thinking") { coreAmp = 1.0; coreR = 0.96; wobble = 0.85; sparkRate = 1.35; dim = 1; }
      else if (status === "acting") { coreAmp = 1.05; coreR = 0.98; wobble = 1.1; sparkRate = 1.5; dim = 1; }
      else if (status === "listening") { coreAmp = 0.52 + level * 0.5; coreR = 0.82; wobble = 0.5 + level * 1.4; sparkRate = 0.8; dim = 1; }
      else if (status === "error") { coreAmp = 0.8; coreR = 0.8; wobble = 0.2; sparkRate = 0.35; dim = 0.92; }
      else if (status === "asleep") { coreAmp = 0.16; coreR = 0.6; wobble = 0.12; sparkRate = 0.15; dim = 0.42; }
      else { coreAmp = 0.42; coreR = 0.8; wobble = 0.34; sparkRate = 0.55; dim = 0.9; }
      coreAmp *= assemble; dim *= 0.35 + 0.65 * assemble;
      /* Burst: the glass, veins and sparks belong to the figure, so they go
         with it; the scattered field stays bright. */
      var ex = reduceMotion ? 0 : shared.ex;
      var exE = ex * ex * (3 - 2 * ex);
      var ws = shared.ws * shared.ws * (3 - 2 * shared.ws);
      var words = shared.words, wordsN = shared.wordsN;
      var perWord = words ? Math.max(1, Math.floor(n0 / stride / Math.max(1, wordsN))) : 0;
      coreAmp *= 1 - exE;

      var breath = 1 + Math.sin(t * 0.78) * 0.006;
      var speakAmp = status === "speaking" ? level : 0;
      var headBob = -(0.014 * speakAmp) + fsin(t * 1.7) * 0.007 * speakAmp;
      if (shared.expression === "encouraging" || shared.expression === "celebrate") headBob += fsin(reactionAge * 4) * 0.028 * reaction;
      var headRoll = shared.expression === "curious" ? 0.11 * reaction : shared.expression === "thoughtful" ? -0.065 * reaction : 0;
      if (shared.expression === "celebrate") { coreAmp += 0.35 * reaction; sparkRate += reaction; }
      var coreCY = -0.02;
      var visorRX = 0.320 * (0.95 + 0.05 * coreR), visorH = 0.126 * coreR;

      /* ---- particle buffer ---- */
      data.fill(0);
      var n = n0, cx = CLOUD.x, cy = CLOUD.y, cu = CLOUD.u, cp = CLOUD.part,
          cph = CLOUD.ph, csx = CLOUD.sx, csy = CLOUD.sy, cst = CLOUD.st, cdz = CLOUD.dz, csd = CLOUD.sd, csm = CLOUD.sm;

      var yaw = shared.gazeX * 0.52, pitch = shared.gazeY * 0.30;
      var sinYaw = fsin(yaw), cosYaw = fsin(yaw + 1.5708), RZ = 0.42;
      var leanX = shared.gazeX * 0.052, leanY = shared.gazeY * 0.030;

      for (var i = 0; i < n; i += stride) {
        var px = cx[i], py = cy[i], u = cu[i], part = cp[i], ph = cph[i];

        /* motion */
        if (part === 0) {
          py += fsin(px * 8.5 + t * 1.3 + ph) * 0.0035 + fsin(t * 0.7 + ph) * 0.0016;
          px += fsin(py * 6.2 - t * 0.9 + ph) * 0.0016;
        } else {
          px += fsin(py * 5.6 + t * 0.85 + ph) * 0.0052 * (1 - Math.abs(u) * 0.55);
          py += fsin(t * 0.6 + ph) * 0.0016;
        }

        /* Speaking works the lower face — jaw drops, the mouth zone ripples,
           the head rides the syllables. Applied to the rim too, or the
           outline would peel away from the surface it wraps. */
        if (speakAmp > 0.001 && (part === 0 || part === 3) && py < 0.58) {
          var mz = smoothstep(0.06, 0.30, py) * (1 - smoothstep(0.40, 0.54, py));
          if (mz > 0) {
            py += speakAmp * 0.078 * mz + fsin(px * 26 - t * 9.0) * 0.016 * mz * speakAmp;
            px *= 1 - 0.055 * speakAmp * mz;
          }
        }
        if ((part === 0 || part === 3) && py < 0.58) py += headBob * (1 - smoothstep(0.30, 0.56, py));
        px *= breath; py = py * breath;

        /* Vision Pro kidney: one unbroken superelliptical top edge, ends
           that sweep down, and the nose relief notched up into the bottom
           edge only — the top never breaks. */
        var inCore = 0, lensGlow = 1, visorEdge = 0;
        if (part === 0) {
          var ax = px < 0 ? -px : px;
          var xn = ax / visorRX;
          if (xn < 1) {
            var s = Math.sqrt(1 - Math.pow(xn, 2.8));
            var centre = coreCY + 0.030 * xn * xn;
            var relief = 0.60 * Math.exp(-Math.pow(ax / 0.150, 2));
            var yTop = centre - visorH * s;
            var yBot = centre + visorH * s * (1 - relief);
            var span = (yBot - yTop) * 0.5;
            if (span > 1e-4 && py > yTop && py < yBot) {
              var dv = Math.abs(py - (yTop + yBot) * 0.5) / span;
              inCore = Math.pow(1 - dv, 0.55);
              visorEdge = Math.pow(dv, 7);
              lensGlow = 0.70 + 0.30 * Math.exp(-Math.pow((ax - 0.170) / 0.120, 2));
              py += fsin(px * 21 - t * 4.6) * 0.012 * inCore * wobble;
            }
          }
        }

        /* Look toward the pointer. Applied after the visor test so the glass
           is found in the face's own frame and then turns with it, rather
           than staying pinned to the middle of the stage. */
        if ((part === 0 || part === 3) && py < 0.58) {
          var hold = 1 - smoothstep(0.30, 0.56, py);
          var z = cdz[i] * RZ;
          px = (px * cosYaw + z * sinYaw) + leanX * hold;
          py += z * pitch + leanY * hold;
          if (headRoll) { var hx = px; px -= py * headRoll * hold; py += hx * headRoll * hold; }
        }

        /* assembly */
        var ax = px, ay = py;
        if (assemble < 1) {
          var local = clamp((assemble - cst[i] * 0.42) / 0.58, 0, 1);
          var e = 1 - Math.pow(1 - local, 3);
          ax = lerp(csx[i], px, e); ay = lerp(csy[i], py, e);
        }

        /* Burst: each point flies out to its own place in a loose cloud around
           the figure (staggered like the opening), drifting while it hangs
           there; the points chosen to spell take their place in the words. */
        var wordPt = false;
        if (exE > 0.001) {
          var bx = csx[i] * 0.34 + fsin(t * 0.37 + ph) * 0.05;
          var by = csy[i] * 0.34 + 0.12 + fsin(t * 0.29 + ph * 1.7) * 0.05;
          if (words && ws > 0.001) {
            var q = (i / stride) | 0;
            if (q % perWord === 0) {
              var j = (q / perWord) | 0;
              if (j < wordsN) {
                var wl = clamp((ws - cst[i] * 0.3) / 0.7, 0, 1);
                bx = lerp(bx, words[j * 2] + fsin(t * 2.1 + ph) * 0.004, wl);
                by = lerp(by, words[j * 2 + 1] + fsin(t * 1.7 + ph) * 0.004, wl);
                wordPt = wl > 0.5;
              }
            }
          }
          var le = clamp((exE - cst[i] * 0.35) / 0.65, 0, 1);
          le = 1 - Math.pow(1 - le, 3);
          ax = lerp(ax, bx, le); ay = lerp(ay, by, le);
        }

        var sxp = FIG_OX + ax * FIG_U;
        var syp = FIG_OY + ay * FIG_U;

        /* colour */
        var edge = Math.pow(Math.abs(u), 2.4);
        var armour = part === 1 || part === 2;
        var bright = armour ? csd[i] : 0.30 + 0.70 * edge;
        var r = lerp(tint.deep[0], tint.rim[0], bright);
        var g = lerp(tint.deep[1], tint.rim[1], bright);
        var b = lerp(tint.deep[2], tint.rim[2], bright);
        /* grain from the point's own phase keeps the field from reading as a
           printed grid; twinkle is what makes the field feel alive rather
           than a static stipple */
        var grain = 0.70 + 0.30 * fsin(ph * 7.31 + t * 0.6);
        var twinkle = 0.74 + 0.26 * fsin(ph * 13.7 + t * 3.1);
        /* Armour keeps far less of a floor than the head: the shading only
           reads as volume if the unlit side is allowed to go genuinely dark. */
        var a = (armour ? 0.10 + 0.90 * bright : 0.42 + 0.58 * bright) *
                dim * grain * twinkle * DENSITY_GAIN * strideGain;
        if (part === 3) a *= 1.18;
        /* plate seams read as grooves: the field thins where panels meet */
        else if (armour) a *= 1 - 0.88 * csm[i];

        if (inCore > 0 && coreAmp > 0.02) {
          var band = 0.34 + 0.66 * Math.pow(0.5 + 0.5 * Math.sin(py * 132 - t * 3.2), 1.6);
          var heat = clamp(inCore * coreAmp * lensGlow * (0.30 + 0.85 * band) * 1.45, 0, 1.3);
          var hot = clamp((heat - 0.62) / 0.5, 0, 1);
          r = lerp(r, lerp(tint.core[0], tint.hot[0], hot), clamp(heat * 1.35, 0, 1));
          g = lerp(g, lerp(tint.core[1], tint.hot[1], hot), clamp(heat * 1.35, 0, 1));
          b = lerp(b, lerp(tint.core[2], tint.hot[2], hot), clamp(heat * 1.35, 0, 1));
          /* the band also gates alpha, so the core reads as stacked
             waveform bars rather than one smooth blob */
          a = clamp(a + heat * 0.72, 0, 1) * (0.30 + 0.70 * band);
          /* bright lip around the glass, so it reads as a panel with an
             edge rather than a patch of glow */
          var eg = visorEdge * coreAmp;
          if (eg > 0.02) {
            r = lerp(r, 255, eg * 0.85);
            g = lerp(g, 238, eg * 0.85);
            b = lerp(b, 196, eg * 0.85);
            a = clamp(a + eg * 0.6, 0, 1);
          }
        }

        /* fade the bottom crop */
        if (py > 1.30) a *= clamp((1.62 - py) / 0.32, 1 - exE, 1);
        if (exE > 0.001) {
          if (wordPt) { a = Math.max(a, 0.95) * 1.25; r = lerp(r, 230, 0.6); g = lerp(g, 252, 0.6); b = lerp(b, 255, 0.6); }
          else a *= 1 - 0.38 * exE * (words ? ws : 0.4);
        }

        if (a > 0.01) {
          splat(data, FIG_W, FIG_H, sxp, syp, r, g, b, a);
          /* a scatter of fatter dots — the reference field is not one grain size */
          if (ph > 5.98) splat(data, FIG_W, FIG_H, sxp + 1.15, syp + 0.55, r, g, b, a * 0.85);
        }
      }

      /* ---- veins ---- */
      if (coreAmp > 0.05) {
        for (var v = 0; v < VEINS.length; v++) {
          var vein = VEINS[v], pts = vein.pts;
          for (var k = 0; k < pts.length; k++) {
            var vp = pts[k];
            var travel = (t * 0.55 + vein.phase + k / pts.length) % 1;
            var pulse = Math.pow(1 - Math.abs(((k / pts.length) - travel + 1) % 1 - 0.0) , 8);
            var vb = (0.22 + 0.78 * pulse) * coreAmp * assemble * (0.6 + level * 0.9) * (1 - exE);
            var vy2 = vp[1] * breath;
            if (vy2 > 1.30) vb *= clamp((1.58 - vy2) / 0.3, 0, 1);
            splat(data, FIG_W, FIG_H, FIG_OX + vp[0] * breath * FIG_U, FIG_OY + vy2 * FIG_U,
                  tint.core[0], tint.core[1] + 40 * pulse, tint.core[2] + 60 * pulse, clamp(vb * 0.85, 0, 1));
          }
        }
      }

      /* ---- crown sparks ---- */
      for (var s = 0; s < sparks.length; s++) {
        var sp = sparks[s];
        sp.life += 0.0038 * sp.speed * sparkRate * (reduceMotion ? 0 : 1);
        if (sp.life > 1) {
          sp.life = 0; sp.a = (Math.random() - 0.5) * 4.0;
          sp.seed = Math.random(); sp.big = Math.random() > 0.84;
          sp.vx = (Math.random() - 0.5) * 0.36;
        }
        /* lateral drift as they rise — pure radial escape made every
           particle near the crown climb the same vertical line */
        var out = sp.life * 0.26 * sp.lat;
        var sxs = (0.385 + out) * fsin(sp.a) + sp.vx * sp.life;
        var sys = -(0.53 + out) * fsin(sp.a + 1.5708) - sp.life * 0.06;
        var sa = Math.pow(1 - sp.life, 1.6) * (0.55 + sp.seed * 0.85) * dim * assemble * (1 - exE);
        var fx = FIG_OX + sxs * FIG_U, fy = FIG_OY + sys * FIG_U;
        splat(data, FIG_W, FIG_H, fx, fy, tint.rim[0], tint.rim[1], tint.rim[2], sa);
        if (sp.big) {
          splat(data, FIG_W, FIG_H, fx + 1.2, fy, tint.rim[0], tint.rim[1], tint.rim[2], sa * 0.9);
          splat(data, FIG_W, FIG_H, fx, fy + 1.2, tint.rim[0], tint.rim[1], tint.rim[2], sa * 0.9);
        }
      }

      fctx.putImageData(img, 0, 0);

      /* ---- silhouette rim ---- */
      /* ---- composite ---- */
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, W, H);

      var unit = Math.min(W * (opts.unitW || 0.231), H * (opts.unitH || 0.46));
      var ox = W * (opts.originX || 0.5), oy = H * (opts.originY || 0.33);
      var dw = 3.24 * unit, dh = (FIG_H / FIG_U) * unit;
      var dx0 = ox - 1.62 * unit, dy0 = oy - 1.02 * unit;

      /* Sonar rings, laid down before the figure so they always pass behind
         it. Every awake state carries them; only the cadence changes. */
      var ring = null;
      if (status === "listening") ring = { n: 6, speed: 0.24, inward: false, a: 0.30 + level * 0.26 };
      else if (status === "thinking") ring = { n: 4, speed: 0.30, inward: true, a: 0.23 };
      /* acting used to carry a scan sweep; the faster inward cadence is what
         separates it from thinking now */
      else if (status === "acting") ring = { n: 5, speed: 0.46, inward: true, a: 0.26 };
      else if (status === "speaking") ring = { n: 5, speed: 0.32, inward: false, a: 0.18 + level * 0.30 };
      else if (status === "idle") ring = { n: 3, speed: 0.10, inward: false, a: 0.12 };
      else if (status === "error") ring = { n: 2, speed: 0.07, inward: false, a: 0.11 };

      if (!reduceMotion && ring && assemble > 0.8 && exE < 0.05) {
        var S = 0.5, rw2 = ringEl.width, rh2 = ringEl.height;
        ringCtx.setTransform(1, 0, 0, 1, 0, 0);
        ringCtx.clearRect(0, 0, rw2, rh2);
        ringCtx.save();
        ringCtx.scale(S, S);
        ringCtx.globalCompositeOperation = "source-over";

        var inward = ring.inward, count = ring.n;
        for (var q = 0; q < count; q++) {
          var prog = ((t * ring.speed + q / count) % 1);
          var rr = (inward ? (1.38 - prog * 0.86) : (0.46 + prog * 0.98)) * unit;
          /* a pressure wave loses energy as it spreads: the front thins and
             dims with radius, and drags a soft wake behind it */
          var spread = inward ? Math.sin(prog * Math.PI) : Math.pow(1 - prog, 1.5);
          var alpha = spread * ring.a * assemble;
          if (alpha < 0.008) continue;
          var rgb = tint.rim[0] + "," + tint.rim[1] + "," + tint.rim[2];

          ringCtx.strokeStyle = "rgba(" + rgb + "," + (alpha * 0.22).toFixed(3) + ")";
          ringCtx.lineWidth = 10 * dpr;
          ringCtx.beginPath();
          ringCtx.arc(ox, oy, Math.max(1, rr - 5 * dpr), 0, TAU);
          ringCtx.stroke();

          ringCtx.strokeStyle = "rgba(" + rgb + "," + alpha.toFixed(3) + ")";
          ringCtx.lineWidth = Math.max(0.8, 1.6 * dpr * (1 - prog * 0.5));
          ringCtx.beginPath();
          ringCtx.arc(ox, oy, rr, 0, TAU);
          ringCtx.stroke();
        }

        /* Cut the body out of the ring layer. The figure composites
           additively and so can never hide anything — without this punch the
           rings show straight through it and read as being in front. */
        ringCtx.globalCompositeOperation = "destination-out";
        ringCtx.fillStyle = "#000";
        ringCtx.beginPath();
        var mStarted = false;
        for (var my = Y_TOP; my <= Y_BOTTOM; my += 0.02) {
          var mw = halfWidth(my) * breath;
          if (mw <= 0.004) continue;
          var mX = ox + mw * unit, mY = oy + my * breath * unit;
          if (!mStarted) { ringCtx.moveTo(mX, mY); mStarted = true; } else ringCtx.lineTo(mX, mY);
        }
        for (var my2 = Y_BOTTOM; my2 >= Y_TOP; my2 -= 0.02) {
          var mw2 = halfWidth(my2) * breath;
          if (mw2 <= 0.004) continue;
          ringCtx.lineTo(ox - mw2 * unit, oy + my2 * breath * unit);
        }
        ringCtx.closePath();
        ringCtx.fill();
        ringCtx.restore();

        ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(ringEl, 0, 0, W, H);
      }

      /* Bloom by downscale-then-upscale rather than a canvas blur filter.
         Two real gaussians over a buffer this size cost more than
         everything else in the frame put together, and the bilinear
         round-trip is visually equivalent for a glow this soft. */
      glowCtx.globalCompositeOperation = "copy";
      glowCtx.drawImage(fig, 0, 0, GLOW_W, GLOW_H);

      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.92 + level * 0.3;
      ctx.drawImage(glowEl, dx0, dy0, dw, dh);
      ctx.globalAlpha = 1;
      ctx.drawImage(fig, dx0, dy0, dw, dh);
      ctx.drawImage(fig, dx0, dy0, dw, dh);

      /* core bloom */
      /* Bloom follows the visor: one lobe over each lens, flattened to the
         band's aspect, with the particles carrying the bridge between. */
      if (coreAmp > 0.03) {
        var ia = clamp(coreAmp * (0.24 + level * 0.44), 0, 0.72);
        /* The glass rides on the face, so its bloom has to take the same
           rotation the particles took — and the lenses foreshorten as the
           head turns away. */
        var gx = ox + (RZ * sinYaw + leanX) * unit;
        var gy = oy + (coreCY + RZ * pitch + leanY) * unit;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        /* one bloom for the whole panel, flattened to the glass */
        ctx.save();
        ctx.translate(gx, gy);
        ctx.scale(1, 0.42);
        var pr = 0.42 * unit * (1.2 + level * 0.45);
        var gp = ctx.createRadialGradient(0, 0, 0, 0, 0, pr);
        gp.addColorStop(0, "rgba(" + tint.core[0] + "," + tint.core[1] + "," + tint.core[2] + "," + (ia * 0.72).toFixed(3) + ")");
        gp.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = gp;
        ctx.fillRect(-pr, -pr, pr * 2, pr * 2);
        ctx.restore();
        /* two soft hotspots where the eyes sit behind the glass */
        var lr = 0.165 * unit * (1.35 + level * 0.6);
        for (var lens = -1; lens <= 1; lens += 2) {
          ctx.save();
          ctx.translate(gx + lens * 0.170 * cosYaw * unit, gy + 0.006 * unit);
          ctx.scale(1, 0.58);
          var grad = ctx.createRadialGradient(0, 0, 0, 0, 0, lr);
          grad.addColorStop(0, "rgba(" + tint.hot[0] + "," + tint.hot[1] + "," + tint.hot[2] + "," + (ia * 0.9).toFixed(3) + ")");
          grad.addColorStop(0.42, "rgba(" + tint.core[0] + "," + tint.core[1] + "," + tint.core[2] + "," + (ia * 0.38).toFixed(3) + ")");
          grad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(-lr, -lr, lr * 2, lr * 2);
          ctx.restore();
        }
        ctx.restore();
      }

      ctx.globalCompositeOperation = "source-over";
    }

    return {
      resize: resize,
      draw: draw,
      get visible() { return visible; }
    };
  }


  /* ---------------------------------------------------------------
     Phone binding.
  ----------------------------------------------------------------*/
  var canvas = document.getElementById("core-canvas");
  if (!canvas) return;

  /* Framed for a phone: the stage is the space between the header and the
     status pill, and the canvas runs past it on both ends, so the crown sits
     just under the header and the shoulders fade out behind the controls. */
  var stage = createStage(canvas, {
    unitW: 0.62, unitH: 0.43, originX: 0.5, originY: 0.352, seed: 42,
    figW: 720, stride: 2, dprCap: 2
  });
  var chatCanvas = document.getElementById("chat-core-canvas");
  var chatStage = chatCanvas ? createStage(chatCanvas, { figW: 180, stride: 12, dprCap: 2, unitW: 0.53, unitH: 0.48, originY: 0.32, seed: 42 }) : null;

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () { stage.resize(); if (reduceMotion) stage.draw(performance.now()); }).observe(canvas);
    if (chatStage) new ResizeObserver(function () { chatStage.resize(); chatStage.draw(performance.now()); }).observe(chatCanvas);
  } else {
    window.addEventListener("resize", function () { stage.resize(); if (reduceMotion) stage.draw(performance.now()); });
  }
  stage.resize();

  /* Gaze follows a finger dragged across Home, and turns back to face you
     when it lifts. */
  function look(x, y) {
    var box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    shared.wantX = clamp((x - (box.left + box.width * 0.5)) / (box.width * 0.9), -1, 1);
    shared.wantY = clamp((y - (box.top + box.height * 0.36)) / (box.height * 1.1), -1, 1);
  }
  function front() { shared.wantX = 0; shared.wantY = 0; }
  window.addEventListener("touchmove", function (e) { if (e.touches[0]) look(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  window.addEventListener("touchend", front, { passive: true });
  window.addEventListener("touchcancel", front, { passive: true });
  window.addEventListener("mousemove", function (e) { look(e.clientX, e.clientY); }, { passive: true });
  document.addEventListener("mouseleave", front);

  /* Words as points in figure units: drawn on a scratch canvas over the
     head's area (one or two lines, as large as fits) and sampled on a grid. */
  function wordPoints(text) {
    var PX = 400, X0 = -0.86, X1 = 0.86, Y0 = -0.62, Y1 = 0.42;
    var c = document.createElement("canvas");
    c.width = Math.round((X1 - X0) * PX); c.height = Math.round((Y1 - Y0) * PX);
    var g = c.getContext("2d");
    var font = function (sz) { return "800 " + sz + "px -apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"; };
    var fit = function (lines) {
      for (var sz = 170; sz >= 56; sz -= 6) {
        g.font = font(sz);
        var ok = sz * 1.1 * lines.length <= c.height * 0.92;
        for (var k = 0; ok && k < lines.length; k++) ok = g.measureText(lines[k]).width <= c.width * 0.94;
        if (ok) return sz;
      }
      return 0;
    };
    var words = String(text).trim().split(/\s+/).slice(0, 4);
    var lines = [words.join(" ")];
    var size = fit(lines);
    if (!size && words.length > 1) {
      var mid = Math.ceil(words.length / 2);
      lines = [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
      size = fit(lines);
    }
    if (!size) { lines = [words[0].slice(0, 12)]; size = fit(lines) || 56; }
    g.font = font(size);
    g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "#fff";
    for (var li = 0; li < lines.length; li++) g.fillText(lines[li], c.width / 2, c.height / 2 + (li - (lines.length - 1) / 2) * size * 1.08);
    var img = g.getImageData(0, 0, c.width, c.height).data;
    var step = Math.max(3, Math.round(size / 26)), pts = [];
    for (var y = 0; y < c.height; y += step) {
      for (var x = 0; x < c.width; x += step) {
        if (img[(y * c.width + x) * 4 + 3] > 140) pts.push(X0 + x / PX, Y0 + y / PX);
      }
    }
    return Float32Array.from(pts);
  }

  var bootAt = performance.now();
  window.echoCore = {
    react: function (expression) {
      if (["attentive", "curious", "thoughtful", "encouraging", "celebrate"].indexOf(expression) < 0) expression = "attentive";
      shared.expression = expression; shared.expressionAt = performance.now(); document.body.dataset.expression = expression;
      if (chatStage) { chatStage.resize(); updateLevel(performance.now(), 16); chatStage.draw(performance.now()); }
      if (reduceMotion) { stage.draw(performance.now()); }
    },
    avatar: function () { if (chatStage) { chatStage.resize(); updateLevel(performance.now(), 16); chatStage.draw(performance.now()); } },
    /* Play the assembly again: the particles gather into the figure. */
    replay: function () { if (!reduceMotion) shared.assembleAt = performance.now(); front(); stage.resize(); if (reduceMotion) { updateLevel(performance.now(), 16); stage.draw(performance.now()); } },
    /* Burst apart while Echo speaks on the phone; false gathers it back. */
    burst: function (on) { shared.exTarget = on ? 1 : 0; if (!on) shared.wsTarget = 0; },
    /* Spell a few words with the burst's particles; null lets them go. */
    spell: function (text) {
      if (!text) { shared.wsTarget = 0; return; }
      var pts = wordPoints(text);
      if (!pts.length) return;
      shared.words = pts; shared.wordsN = pts.length / 2; shared.ws = 0; shared.wsTarget = 1;
    }
  };
  updateLevel(bootAt, 16);
  stage.draw(bootAt);

  if (reduceMotion) return;

  /* 30 fps while it moves; nothing at all while Home is hidden or the app is
     in the background, so it costs no battery anywhere else. */
  var FRAME_MS = 1000 / 30;
  var last = bootAt, nextPaintAt = 0, lastAvatar = "";

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || (!stage.visible && !(chatStage && chatStage.visible))) return;
    if (now < nextPaintAt) return;
    nextPaintAt = now + FRAME_MS;
    var dt = Math.min(now - last, 50);
    last = now;
    updateLevel(now, dt);
    if (stage.visible) stage.draw(now);
    var avatarState = shared.status + ":" + shared.expression;
    if (chatStage && chatStage.visible && (shared.status !== "idle" || shared.expression !== "attentive" || avatarState !== lastAvatar || now - shared.assembleAt < 2100)) {
      chatStage.draw(now); lastAvatar = avatarState;
    }
  }
  requestAnimationFrame(frame);
})();
