/**
 * UnitStatusFx — the mobile-unit counterpart to BuildingStatusFx: a small
 * "under attack" marker over any unit something is currently resolved to be
 * attacking. Same honest-signal reasoning as buildings (see BuildingStatusFx's
 * header) — a replay records no hit points, so this says "this is being hit
 * right now" and nothing about how much damage, because the replay doesn't
 * know either.
 *
 * Buildings are static, so BuildingStatusFx sets sprite positions once.
 * Units move, so this pools a handful of sprites and repositions/shows/hides
 * them each frame against whichever uuids are currently both attacked and
 * alive — most frames only a few units are actually mid-fight.
 */
(function () {
  const SPRITE_WU = 90;         // smaller than the building marker (150) — units are smaller
  const Y_OFFSET = 170;         // above a typical unit's head; not model-height-exact, decorative
  const TEX_PX = 128;

  const PLAQUE = 'rgba(18, 16, 14, 0.88)';
  const PLAQUE_EDGE = 'rgba(0, 0, 0, 0.95)';
  const PLAQUE_RIM = 'rgba(214, 198, 168, 0.55)';
  const MARK_ATTACK = '#d8b46a';   // same bronze as the building marker

  // Same plaque + crossed-swords glyph as BuildingStatusFx, kept local rather
  // than shared across the two small files (matches how this codebase's other
  // per-effect modules each own their own drawing code).
  function drawPlaque (ctx, s) {
    const pad = s * 0.06, r = s * 0.18;
    const x = pad, y = pad, w = s - pad * 2, h = s - pad * 2;
    const trace = (inset) => {
      const xx = x + inset, yy = y + inset;
      const ww = w - inset * 2, hh = h - inset * 2;
      const rr = Math.max(1, r - inset);
      ctx.beginPath();
      ctx.moveTo(xx + rr, yy);
      ctx.lineTo(xx + ww - rr, yy);
      ctx.quadraticCurveTo(xx + ww, yy, xx + ww, yy + rr);
      ctx.lineTo(xx + ww, yy + hh - rr);
      ctx.quadraticCurveTo(xx + ww, yy + hh, xx + ww - rr, yy + hh);
      ctx.lineTo(xx + rr, yy + hh);
      ctx.quadraticCurveTo(xx, yy + hh, xx, yy + hh - rr);
      ctx.lineTo(xx, yy + rr);
      ctx.quadraticCurveTo(xx, yy, xx + rr, yy);
      ctx.closePath();
    };
    trace(0);
    ctx.fillStyle = PLAQUE;
    ctx.fill();
    ctx.strokeStyle = PLAQUE_EDGE;
    ctx.lineWidth = s * 0.055;
    ctx.stroke();
    trace(s * 0.045);
    ctx.strokeStyle = PLAQUE_RIM;
    ctx.lineWidth = s * 0.02;
    ctx.stroke();
  }

  function drawSword (ctx, s, color) {
    const bladeW = s * 0.10, bladeL = s * 0.42;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-bladeW / 2, -bladeL * 0.55);
    ctx.lineTo(bladeW / 2, -bladeL * 0.55);
    ctx.lineTo(bladeW / 2, bladeL * 0.30);
    ctx.lineTo(0, bladeL * 0.46);
    ctx.lineTo(-bladeW / 2, bladeL * 0.30);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(-s * 0.15, -bladeL * 0.62, s * 0.30, s * 0.055);
    ctx.fillRect(-bladeW * 0.34, -bladeL * 0.86, bladeW * 0.68, bladeL * 0.26);
  }

  function makeAttackTexture () {
    const c = document.createElement('canvas');
    c.width = c.height = TEX_PX;
    const ctx = c.getContext('2d');
    drawPlaque(ctx, TEX_PX);
    ctx.save();
    ctx.translate(TEX_PX / 2, TEX_PX / 2);
    ctx.rotate(Math.PI * 0.22);
    drawSword(ctx, TEX_PX, MARK_ATTACK);
    ctx.rotate(-Math.PI * 0.44);
    drawSword(ctx, TEX_PX, MARK_ATTACK);
    ctx.restore();
    return new THREE.CanvasTexture(c);
  }

  class UnitStatusFx {
    constructor (threeRenderer, viewer) {
      this.threeRenderer = threeRenderer;
      this.viewer = viewer;
      this._tex = null;
      this._pool = [];     // Sprite[]
      this._used = 0;      // how many pool entries are shown this frame
      this._enabled = true;
      this._unitsByUuid = null;
    }

    setup (players) {
      this.dispose();
      if (!players || !players.length) return;
      if (typeof THREE === 'undefined' || !this.threeRenderer || !this.threeRenderer.scene) return;

      this._tex = makeAttackTexture();
      this._unitsByUuid = new Map();
      for (const player of players) {
        for (const unit of (player.units || [])) {
          if (unit.isBuilding || !unit.uuid) continue;
          this._unitsByUuid.set(unit.uuid, unit);
        }
      }
    }

    _spriteAt (i) {
      let sp = this._pool[i];
      if (!sp) {
        const mat = new THREE.SpriteMaterial({
          map: this._tex, transparent: true, depthTest: false, opacity: 0.95
        });
        sp = new THREE.Sprite(mat);
        sp.scale.set(SPRITE_WU, SPRITE_WU, 1);
        sp.renderOrder = 1001;
        sp.visible = false;
        this.threeRenderer.scene.add(sp);
        this._pool[i] = sp;
      }
      return sp;
    }

    setEnabled (on) {
      this._enabled = !!on;
      if (!this._enabled) this._hideAll();
    }

    _hideAll () {
      let changed = false;
      for (const sp of this._pool) {
        if (sp.visible) { sp.visible = false; changed = true; }
      }
      this._used = 0;
      if (changed && this.threeRenderer) this.threeRenderer.requestRender();
    }

    /** Uuids something is currently resolved to be attacking — attacker OR target may be a unit. */
    _attackedUuids (gameTime) {
      const world = this.viewer && this.viewer.behaviorWorld;
      if (!world) return null;
      const frame = world.resolve(gameTime);   // memoized on gameTime — free alongside UnitModelRenderer/BuildingStatusFx's own calls
      if (!frame) return null;
      const set = new Set();
      for (const [, d] of frame.byUuid) {
        if (d.state === 'attack' && d.targetUuid) set.add(d.targetUuid);
      }
      return set;
    }

    update (gameTime) {
      if (!this._enabled || !this._unitsByUuid || !this._unitsByUuid.size) return;
      const attacked = this._attackedUuids(gameTime);
      if (!attacked || !attacked.size) { if (this._used) this._hideAll(); return; }

      const ext = this.threeRenderer.mapInfo.bounds.map;
      const cx = (ext[0][0] + ext[0][1]) / 2;
      const cy = (ext[1][0] + ext[1][1]) / 2;
      const pulse = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(gameTime * 0.006));

      let shown = 0;
      let changed = false;
      for (const uuid of attacked) {
        const unit = this._unitsByUuid.get(uuid);
        if (!unit) continue;   // target is a building — BuildingStatusFx already marks it
        const ready = unit.readyTime != null ? unit.readyTime : unit.spawnTime;
        if (ready != null && gameTime < ready) continue;
        if (unit._destroyed) continue;
        // Deliberately getCurrentMovePath, not getInterpolatedPosition: the
        // latter only returns non-null once recordIndexes.path has been
        // primed by an earlier call, which normally happens inside
        // UnitModelRenderer.update() — but that skips culled/off-screen
        // units, so a unit fighting just outside the camera view would never
        // get primed and this marker would silently never show for it.
        // getCurrentMovePath primes itself. It returns the last keyframe at
        // or before gameTime rather than a smooth interpolation, which is
        // fine here — the marker is a decorative plaque, not a tracked path.
        const rec = unit.getCurrentMovePath ? unit.getCurrentMovePath(gameTime) : null;
        const pos = rec ? { x: rec.x, y: rec.y } : null;
        if (!pos) continue;

        const sp = this._spriteAt(shown);
        const groundY = this.threeRenderer.sampleHeight(pos.x, pos.y);
        sp.position.set(pos.x - cx, groundY + Y_OFFSET, -(pos.y - cy));
        sp.material.opacity = pulse;
        if (!sp.visible) { sp.visible = true; changed = true; }
        shown++;
      }
      // Hide any pool sprites left over from a frame that had more targets.
      for (let i = shown; i < this._used; i++) {
        if (this._pool[i] && this._pool[i].visible) { this._pool[i].visible = false; changed = true; }
      }
      this._used = shown;

      if (changed) this.threeRenderer.requestRender();
    }

    dispose () {
      for (const sp of this._pool) {
        if (!sp) continue;
        this.threeRenderer.scene.remove(sp);
        if (sp.material) sp.material.dispose();
      }
      this._pool = [];
      this._used = 0;
      this._unitsByUuid = null;
      if (this._tex) { this._tex.dispose(); this._tex = null; }
    }
  }

  window.UnitStatusFx = UnitStatusFx;
})();
