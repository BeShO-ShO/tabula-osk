import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import IBus from 'gi://IBus';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import { getIBusManager } from 'resource:///org/gnome/shell/misc/ibusManager.js';
import { Layouts, loadCustomLayout } from './layouts.js';

// ----------------------------------------------------------------------
// ibus-typing-booster bridge (setting 'use-typing-booster').
// Uses GNOME's own OSK completion: IBusManager.setCompletionEnabled() switches the
// IBus engine to typing-booster while the keyboard is open and restores the previous
// xkb engine afterwards. The Shell's candidate popup hands every candidate to
// Main.keyboard.addSuggestion(text, callback), where the callback commits it with
// panelService.candidate_clicked(); we listen there. Never logs text or candidates.
// ----------------------------------------------------------------------
const TB_ENGINE = 'typing-booster';

class TypingBoosterBridge {
    constructor(onChange) {
        this._onChange = onChange;
        this._active = false;
        this._weEnabled = false;
        this._cands = [];
        this._visible = false;
        this._idleId = 0;
        this._queue = Promise.resolve();
        this._saved = null;
        this._capCtx = null;
    }

    get active() {
        return this._active;
    }

    // Candidates of the current page, best first: [{ text, cb }]
    get candidates() {
        return this._visible ? this._cands : [];
    }

    _available() {
        try {
            const m = getIBusManager();
            return !!(m && m._ready && m._engines && m._engines.has(TB_ENGINE));
        } catch (e) {
            return false;
        }
    }

    start() {
        this._queue = this._queue.then(() => this._doStart()).catch(e =>
            console.warn('[AproposOSK] typing-booster start failed:', e));
        return this._queue;
    }

    stop() {
        this._queue = this._queue.then(() => this._doStop()).catch(e =>
            console.warn('[AproposOSK] typing-booster stop failed:', e));
        return this._queue;
    }

    async _doStart() {
        if (this._active)
            return;
        if (!this._available()) {
            return;
        }
        const m = getIBusManager();
        this._mgr = m;
        this._active = true;
        try {
            this._hook();
            const cur = m._currentEngineName || '';
            if (cur !== TB_ENGINE) {
                // Only possible on xkb sources; CJK and other IBus engines are left alone
                const ok = await m.setCompletionEnabled(true);
                if (!ok) {
                    this._active = false;
                    this._unhook();
                    this._notify();
                    return;
                }
                this._weEnabled = true;
            }
            try {
                Main.inputMethod.update();
            } catch (e) {}
        } catch (e) {
            this._active = false;
            this._unhook();
            throw e;
        }
        this._notify();
    }

    async _doStop() {
        if (!this._active)
            return;
        this._active = false;
        this._cands = [];
        this._visible = false;
        this._unhook();
        if (this._weEnabled) {
            this._weEnabled = false;
            try {
                await this._mgr.setCompletionEnabled(false);
            } catch (e) {
                console.warn('[AproposOSK] could not restore input engine:', e);
            }
        }
        try {
            Main.inputMethod.update();
        } catch (e) {}
        this._notify();
    }

    _notify() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            try {
                this._onChange();
            } catch (e) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- hooks (instance overrides, removed again in _unhook) -----------
    _override(obj, name, fn) {
        const own = Object.prototype.hasOwnProperty.call(obj, name);
        this._saved.push({ obj, name, own, value: obj[name] });
        obj[name] = fn;
    }

    _hook() {
        this._unhook();
        this._saved = [];
        const self = this;
        const kb = Main.keyboard;
        const origAdd = kb.addSuggestion;
        const origReset = kb.resetSuggestions;
        const origVis = kb.setSuggestionsVisible;
        this._override(kb, 'addSuggestion', function (text, cb) {
            try {
                if (self._active) {
                    self._cands.push({ text: String(text ?? ''), cb });
                    self._notify();
                }
            } catch (e) {}
            return origAdd.call(this, text, cb);
        });
        this._override(kb, 'resetSuggestions', function () {
            try {
                if (self._active) {
                    self._cands = [];
                    self._hookCaps();
                    self._notify();
                }
            } catch (e) {}
            return origReset.call(this);
        });
        this._override(kb, 'setSuggestionsVisible', function (visible) {
            try {
                if (self._active) {
                    self._visible = !!visible;
                    self._notify();
                }
            } catch (e) {}
            return origVis.call(this, visible);
        });

        // Keep the Shell's floating candidate popup closed while our bar shows typing-booster
        const popup = this._mgr && this._mgr._candidatePopup;
        if (popup && typeof popup._updateVisibility === 'function') {
            const origUpd = popup._updateVisibility;
            this._override(popup, '_updateVisibility', function () {
                try {
                    if (self._active && self._mgr._currentEngineName === TB_ENGINE) {
                        this.close(BoxPointer.PopupAnimation.NONE);
                        return;
                    }
                } catch (e) {}
                return origUpd.call(this);
            });
        }
        this._hookCaps();
    }

    // Tell the engine an on-screen keyboard is in use (IBus OSK capability), as the
    // stock OSK does: no commit-by-digit, no candidate delay, space after a tapped
    // candidate, disabled in terminals.
    _hookCaps() {
        const ctx = Main.inputMethod && Main.inputMethod._context;
        if (!ctx || this._capCtx === ctx)
            return;
        this._unhookCaps();
        const self = this;
        const orig = ctx.set_capabilities;
        ctx.set_capabilities = function (caps) {
            if (self._active)
                caps |= IBus.Capabilite.OSK;
            return orig.call(this, caps);
        };
        this._capCtx = ctx;
        try {
            Main.inputMethod.update();
        } catch (e) {}
    }

    _unhookCaps() {
        if (this._capCtx) {
            try {
                delete this._capCtx.set_capabilities;
            } catch (e) {}
            this._capCtx = null;
        }
    }

    _unhook() {
        this._unhookCaps();
        if (this._saved) {
            for (const s of this._saved.reverse()) {
                try {
                    if (s.own)
                        s.obj[s.name] = s.value;
                    else
                        delete s.obj[s.name];
                } catch (e) {}
            }
        }
        this._saved = null;
    }

    destroy() {
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        this._onChange = () => {};
        // Synchronous part of stop: never leave our overrides behind
        const wasEnabled = this._weEnabled;
        this._active = false;
        this._weEnabled = false;
        this._unhook();
        if (wasEnabled && this._mgr) {
            this._mgr.setCompletionEnabled(false).catch(() => {});
            try {
                Main.inputMethod.update();
            } catch (e) {}
        }
    }
}

// Atkinson Hyperlegible Next per massima leggibilita
const DEFAULT_FONT_NAME = 'Atkinson Hyperlegible Next';
const SUPER_KEYCODE = 125;
const BUNDLED_FONTS = [
    'AtkinsonHyperlegibleNext-Regular.ttf',
    'AtkinsonHyperlegibleNext-Bold.ttf',
    'AtkinsonHyperlegible-Regular.ttf',
    'AtkinsonHyperlegible-Bold.ttf',
];

export class AproposKeyboard {
    constructor(settings, inputDevice, extension) {
        this._settings = settings;
        this._input = inputDevice;
        this._extension = extension;

        this.isOpen = false;
        this.shiftActive = false;
        this._activeShiftCode = 42;
        this.capsActive = false;
        this.altgrActive = false;
        this.ctrlActive = false;
        this._leftCtrlActive = false;
        this._rightCtrlActive = false;
        this.altActive = false;
        // Super: tracciamento stato fisico vs sistema
        this._superDown = false;
        this._superSent = false;
        this._superCode = SUPER_KEYCODE;
        this._superFallbackId = 0;
        this._destroyed = false;
        this._enterDelegate = null;
        this._isoEnter = null;
        this._isoInfo = null;
        this._fontFamilyCss = null;

        this._repeatTimer = null;
        this._repeatIntervalTimer = null;
        this._repeatStartTime = 0;
        this._currentRepeatCode = null;

        // Scorrimento cursore barra spazio
        this._spaceStartX = 0;
        this._spaceDrifting = false;
        this._currentSpaceStep = 0;

        // Selezione testo backspace
        this._backspaceStartX = 0;
        this._backspaceSwiping = false;
        this._backspaceSelectCount = 0;

        // Cattura gesture stage continua
        this._activeGesture = null;
        this._gestureBtn = null;
        this._gestureTouchSeq = null;
        this._gestureTouchSlot = null;
        this._gestureIsTouch = false;
        this._stageGestureId = 0;

        this._keyActors = [];
        this._shiftButtons = [];
        this._capsButtons = [];
        this._altgrButtons = [];
        this._fnButtons = [];
        this._enterButtons = [];
        this.fnActive = false;
        this._smartPairStack = [];
        this._toggleKeyStates = new Map();
        this._settingsSignals = [];

        this._isDocked = this._settings.get_boolean('dock-bottom');
        this._dockFullStrip = this._settings.get_boolean('dock-full-strip');
        this._currentLayoutKey = this._settings.get_string('layout-variant') || 'it';

        this._registerBundledFonts();
        this._buildUI();
        this._setupSettingsListeners();

        // Livello TopChrome: sopra finestre e fullscreen
        Main.layoutManager.addTopChrome(this.actor, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this.actor.hide();
        this.actor.opacity = 255;

        // Z-order: priorita su restack finestre
        this._restackedId = global.display.connect('restacked', () => {
            if (this.isOpen && this.actor && this.actor.get_parent()) {
                this.actor.get_parent().set_child_above_sibling(this.actor, null);
            }
        });

        this._focusNotifyId = global.stage.connect('notify::key-focus', () => {
            if (this.isOpen && this.actor && this.actor.get_parent()) {
                this.actor.get_parent().set_child_above_sibling(this.actor, null);
            }
        });
    }

    _buildUI() {
        this.actor = new St.BoxLayout({
            name: 'apropos-osk',
            style_class: 'apropos-osk-container',
            vertical: true,
            reactive: true,
            track_hover: true,
            can_focus: false,
        });

        this.actor.connect('event', (actor, event) => {
            const type = event.type();
            if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) {
                if (!this._activeGesture && (this._spaceDrifting || this._backspaceSwiping)) {
                    this._resetGestureStates();
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Remember when the user last interacted with the keyboard (typing, header buttons, resize bar)
        this.actor.connect('captured-event', () => {
            this._lastInteractionUs = GLib.get_monotonic_time();
            return Clutter.EVENT_PROPAGATE;
        });

        this._buildHeader();
        this._buildSuggestBar();
        this._buildKeyboardLayout();
    }

    recentlyInteracted(ms) {
        return (GLib.get_monotonic_time() - (this._lastInteractionUs || 0)) < ms * 1000;
    }

    _buildHeader() {
        // The header is an overlay: the button row fills it, and the resize bar sits on top,
        // centred on the whole header (so it is centred on the screen)
        this._header = new St.Widget({
            style_class: 'apropos-osk-header',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: false,
        });
        this._headerRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_expand: true,
        });
        this._header.add_child(this._headerRow);

        // Left: Layout switch button
        this._layoutLabel = new St.Button({
            label: this._getLayoutLabelText(),
            style_class: 'apropos-osk-header-btn',
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            can_focus: false,
        });
        this._layoutLabel.connect('clicked', () => this._toggleLayout());
        this._headerRow.add_child(this._layoutLabel);

        // Maniglia trascinamento
        const handleBox = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            can_focus: false,
            style: 'min-height: 26px; padding: 2px 20px;',
        });
        this._dragHandle = new St.Widget({
            style_class: 'apropos-osk-handle',
            reactive: true,
        });
        handleBox.add_child(this._dragHandle);
        this._setupDragging(handleBox);
        handleBox.set_x_expand(true);
        handleBox.set_y_expand(true);
        this._headerRow.add_child(new St.Widget({ x_expand: true }));
        this._header.add_child(handleBox);

        // Pulsanti intestazione destra
        const rightBtns = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Preferenze
        const prefsBtn = new St.Button({
            label: '[Cfg]',
            style_class: 'apropos-osk-header-btn',
            reactive: true,
            can_focus: false,
        });
        prefsBtn.connect('clicked', () => this._extension.openPreferences());
        rightBtns.add_child(prefsBtn);

        // Dock toggle button
        this._dockToggleBtn = new St.Button({
            label: this._isDocked ? '[Dock]' : '[Float]',
            style_class: 'apropos-osk-header-btn',
            reactive: true,
            can_focus: false,
        });
        this._dockToggleBtn.connect('clicked', () => {
            this._isDocked = !this._isDocked;
            this._settings.set_boolean('dock-bottom', this._isDocked);
            if (!this._isDocked) {
                this._dockFullStrip = false;
                this._settings.set_boolean('dock-full-strip', false);
            }
            this._updateHeaderButtons();
            this._applyGeometry();
        });
        rightBtns.add_child(this._dockToggleBtn);

        // Full-width strut toggle button
        this._widthToggleBtn = new St.Button({
            label: this._dockFullStrip ? '[Full]' : '[Norm]',
            style_class: 'apropos-osk-header-btn',
            reactive: true,
            can_focus: false,
        });
        this._widthToggleBtn.connect('clicked', () => {
            if (!this._isDocked) {
                this._isDocked = true;
                this._settings.set_boolean('dock-bottom', true);
            }
            const full = this._settings.get_boolean('dock-full-strip');
            const centered = this._settings.get_boolean('full-strip-centered-keys');
            // Cycle: Norm -> Full -> Full-centered -> Norm
            if (!full) {
                this._settings.set_boolean('full-strip-centered-keys', false);
                this._settings.set_boolean('dock-full-strip', true);
            } else if (!centered) {
                this._settings.set_boolean('full-strip-centered-keys', true);
            } else {
                this._settings.set_boolean('full-strip-centered-keys', false);
                this._settings.set_boolean('dock-full-strip', false);
            }
            this._dockFullStrip = this._settings.get_boolean('dock-full-strip');
            this._updateHeaderButtons();
            this._applyGeometry();
        });
        rightBtns.add_child(this._widthToggleBtn);

        // Close button
        const closeBtn = new St.Button({
            label: '[X]',
            style_class: 'apropos-osk-header-btn',
            reactive: true,
            can_focus: false,
        });
        closeBtn.connect('clicked', () => this.close());
        rightBtns.add_child(closeBtn);

        this._headerBtns = [this._layoutLabel, prefsBtn, this._dockToggleBtn, this._widthToggleBtn, closeBtn];

        this._headerRow.add_child(rightBtns);
        this.actor.add_child(this._header);

        this._updateHeaderButtons();
    }

    _getLayoutLabelText() {
        if (this._currentLayoutKey === 'custom') return '[CUSTOM]';
        return `[${this._currentLayoutKey.toUpperCase()}]`;
    }

    _getWidthLabel() {
        if (!this._dockFullStrip)
            return '[Norm]';
        let centered = false;
        try {
            centered = this._settings.get_boolean('full-strip-centered-keys');
        } catch (e) {}
        return centered ? '[Full-C]' : '[Full]';
    }

    _updateHeaderButtons() {
        if (this._dockToggleBtn) {
            this._dockToggleBtn.label = this._isDocked ? '[Dock]' : '[Float]';
            if (this._isDocked) {
                this._dockToggleBtn.add_style_class_name('active');
            } else {
                this._dockToggleBtn.remove_style_class_name('active');
            }
        }

        if (this._widthToggleBtn) {
            this._widthToggleBtn.label = this._getWidthLabel();
            if (this._dockFullStrip && this._isDocked) {
                this._widthToggleBtn.add_style_class_name('active');
            } else {
                this._widthToggleBtn.remove_style_class_name('active');
            }

            if (!this._isDocked) {
                this._widthToggleBtn.add_style_class_name('apropos-osk-header-btn-disabled');
            } else {
                this._widthToggleBtn.remove_style_class_name('apropos-osk-header-btn-disabled');
            }
        }
    }

    // Registrazione font inclusi in Pango fontmap
    _registerBundledFonts() {
        try {
            const probe = new St.Label({ text: '' });
            const fontMap = probe.clutter_text.get_layout().get_context().get_font_map();
            if (fontMap && typeof fontMap.add_font_file === 'function') {
                for (const name of BUNDLED_FONTS) {
                    const path = GLib.build_filenamev([this._extension.path, 'fonts', name]);
                    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                        continue;
                    try {
                        fontMap.add_font_file(path);
                    } catch (e) {
                        console.warn(`[AproposOSK] Could not register font ${name}:`, e.message);
                    }
                }
            }
            probe.destroy();
        } catch (e) {
            console.warn('[AproposOSK] Bundled font registration unavailable, using system fonts:', e.message);
        }
    }

    // Ricerca coppia top/bottom Invio ISO
    _findIsoEnter(rowDefsList) {
        let top = null;
        let bottom = null;
        rowDefsList.forEach((defs, r) => {
            defs.forEach((d, i) => {
                if (d.type !== 'enter') return;
                if (d.enterPart === 'top' && !top) top = { r, i };
                else if (d.enterPart === 'bottom' && !bottom) bottom = { r, i };
            });
        });
        if (top && bottom && bottom.r === top.r + 1)
            return { top, bottom };
        return null;
    }

    _buildKeyboardLayout() {
        if (this._keysBox) {
            this.actor.remove_child(this._keysBox);
            this._keysBox.destroy();
        }

        // Contenitore multistrato righe + overlay Invio ISO
        this._keysBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: false,
        });
        this._rowsBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: false,
        });
        this._overlay = new St.Widget({
            reactive: false,
            x_expand: true,
            y_expand: true,
        });
        this._keysBox.add_child(this._rowsBox);
        this._keysBox.add_child(this._overlay);

        this._keyActors = [];
        this._shiftButtons = [];
        this._capsButtons = [];
        this._altgrButtons = [];
        this._fnButtons = [];
        this._enterButtons = [];
        this._rows = [];
        this._isoEnter = null;
        this._isoInfo = null;
        this._enterDelegate = null;
        this._spaceButton = null;
        this._backspaceButton = null;

        let layout = null;
        if (this._currentLayoutKey === 'custom') {
            layout = loadCustomLayout();
        }
        if (!layout) {
            layout = Layouts[this._currentLayoutKey] || Layouts.it;
        }

        // Riga numerica (TKL) + righe principali
        const rowSpecs = [];
        if (layout.numberRow && layout.numberRow.length > 0)
            rowSpecs.push({ defs: layout.numberRow, isNumber: true });
        for (const rowDef of (layout.mainRows || []))
            rowSpecs.push({ defs: rowDef, isNumber: false });

        const iso = this._findIsoEnter(rowSpecs.map(sp => sp.defs));

        rowSpecs.forEach((spec, r) => {
            const rowBox = new St.BoxLayout({
                style_class: spec.isNumber ? 'apropos-osk-row apropos-osk-number-row' : 'apropos-osk-row',
                vertical: false,
                x_expand: true,
                y_expand: false,
            });
            const rowKeys = [];
            spec.defs.forEach((keyDef, k) => {
                let btn;
                const isIsoPart = iso && (
                    (iso.top.r === r && iso.top.i === k) ||
                    (iso.bottom.r === r && iso.bottom.i === k));
                if (isIsoPart) {
                    // Segnaposto spaziatore riga
                    btn = new St.Widget({
                        reactive: false,
                        style: 'background-color: transparent !important; border: none !important; box-shadow: none !important;',
                    });
                    btn._keyDef = keyDef;
                    btn._isEnterPlaceholder = true;
                } else {
                    btn = this._createKeyButton(keyDef, spec.isNumber, k);
                }
                rowBox.add_child(btn);
                rowKeys.push(btn);
            });
            this._rows.push({ box: rowBox, keys: rowKeys, defs: spec.defs, xs: [], ws: [], top: 0 });
            this._rowsBox.add_child(rowBox);
        });

        if (iso) {
            const topDef = this._rows[iso.top.r].defs[iso.top.i];
            const enter = this._createIsoEnter(topDef);
            this._overlay.add_child(enter);
            this._isoEnter = enter;
            this._isoInfo = iso;
            this._keyActors.push(enter);
            this._enterButtons.push(enter);
        }

        this.actor.add_child(this._keysBox);
    }

    // Invio ISO: Cairo su DrawingArea, hit-test incavo
    _createIsoEnter(keyDef) {
        const actor = new St.Widget({
            style_class: 'apropos-osk-iso-enter',
            style: 'background-color: transparent !important; border: none !important; box-shadow: none !important;',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: false,
        });
        actor._keyDef = keyDef;
        actor._isIsoEnter = true;
        actor._iso = null;
        actor._delegateBtn = null;

        const shape = new St.DrawingArea({
            x_expand: true,
            y_expand: true,
            reactive: false,
        });
        const labelBox = new St.BoxLayout({
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            reactive: false,
        });
        const label = new St.Label({
            text: keyDef.label || 'Enter',
            style_class: 'apropos-osk-iso-enter-label',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        labelBox.add_child(label);
        actor.add_child(shape);
        actor.add_child(labelBox);

        actor._shape = shape;
        actor._labelBox = labelBox;
        actor._labelActor = label;

        // Setter compatibilita btn.label
        Object.defineProperty(actor, 'label', {
            configurable: true,
            get: () => label.text,
            set: (v) => {
                label.text = v;
                this._styleIsoLabel(actor);
            },
        });

        actor._redraw = () => {
            this._styleIsoLabel(actor);
            shape.queue_repaint();
        };
        shape.connect('repaint', area => this._paintIsoEnter(actor, area));
        this._setupIsoEnterEvents(actor, keyDef);
        return actor;
    }

    _styleIsoLabel(actor) {
        const iso = actor._iso;
        const text = actor._labelActor.text || '';
        const fs = this._fitFont(text, 21, iso ? iso.topW : 90, iso ? iso.keyH : 50);
        const family = this._fontFamilyCss || this._computeFontFamily();
        actor._labelActor.set_style(`font-family: "${family}"; font-size: ${fs}px; font-weight: normal;`);
        const ct = this._getClutterText(actor._labelActor);
        if (ct) {
            ct.font_name = `${family} ${fs}px`;
        }
    }

    _isoPolygon(iso, i) {
        const { tx0, bx0, W, H, keyH, gap } = iso;
        if (Math.abs(tx0 - bx0) < 1) {
            const x0 = Math.min(tx0, bx0) + i;
            return [[x0, i], [W - i, i], [W - i, H - i], [x0, H - i]];
        }
        if (tx0 < bx0) {
            // Incavo inferiore sinistro (ISO standard)
            return [[tx0 + i, i], [W - i, i], [W - i, H - i], [bx0 + i, H - i], [bx0 + i, keyH - i], [tx0 + i, keyH - i]];
        }
        // Incavo superiore sinistro
        return [[tx0 + i, i], [W - i, i], [W - i, H - i], [bx0 + i, H - i], [bx0 + i, keyH + gap + i], [tx0 + i, keyH + gap + i]];
    }

    _roundedPolygon(cr, pts, radius) {
        const n = pts.length;
        const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const corners = pts.map((v, i) => {
            const p = pts[(i + n - 1) % n];
            const q = pts[(i + 1) % n];
            const r = Math.max(0, Math.min(radius, dist(p, v) / 2, dist(v, q) / 2));
            return {
                v,
                a: [v[0] + (p[0] - v[0]) * r / dist(p, v), v[1] + (p[1] - v[1]) * r / dist(p, v)],
                b: [v[0] + (q[0] - v[0]) * r / dist(v, q), v[1] + (q[1] - v[1]) * r / dist(v, q)],
            };
        });
        const k = 0.5523;
        cr.newPath();
        cr.moveTo(corners[0].b[0], corners[0].b[1]);
        for (let i = 1; i <= n; i++) {
            const c = corners[i % n];
            cr.lineTo(c.a[0], c.a[1]);
            cr.curveTo(
                c.a[0] + (c.v[0] - c.a[0]) * k, c.a[1] + (c.v[1] - c.a[1]) * k,
                c.b[0] + (c.v[0] - c.b[0]) * k, c.b[1] + (c.v[1] - c.b[1]) * k,
                c.b[0], c.b[1]);
        }
        cr.closePath();
    }

    _paintIsoEnter(actor, area) {
        const iso = actor._iso;
        if (!iso) return;
        const cr = area.get_context();
        try {
            const pressed = actor.has_style_pseudo_class('pressed');
            const shifted = actor.has_style_class_name('apropos-osk-enter-shift');
            let fill, stroke;
            if (pressed) {
                fill = [0.00, 0.47, 0.83, 0.78];
                stroke = [0.60, 0.88, 1.00, 1.00];
            } else if (shifted) {
                fill = [0.27, 0.53, 0.76, 0.58];
                stroke = [0.67, 0.82, 1.00, 0.95];
            } else {
                fill = [0.00, 0.47, 0.83, 0.38];
                stroke = [0.12, 0.59, 0.94, 0.95];
            }
            this._roundedPolygon(cr, this._isoPolygon(iso, 1), iso.radius);
            cr.setSourceRGBA(fill[0], fill[1], fill[2], fill[3]);
            cr.fillPreserve();
            cr.setSourceRGBA(stroke[0], stroke[1], stroke[2], stroke[3]);
            cr.setLineWidth(1.5);
            cr.stroke();
        } finally {
            cr.$dispose();
        }
    }

    _isoHit(iso, lx, ly) {
        const inTop = lx >= iso.tx0 && ly <= iso.keyH;
        const inBottom = lx >= iso.bx0 && ly >= iso.keyH + iso.gap;
        const inGap = ly > iso.keyH && ly < iso.keyH + iso.gap && lx >= Math.max(iso.tx0, iso.bx0);
        return inTop || inBottom || inGap;
    }

    _setupIsoEnterEvents(actor, keyDef) {
        actor.connect('event', (a, event) => {
            if (this._activeGesture) return Clutter.EVENT_STOP;
            const type = event.type();

            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
                const [sx, sy] = event.get_coords();
                const [ok, lx, ly] = actor.transform_stage_point(sx, sy);
                if (ok && actor._iso && !this._isoHit(actor._iso, lx, ly)) {
                    // Tocco incavo: delega tasto adiacente
                    const target = actor._delegateBtn;
                    this._enterDelegate = target || null;
                    if (target)
                        this._onKeyPress(target, target._keyDef, event);
                    return Clutter.EVENT_STOP;
                }
                this._enterDelegate = null;
                this._onKeyPress(actor, keyDef, event);
                return Clutter.EVENT_STOP;
            } else if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                const target = this._enterDelegate;
                if (target)
                    this._onKeyMotion(target, target._keyDef, event);
                else
                    this._onKeyMotion(actor, keyDef, event);
                return Clutter.EVENT_STOP;
            } else if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) {
                const target = this._enterDelegate;
                if (target) {
                    this._enterDelegate = null;
                    if (target._down)
                        this._onKeyRelease(target, target._keyDef, event);
                } else {
                    this._onKeyRelease(actor, keyDef, event);
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // Posizionamento Invio ISO su segnaposto
    _layoutIsoEnter(keyHeight, radius) {
        const actor = this._isoEnter;
        const iso = this._isoInfo;
        if (!actor || !iso) return;

        const tRow = this._rows[iso.top.r];
        const bRow = this._rows[iso.bottom.r];
        const xT = tRow.xs[iso.top.i];
        const wT = tRow.ws[iso.top.i];
        const xB = bRow.xs[iso.bottom.i];
        const wB = bRow.ws[iso.bottom.i];
        if ([xT, wT, xB, wB].some(v => v === undefined)) return;

        const left = Math.min(xT, xB);
        const right = Math.max(xT + wT, xB + wB);
        const y0 = tRow.top;
        const y1 = bRow.top + keyHeight;

        actor.set_position(left, y0);
        actor.set_size(right - left, y1 - y0);
        actor._iso = {
            tx0: xT - left,
            bx0: xB - left,
            W: right - left,
            H: y1 - y0,
            keyH: keyHeight,
            gap: (bRow.top - tRow.top) - keyHeight,
            radius,
            topW: wT,
        };

        // Label su porzione superiore
        actor._labelBox.set_size(wT, keyHeight);
        actor._labelBox.margin_left = xT - left;

        // Tasto delegato incavo
        const notchOnBottom = xT <= xB;
        const notchRow = notchOnBottom ? this._rows[iso.bottom.r] : this._rows[iso.top.r];
        const notchIdx = notchOnBottom ? iso.bottom.i : iso.top.i;
        const cand = notchRow.keys[notchIdx - 1];
        actor._delegateBtn = (cand && !cand._isEnterPlaceholder) ? cand : null;

        actor._redraw();
    }

    _createKeyButton(keyDef, isNumberRow = false, indexInRow = -1) {
        const btn = new St.Button({
            label: keyDef.label || '',
            style_class: 'apropos-osk-key',
            x_expand: false,
            y_expand: false,
            reactive: true,
            can_focus: false,
        });

        btn._keyDef = keyDef;
        this._keyActors.push(btn);

        if (isNumberRow && indexInRow >= 1 && indexInRow <= 12) {
            btn._isFnNumberKey = true;
            btn._fnLabel = 'F' + indexInRow;
            btn._fnCode = (indexInRow <= 10) ? (58 + indexInRow) : (indexInRow === 11 ? 87 : 88);
        }

        if (keyDef.type === 'fn') {
            btn.add_style_class_name('apropos-osk-key-fn');
        } else if (keyDef.type === 'fn_toggle' || keyDef.label === 'FN') {
            btn.add_style_class_name('apropos-osk-key-fn');
            this._fnButtons.push(btn);
            if (this.fnActive) {
                btn.add_style_class_name('apropos-osk-key-active');
            }
        } else if (['mod', 'ctrl', 'alt', 'super'].includes(keyDef.type)) {
            btn.add_style_class_name('apropos-osk-key-mod');
        } else if (keyDef.type === 'enter') {
            // Invio rettangolare fallback (ANSI)
            btn.add_style_class_name('apropos-osk-enter');
            this._enterButtons.push(btn);
        } else if (keyDef.type === 'arrow') {
            btn.add_style_class_name('apropos-osk-arrow');
        } else if (keyDef.type === 'space') {
            btn.add_style_class_name('apropos-osk-space');
            this._spaceButton = btn;
        } else if (keyDef.type === 'backspace') {
            this._backspaceButton = btn;
        }

        if (keyDef.type === 'shift') {
            btn.add_style_class_name('apropos-osk-key-mod');
            this._shiftButtons.push(btn);
        } else if (keyDef.type === 'caps') {
            btn.add_style_class_name('apropos-osk-key-mod');
            this._capsButtons.push(btn);
        } else if (keyDef.type === 'altgr') {
            btn.add_style_class_name('apropos-osk-key-mod');
            this._altgrButtons.push(btn);
        }

        this._setupKeyEvents(btn, keyDef);
        return btn;
    }

    _setupKeyEvents(btn, keyDef) {
        btn.connect('event', (actor, event) => {
            const type = event.type();

            if (this._activeGesture && this._gestureBtn !== btn) {
                if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN ||
                    type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END ||
                    type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }

            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
                this._onKeyPress(btn, keyDef, event);
                return Clutter.EVENT_STOP;
            } else if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                this._onKeyMotion(btn, keyDef, event);
                return Clutter.EVENT_STOP;
            } else if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) {
                this._onKeyRelease(btn, keyDef, event);
                return Clutter.EVENT_STOP;
            } else if (type === Clutter.EventType.LEAVE) {
                if (this._activeGesture) return Clutter.EVENT_PROPAGATE;
                if (btn._down && !['shift', 'caps', 'altgr', 'ctrl', 'alt'].includes(keyDef.type) && keyDef.behavior !== 'toggle') {
                    if (!this._spaceDrifting && !this._backspaceSwiping) {
                        this._onKeyRelease(btn, keyDef, event);
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _playSound() {
        if (!this._settings.get_boolean('play-sound')) return;
        try {
            const player = global.display.get_sound_player();
            player.play_from_theme('dialog-information', 'tap', null);
        } catch (e) {}
    }

    _typeCharacterByMatchingKey(targetChar) {
        if (!targetChar) return;
        for (const btn of this._keyActors) {
            const def = btn._keyDef;
            if (!def || !def.code) continue;

            if (def.shiftAltgr === targetChar) {
                this._input.pressKey(42);  // Shift
                this._input.pressKey(100); // AltGr
                this._input.tapKey(def.code);
                this._input.releaseKey(100);
                this._input.releaseKey(42);
                return;
            }
            if (def.altgr === targetChar) {
                this._input.pressKey(100); // AltGr
                this._input.tapKey(def.code);
                this._input.releaseKey(100);
                return;
            }
            if (def.shift === targetChar) {
                this._input.pressKey(42); // Shift
                this._input.tapKey(def.code);
                this._input.releaseKey(42);
                return;
            }
            if (def.label === targetChar) {
                this._input.tapKey(def.code);
                return;
            }
        }
    }

    // Super: attivazione fisica su sistema per combo
    _engageSuper() {
        if (this._superDown && !this._superSent) {
            this._input.pressKey(this._superCode);
            this._superSent = true;
        }
    }

    _onKeyPress(btn, keyDef, event) {
        btn._down = true;
        btn.add_style_pseudo_class('pressed');
        this._updateKeyStyle(btn, true);
        this._playSound();

        // Super combo: invio immediato al sistema
        if (this._superDown && keyDef.type !== 'super' && keyDef.type !== 'fn_toggle' && keyDef.label !== 'FN') {
            this._engageSuper();
        }

        // Super: tap al rilascio, hold per combo
        if (keyDef.type === 'super') {
            this._superDown = true;
            this._superSent = false;
            this._superCode = keyDef.code || SUPER_KEYCODE;
            return;
        }

        // Ctrl toggle ON/OFF behavior
        if (keyDef.type === 'ctrl' || keyDef.code === 29 || keyDef.code === 97) {
            const isLeft = (keyDef.code === 29);
            const current = isLeft ? this._leftCtrlActive : this._rightCtrlActive;
            const next = !current;
            if (isLeft) {
                this._leftCtrlActive = next;
            } else {
                this._rightCtrlActive = next;
            }
            if (next) {
                this._input.pressKey(keyDef.code);
            } else {
                this._input.releaseKey(keyDef.code);
            }
            this._updateModifierUI();
            this._updateKeyStyle(btn, false);
            return;
        }

        // Custom toggle behavior for other keys
        if (keyDef.behavior === 'toggle' && keyDef.type !== 'fn_toggle' && keyDef.label !== 'FN') {
            const current = this._toggleKeyStates.get(keyDef.code) || false;
            const next = !current;
            this._toggleKeyStates.set(keyDef.code, next);
            if (next) {
                btn.add_style_class_name('apropos-osk-key-active');
                this._input.pressKey(keyDef.code);
            } else {
                btn.remove_style_class_name('apropos-osk-key-active');
                this._input.releaseKey(keyDef.code);
            }
            this._updateKeyStyle(btn, false);
            return;
        }

        // FN Toggle Key
        if (keyDef.type === 'fn_toggle' || keyDef.label === 'FN') {
            this.fnActive = !this.fnActive;
            this._updateModifierUI();
            this._updateLabels();
            return;
        }

        // FN mode: number row sends F1..F12
        if (this.fnActive && btn._isFnNumberKey) {
            this._input.pressKey(btn._fnCode);
            this._startKeyRepeat({ code: btn._fnCode, type: 'fn' });
            return;
        }

        // Smart auto-pairs skip check
        const typedLabel = btn.label;
        const isAutoPairs = this._settings.get_boolean('smart-auto-pairs');
        const closingPairs = { ')': '(', ']': '[', '}': '{', '"': '"', '»': '«', "'": "'" };
        if (isAutoPairs && this._smartPairStack.length > 0 && this._smartPairStack[this._smartPairStack.length - 1] === typedLabel) {
            this._smartPairStack.pop();
            this._input.tapKey(106); // Move cursor past closer
            this._input.tapKey(57);  // Insert space

            // One-shot auto-release for active modifiers
            let modChanged = false;
            if (this.shiftActive) {
                this._input.releaseKey(this._activeShiftCode || 42);
                this.shiftActive = false;
                modChanged = true;
            }
            if (this.altgrActive) {
                this._input.releaseKey(100);
                this.altgrActive = false;
                modChanged = true;
            }
            if (modChanged) {
                this._updateModifierUI();
                this._updateLabels();
            }
            return;
        }

        // Gesture barra spazio con cattura continua
        if (keyDef.type === 'space') {
            this._startGesture('space', btn, event);
            return;
        }

        // Gesture swipe backspace con cattura continua
        if (keyDef.type === 'backspace') {
            this._startGesture('backspace', btn, event);
            return;
        }

        // Shift modifier (tracks Left 42 vs Right 54)
        if (keyDef.type === 'shift' || keyDef.code === 42 || keyDef.code === 54) {
            this.shiftActive = !this.shiftActive;
            this._activeShiftCode = keyDef.code || 42;
            this._updateModifierUI();
            this._updateLabels();
            return;
        }

        if (keyDef.type === 'caps') {
            this.capsActive = !this.capsActive;
            this._input.tapKey(58);
            this._updateModifierUI();
            this._updateLabels();
            return;
        }

        if (keyDef.type === 'altgr') {
            this.altgrActive = !this.altgrActive;
            if (this.altgrActive) {
                this._input.pressKey(100);
            } else {
                this._input.releaseKey(100);
            }
            this._updateModifierUI();
            this._updateLabels();
            return;
        }

        // Alt toggle ON/OFF behavior
        if (keyDef.type === 'alt' || keyDef.code === 56) {
            this.altActive = !this.altActive;
            if (this.altActive) {
                this._input.pressKey(keyDef.code || 56);
            } else {
                this._input.releaseKey(keyDef.code || 56);
            }
            this._updateModifierUI();
            this._updateKeyStyle(btn, false);
            return;
        }

        // Regular key press
        if (this.shiftActive) {
            this._input.pressKey(this._activeShiftCode || 42);
        }

        this._input.pressKey(keyDef.code);

        if (!['fn', 'mod', 'ctrl', 'alt', 'super', 'shift', 'caps', 'altgr'].includes(keyDef.type)) {
            this._startKeyRepeat(keyDef);
        }
    }

    _startGesture(type, btn, event) {
        this._cleanupStageGesture();

        this._activeGesture = type;
        this._gestureBtn = btn;
        const seq = (typeof event.get_event_sequence === 'function') ? event.get_event_sequence() : null;
        this._gestureTouchSeq = seq;
        this._gestureTouchSlot = (seq && typeof seq.get_slot === 'function') ? seq.get_slot() : null;
        this._gestureIsTouch = (event.type() === Clutter.EventType.TOUCH_BEGIN);

        const [x, y] = event.get_coords();
        if (type === 'space') {
            this._spaceStartX = x;
            this._spaceDrifting = false;
            this._currentSpaceStep = 0;
        } else if (type === 'backspace') {
            this._backspaceStartX = x;
            this._backspaceSwiping = false;
            this._backspaceSelectCount = 0;
            this._startKeyRepeat(btn._keyDef);
        }

        // Cattura stage per gesture continue fino al rilascio
        this._stageGestureId = global.stage.connect('captured-event', (stage, ev) => {
            return this._onCapturedGestureEvent(ev);
        });
    }

    _cleanupStageGesture() {
        if (this._stageGestureId) {
            global.stage.disconnect(this._stageGestureId);
            this._stageGestureId = 0;
        }
        this._activeGesture = null;
        this._gestureBtn = null;
        this._gestureTouchSeq = null;
        this._gestureTouchSlot = null;
        this._gestureIsTouch = false;
    }

    _onCapturedGestureEvent(ev) {
        if (!this._activeGesture) return Clutter.EVENT_PROPAGATE;

        const type = ev.type();

        if (this._gestureIsTouch) {
            const seq = (typeof ev.get_event_sequence === 'function') ? ev.get_event_sequence() : null;
            const slot = (seq && typeof seq.get_slot === 'function') ? seq.get_slot() : null;
            const isSameTouch = (this._gestureTouchSlot !== null && slot !== null)
                ? (slot === this._gestureTouchSlot)
                : (this._gestureTouchSeq === null || seq === this._gestureTouchSeq);

            if (type === Clutter.EventType.TOUCH_BEGIN) {
                return Clutter.EVENT_STOP;
            }

            if (type === Clutter.EventType.TOUCH_UPDATE) {
                if (!isSameTouch) return Clutter.EVENT_STOP;
                this._handleGestureMotion(ev);
                return Clutter.EVENT_STOP;
            }

            if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) {
                if (!isSameTouch) return Clutter.EVENT_STOP;
                this._endGesture(ev);
                return Clutter.EVENT_STOP;
            }

            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.MOTION) {
                return Clutter.EVENT_STOP;
            }
        } else {
            if (type === Clutter.EventType.MOTION) {
                const state = (typeof ev.get_state === 'function') ? ev.get_state() : 0;
                if ((state & Clutter.ModifierType.BUTTON1_MASK) === 0) {
                    this._endGesture(ev);
                    return Clutter.EVENT_STOP;
                }
                this._handleGestureMotion(ev);
                return Clutter.EVENT_STOP;
            }

            if (type === Clutter.EventType.BUTTON_RELEASE) {
                this._endGesture(ev);
                return Clutter.EVENT_STOP;
            }

            if (type === Clutter.EventType.BUTTON_PRESS) {
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _handleGestureMotion(event) {
        const btn = this._gestureBtn;
        if (!btn || !btn._down) return;

        const [currentX, currentY] = event.get_coords();

        if (this._activeGesture === 'space') {
            const totalDx = currentX - this._spaceStartX;

            if (!this._spaceDrifting && Math.abs(totalDx) > 8) {
                this._spaceDrifting = true;
                btn.add_style_class_name('apropos-osk-space-sliding');
                btn.label = '◀  Drag  ▶';
                this._updateKeyStyle(btn, true);
            }

            if (this._spaceDrifting) {
                const sensitivity = this._settings.get_int('space-slider-sensitivity') || 16;
                const targetStep = Math.trunc(totalDx / sensitivity);
                if (targetStep !== this._currentSpaceStep) {
                    const diff = targetStep - this._currentSpaceStep;
                    const count = Math.abs(diff);
                    const keyCode = (diff > 0) ? 106 : 105;
                    for (let i = 0; i < count; i++) {
                        this._input.tapKey(keyCode);
                    }
                    this._currentSpaceStep = targetStep;
                    this._playSound();
                }
            }
        } else if (this._activeGesture === 'backspace') {
            const totalDx = currentX - this._backspaceStartX;

            if (!this._backspaceSwiping && totalDx < -10) {
                this._backspaceSwiping = true;
                this._stopKeyRepeat();
                btn.add_style_class_name('apropos-osk-backspace-sliding');
                btn.label = '◀ Delete';
                this._updateKeyStyle(btn, true);
            }

            if (this._backspaceSwiping) {
                const sensitivity = this._settings.get_int('backspace-slider-sensitivity') || 18;
                const targetCount = (totalDx < -10) ? Math.floor(Math.abs(totalDx + 10) / sensitivity) : 0;
                if (targetCount !== this._backspaceSelectCount) {
                    const diff = targetCount - this._backspaceSelectCount;
                    if (diff > 0) {
                        for (let i = 0; i < diff; i++) {
                            this._input.pressKey(42);
                            this._input.tapKey(105);
                            this._input.releaseKey(42);
                        }
                    } else if (diff < 0) {
                        const count = Math.abs(diff);
                        for (let i = 0; i < count; i++) {
                            this._input.pressKey(42);
                            this._input.tapKey(106);
                            this._input.releaseKey(42);
                        }
                    }
                    this._backspaceSelectCount = targetCount;
                    btn.label = (targetCount > 0) ? `◀ Delete (${targetCount})` : '◀ Delete';
                    this._updateKeyStyle(btn, true);
                    this._playSound();
                }
            }
        }
    }

    _endGesture(event) {
        const gesture = this._activeGesture;
        const btn = this._gestureBtn;
        this._cleanupStageGesture();

        if (!btn) return;
        btn._down = false;
        btn.remove_style_pseudo_class('pressed');
        this._updateKeyStyle(btn, false);

        if (gesture === 'space') {
            this._stopKeyRepeat();
            if (this._spaceDrifting) {
                this._spaceDrifting = false;
                this._currentSpaceStep = 0;
                btn.remove_style_class_name('apropos-osk-space-sliding');
                this._tsUnknown();
                btn.label = btn._keyDef?.label || 'Space';
                this._updateKeyStyle(btn, false);
            } else {
                this._input.tapKey(57);
                this._tsOnSpace();
            }
            return;
        }

        if (gesture === 'backspace') {
            this._stopKeyRepeat();
            if (this._backspaceSwiping) {
                this._backspaceSwiping = false;
                btn.remove_style_class_name('apropos-osk-backspace-sliding');
                btn.label = btn._keyDef?.label || 'Backspace';
                this._updateKeyStyle(btn, false);
                if (this._backspaceSelectCount > 0) {
                    this._input.tapKey(14);
                    this._playSound();
                }
                this._backspaceSelectCount = 0;
                this._tsUnknown();
                return;
            }
            this._input.tapKey(14);
            this._tsOnBackspace();
            if (this._smartPairStack.length > 0) {
                this._smartPairStack.pop();
            }
            return;
        }
    }

    _onKeyMotion(btn, keyDef, event) {
        if (this._activeGesture) {
            this._handleGestureMotion(event);
            return;
        }
        if (!btn._down) return;
        const type = event.type();
        const isTouch = (type === Clutter.EventType.TOUCH_UPDATE);
        const state = (typeof event.get_state === 'function') ? event.get_state() : 0;
        const isMouseDrag = (type === Clutter.EventType.MOTION && ((state & Clutter.ModifierType.BUTTON1_MASK) !== 0));
        if (!isTouch && !isMouseDrag) return;

        if (keyDef.type === 'space' || keyDef.type === 'backspace') {
            this._handleGestureMotion(event);
        }
    }

    _onKeyRelease(btn, keyDef, event) {
        if (this._activeGesture && this._gestureBtn === btn) {
            this._endGesture(event);
            return;
        }
        btn._down = false;
        btn.remove_style_pseudo_class('pressed');
        this._updateKeyStyle(btn, false);

        if (this.fnActive && btn._isFnNumberKey) {
            this._stopKeyRepeat();
            this._input.releaseKey(btn._fnCode);
            return;
        }

        if (keyDef.type === 'space') {
            this._stopKeyRepeat();
            if (this._spaceDrifting) {
                this._spaceDrifting = false;
                this._currentSpaceStep = 0;
                btn.remove_style_class_name('apropos-osk-space-sliding');
                this._tsUnknown();
                btn.label = keyDef.label || 'Space';
                this._updateKeyStyle(btn, false);
            } else {
                this._input.tapKey(57);
                this._tsOnSpace();
            }
            return;
        }

        if (keyDef.type === 'backspace') {
            this._stopKeyRepeat();
            if (this._backspaceSwiping) {
                this._backspaceSwiping = false;
                btn.remove_style_class_name('apropos-osk-backspace-sliding');
                btn.label = keyDef.label || 'Backspace';
                this._updateKeyStyle(btn, false);
                if (this._backspaceSelectCount > 0) {
                    this._input.tapKey(14);
                    this._playSound();
                }
                this._backspaceSelectCount = 0;
                this._tsUnknown();
                return;
            }
            this._input.tapKey(14);
            this._tsOnBackspace();
            if (this._smartPairStack.length > 0) {
                this._smartPairStack.pop();
            }
            return;
        }

        if (keyDef.type === 'super') {
            if (!this._superDown) return;
            const code = this._superCode || SUPER_KEYCODE;
            if (this._superSent) {
                // Super combo: chiusura combinazione
                this._input.releaseKey(code);
            } else {
                // Super singolo: esecuzione tap al rilascio
                this._tapSuperAlone(code);
            }
            this._superDown = false;
            this._superSent = false;
            return;
        }

        if (keyDef.behavior === 'toggle') {
            return;
        }

        if (['shift', 'caps', 'altgr', 'ctrl', 'alt', 'fn_toggle'].includes(keyDef.type)) {
            return;
        }

        this._stopKeyRepeat();
        this._input.releaseKey(keyDef.code);

        const typedLabel = btn.label;
        this._tsOnKey(keyDef, typedLabel);
        const isAutoPairs = this._settings.get_boolean('smart-auto-pairs');
        const openingPairs = { '(': ')', '[': ']', '{': '}', '"': '"', '«': '»', "'": "'" };

        // Rilascio automatico modificatori
        let modifiersChanged = false;
        if (this.shiftActive) {
            this._input.releaseKey(this._activeShiftCode || 42);
            this.shiftActive = false;
            modifiersChanged = true;
        }
        if (this.altgrActive) {
            this._input.releaseKey(100);
            this.altgrActive = false;
            modifiersChanged = true;
        }

        // Smart auto-closing
        if (isAutoPairs && openingPairs[typedLabel]) {
            const closer = openingPairs[typedLabel];
            this._oneShot(16, () => {
                this._typeCharacterByMatchingKey(closer);
                this._input.tapKey(105); // Move cursor inside
                this._smartPairStack.push(closer);
            });
        }

        if (modifiersChanged) {
            this._updateModifierUI();
            this._updateLabels();
        }
    }

    // Reset gesture scorrimento/selezione e rilascio tasti
    _resetGestureStates() {
        this._cleanupStageGesture();
        this._stopKeyRepeat();

        if (this._spaceDrifting || (this._spaceButton && this._spaceButton.has_style_class_name('apropos-osk-space-sliding'))) {
            this._spaceDrifting = false;
            this._currentSpaceStep = 0;
            if (this._spaceButton) {
                this._spaceButton._down = false;
                this._spaceButton.remove_style_pseudo_class('pressed');
                this._spaceButton.remove_style_class_name('apropos-osk-space-sliding');
                this._spaceButton.label = this._spaceButton._keyDef?.label || 'Space';
                this._updateKeyStyle(this._spaceButton, false);
            }
        }

        if (this._backspaceSwiping || (this._backspaceButton && this._backspaceButton.has_style_class_name('apropos-osk-backspace-sliding'))) {
            this._backspaceSwiping = false;
            if (this._backspaceButton) {
                this._backspaceButton._down = false;
                this._backspaceButton.remove_style_pseudo_class('pressed');
                this._backspaceButton.remove_style_class_name('apropos-osk-backspace-sliding');
                this._backspaceButton.label = this._backspaceButton._keyDef?.label || 'Backspace';
                this._updateKeyStyle(this._backspaceButton, false);
            }
            if (this._backspaceSelectCount > 0) {
                this._input.tapKey(14);
                this._playSound();
            }
            this._backspaceSelectCount = 0;
        }

        if (this._keyActors) {
            for (const b of this._keyActors) {
                if (b._down && !['shift', 'caps', 'altgr', 'ctrl', 'alt'].includes(b._keyDef?.type) && b._keyDef?.behavior !== 'toggle') {
                    b._down = false;
                    b.remove_style_pseudo_class('pressed');
                    this._updateKeyStyle(b, false);
                }
            }
        }
        if (this._isoEnter && this._isoEnter._down) {
            this._isoEnter._down = false;
            this._isoEnter.remove_style_pseudo_class('pressed');
            this._updateKeyStyle(this._isoEnter, false);
        }
    }

    _overviewTarget() {
        try {
            if (Main.overview.visibleTarget !== undefined)
                return !!Main.overview.visibleTarget;
            return !!Main.overview.visible;
        } catch (e) {
            return false;
        }
    }

    // Super singolo: tap standard o fallback panoramica Shell
    _tapSuperAlone(code) {
        const before = this._overviewTarget();
        this._input.tapKey(code);

        if (this._superFallbackId) {
            GLib.source_remove(this._superFallbackId);
            this._superFallbackId = 0;
        }
        this._superFallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._superFallbackId = 0;
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            try {
                if (!Main.overview.isDummy && this._overviewTarget() === before)
                    Main.overview.toggle();
            } catch (e) {
                console.warn('[AproposOSK] Overview fallback failed:', e.message);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _startKeyRepeat(keyDef) {
        this._stopKeyRepeat();
        this._currentRepeatCode = keyDef.code;
        this._repeatStartTime = GLib.get_monotonic_time();

        const delay = this._settings.get_int('repeat-delay') || 320;
        const interval = this._settings.get_int('repeat-interval') || 36;

        this._repeatTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._repeatTimer = null;
            this._repeatIntervalTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
                if (!this._currentRepeatCode) return GLib.SOURCE_REMOVE;
                this._tsUnknown();

                if (keyDef.type === 'backspace') {
                    const elapsed = (GLib.get_monotonic_time() - this._repeatStartTime) / 1000;
                    if (elapsed > 1200) {
                        this._input.tapKey(this._currentRepeatCode);
                    }
                }

                this._input.tapKey(this._currentRepeatCode);
                this._playSound();
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopKeyRepeat() {
        if (this._repeatTimer) {
            GLib.source_remove(this._repeatTimer);
            this._repeatTimer = null;
        }
        if (this._repeatIntervalTimer) {
            GLib.source_remove(this._repeatIntervalTimer);
            this._repeatIntervalTimer = null;
        }
        this._currentRepeatCode = null;
    }

    _updateModifierUI() {
        for (const btn of this._shiftButtons) {
            if (this.shiftActive) {
                btn.add_style_class_name('apropos-osk-key-active');
            } else {
                btn.remove_style_class_name('apropos-osk-key-active');
            }
        }

        for (const btn of this._capsButtons) {
            if (this.capsActive) {
                btn.add_style_class_name('apropos-osk-key-active');
            } else {
                btn.remove_style_class_name('apropos-osk-key-active');
            }
        }

        // Luminous Alt Gr indicator
        for (const btn of this._altgrButtons) {
            if (this.altgrActive) {
                btn.add_style_class_name('apropos-osk-key-active');
            } else {
                btn.remove_style_class_name('apropos-osk-key-active');
            }
        }

        // Luminous FN indicator
        for (const btn of this._fnButtons) {
            if (this.fnActive) {
                btn.add_style_class_name('apropos-osk-key-active');
            } else {
                btn.remove_style_class_name('apropos-osk-key-active');
            }
        }

        // Left and Right Ctrl indicators
        for (const btn of this._keyActors) {
            const def = btn._keyDef;
            if (!def) continue;
            if (def.code === 29) {
                if (this._leftCtrlActive) btn.add_style_class_name('apropos-osk-key-active');
                else btn.remove_style_class_name('apropos-osk-key-active');
            } else if (def.code === 97) {
                if (this._rightCtrlActive) btn.add_style_class_name('apropos-osk-key-active');
                else btn.remove_style_class_name('apropos-osk-key-active');
            }
        }

        // Alt indicator
        for (const btn of this._keyActors) {
            const def = btn._keyDef;
            if (!def) continue;
            if (def.type === 'alt' || def.code === 56) {
                if (this.altActive) btn.add_style_class_name('apropos-osk-key-active');
                else btn.remove_style_class_name('apropos-osk-key-active');
            }
        }

        // Indicatore Shift+Invio (A capo)
        if (this._enterButtons) {
            for (const btn of this._enterButtons) {
                if (btn._isEnterPlaceholder) continue;
                if (this.shiftActive) {
                    btn.add_style_class_name('apropos-osk-enter-shift');
                    btn.label = 'New line';
                } else {
                    btn.remove_style_class_name('apropos-osk-enter-shift');
                    btn.label = btn._keyDef?.label || 'Enter';
                }
                this._updateKeyStyle(btn, false);
            }
        }
    }

    _updateLabels() {
        this._fontFamilyCss = this._computeFontFamily();
        const isUpper = (this.shiftActive && !this.capsActive) || (!this.shiftActive && this.capsActive);

        for (const btn of this._keyActors) {
            const def = btn._keyDef;
            if (!def) continue;

            let targetLabel = def.label;
            let modType = null; // 'shift', 'altgr', 'both', 'fn'

            if (this.fnActive && btn._isFnNumberKey) {
                targetLabel = btn._fnLabel;
                modType = 'fn';
            } else if (this.shiftActive && this.altgrActive && def.shiftAltgr) {
                targetLabel = def.shiftAltgr;
                modType = 'both'; // Shift + AltGr: lighter greenish-grey
            } else if (this.altgrActive && def.altgr) {
                targetLabel = def.altgr;
                modType = 'altgr'; // AltGr: dark green infused grey
            } else if (this.shiftActive && def.shift) {
                targetLabel = def.shift;
                if (!(def.label.length === 1 && def.label.match(/[a-z]/i))) {
                    modType = 'shift'; // Shift: pure grey
                }
            } else if (isUpper && def.shift && def.label.length === 1 && def.label.match(/[a-z]/i)) {
                targetLabel = def.shift;
            } else if (def.type === 'enter') {
                targetLabel = this.shiftActive ? 'New line' : def.label;
            } else {
                targetLabel = def.label;
            }

            btn.label = targetLabel;
            btn._modType = modType;
            btn._isCurrentlyModified = (modType !== null);

            btn.remove_style_class_name('apropos-osk-key-modified');
            btn.remove_style_class_name('apropos-osk-key-modified-level1');
            btn.remove_style_class_name('apropos-osk-key-modified-level2');
            btn.remove_style_class_name('apropos-osk-key-mod-shift');
            btn.remove_style_class_name('apropos-osk-key-mod-altgr');
            btn.remove_style_class_name('apropos-osk-key-mod-both');
            btn.remove_style_class_name('apropos-osk-key-mod-fn');

            if (modType === 'shift') {
                btn.add_style_class_name('apropos-osk-key-mod-shift');
            } else if (modType === 'altgr') {
                btn.add_style_class_name('apropos-osk-key-mod-altgr');
            } else if (modType === 'both') {
                btn.add_style_class_name('apropos-osk-key-mod-both');
            } else if (modType === 'fn') {
                btn.add_style_class_name('apropos-osk-key-mod-fn');
            }

            this._updateKeyStyle(btn, false);
        }
    }

    _toggleLayout() {
        const sequence = ['it', 'us', 'custom'];
        let idx = sequence.indexOf(this._currentLayoutKey);
        if (idx === -1) idx = 0;
        const nextKey = sequence[(idx + 1) % sequence.length];

        this._currentLayoutKey = nextKey;
        this._settings.set_string('layout-variant', this._currentLayoutKey);
        this._layoutLabel.label = this._getLayoutLabelText();
        this._buildKeyboardLayout();
        this._applyGeometry();
    }

    _hasKey(name) {
        try {
            return this._settings.settings_schema.has_key(name);
        } catch (e) {
            return false;
        }
    }

    _getHeightPercent(monitor) {
        if (this._heightOverride)
            return this._heightOverride;
        const m = monitor || Main.layoutManager.primaryMonitor;
        const portrait = !!(m && m.height > m.width);
        if (portrait && this._hasKey('height-percent-portrait')) {
            const v = this._settings.get_int('height-percent-portrait');
            if (v > 0)
                return v;
        }
        return this._settings.get_int('height-percent') || 34;
    }

    _commitHeight(pct) {
        const m = Main.layoutManager.primaryMonitor;
        const portrait = !!(m && m.height > m.width);
        const key = (portrait && this._hasKey('height-percent-portrait'))
            ? 'height-percent-portrait' : 'height-percent';
        this._heightOverride = null;
        try {
            this._settings.set_int(key, pct);
        } catch (e) {}
        this._applyGeometry();
    }

    _setupDragging(handle) {
        const MIN_PCT = 20;
        const MAX_PCT = 55;
        let isDragging = false;
        let isResizing = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let actorStartX = 0;
        let actorStartY = 0;
        let startPct = 0;
        let lastPct = 0;

        handle.connect('event', (actor, event) => {
            const type = event.type();

            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
                const [x, y] = event.get_coords();
                dragStartX = x;
                dragStartY = y;
                if (this._isDocked) {
                    // Docked: dragging the bar up/down resizes the keyboard height
                    const monitor = Main.layoutManager.primaryMonitor;
                    if (!monitor) return Clutter.EVENT_PROPAGATE;
                    isResizing = true;
                    startPct = this._getHeightPercent(monitor);
                    lastPct = startPct;
                    return Clutter.EVENT_STOP;
                }
                // Floating: dragging the bar moves the keyboard
                isDragging = true;
                const [ax, ay] = this.actor.get_position();
                actorStartX = ax;
                actorStartY = ay;
                return Clutter.EVENT_STOP;
            } else if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                if (isResizing) {
                    const monitor = Main.layoutManager.primaryMonitor;
                    const [, y] = event.get_coords();
                    let pct = Math.round(startPct + ((dragStartY - y) / monitor.height) * 100);
                    pct = Math.max(MIN_PCT, Math.min(MAX_PCT, pct));
                    if (pct !== lastPct) {
                        lastPct = pct;
                        this._heightOverride = pct;
                        this._applyGeometry();
                    }
                    return Clutter.EVENT_STOP;
                }
                if (isDragging) {
                    const [x, y] = event.get_coords();
                    const newX = Math.max(0, Math.min(Main.layoutManager.primaryMonitor.width - this.actor.width, actorStartX + (x - dragStartX)));
                    const newY = Math.max(30, Math.min(Main.layoutManager.primaryMonitor.height - this.actor.height, actorStartY + (y - dragStartY)));
                    this.actor.set_position(newX, newY);
                    return Clutter.EVENT_STOP;
                }
            } else if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END ||
                       type === Clutter.EventType.TOUCH_CANCEL) {
                if (isResizing) {
                    isResizing = false;
                    this._commitHeight(lastPct);
                    return Clutter.EVENT_STOP;
                }
                if (isDragging) {
                    isDragging = false;
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _updateStruts() {
        const actorData = Main.layoutManager._trackedActors?.find(a => a.actor === this.actor);
        const shouldAffect = this.isOpen && this._isDocked && this._dockFullStrip;
        if (actorData) {
            if (actorData.affectsStruts !== shouldAffect) {
                actorData.affectsStruts = shouldAffect;
                Main.layoutManager._queueUpdateRegions();
            }
        }
    }

    _applyGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        this._isDocked = this._settings.get_boolean('dock-bottom');
        this._dockFullStrip = this._settings.get_boolean('dock-full-strip');
        const isCenteredKeysInStrip = this._settings.get_boolean('full-strip-centered-keys');
        this._updateHeaderButtons();

        const widthPercent = this._settings.get_int('width-percent') || 80;
        const heightPercent = this._getHeightPercent(monitor);
        const gapX = this._settings.get_int('key-gap-x') || 4;
        const gapY = this._settings.get_int('key-gap-y') || 4;
        const numGap = this._settings.get_int('number-row-gap') || 8;
        const radius = this._settings.get_int('key-radius') || 8;
        const paddingBottom = Math.max(4, this._settings.get_int('padding-bottom') || 8);

        let targetW, posX, posY;

        if (this._dockFullStrip && this._isDocked) {
            targetW = monitor.width;
            posX = monitor.x;
        } else {
            targetW = Math.round(monitor.width * (widthPercent / 100));
            posX = monitor.x + Math.round((monitor.width - targetW) / 2);
        }

        const numRows = (this._rows && this._rows.length) ? this._rows.length : 5;

        // Padding orizzontale contenitore
        const containerPadH = 24;
        let availableW = targetW - containerPadH;

        // Altezza intestazione
        const headerHeight = 32;
        // Padding verticale contenitore
        const containerPadV = 6 + paddingBottom;
        const suggestH = this._tsBarHeight();
        const nonKeyH = headerHeight + suggestH + containerPadV + numGap + ((numRows - 1) * gapY);

        const reqH = Math.round(monitor.height * (heightPercent / 100));
        let keyHeight = Math.floor((reqH - nonKeyH) / numRows);

        // Altezza minima tasto 34px
        const minKeyHeight = 34;
        if (keyHeight < minKeyHeight) {
            keyHeight = minKeyHeight;
        }

        // Altezza effettiva contenitore
        const actualH = nonKeyH + (numRows * keyHeight);

        if (this._isDocked) {
            if (this._dockFullStrip) {
                posY = monitor.y + monitor.height - actualH;
                this.actor.add_style_class_name('apropos-osk-full-strip');
                this.actor.remove_style_class_name('apropos-osk-floating');
            } else {
                posY = monitor.y + monitor.height - actualH;
                this.actor.remove_style_class_name('apropos-osk-full-strip');
                this.actor.remove_style_class_name('apropos-osk-floating');
            }
        } else {
            posY = monitor.y + Math.round(monitor.height - actualH - 50);
            this.actor.add_style_class_name('apropos-osk-floating');
            this.actor.remove_style_class_name('apropos-osk-full-strip');
        }

        this.actor.set_size(targetW, actualH);
        this.actor.set_position(posX, posY);

        // Full-strip con tasti centrati
        if (this._dockFullStrip && this._isDocked && isCenteredKeysInStrip) {
            const normalW = Math.round(monitor.width * (widthPercent / 100));
            availableW = normalW - containerPadH;
            this._keysBox.set_width(normalW);
            this._keysBox.set_x_align(Clutter.ActorAlign.CENTER);
            this._header.set_width(normalW);
            this._header.set_x_align(Clutter.ActorAlign.CENTER);
            this._tsSizeBar(suggestH, normalW);
        } else {
            this._keysBox.set_width(-1);
            this._keysBox.set_x_align(Clutter.ActorAlign.FILL);
            this._header.set_width(-1);
            this._header.set_x_align(Clutter.ActorAlign.FILL);
            this._tsSizeBar(suggestH, -1);
        }

        // Font ad alta leggibilita (default) o personalizzato
        this._fontFamilyCss = this._computeFontFamily();
        if (this._headerBtns) {
            for (const hb of this._headerBtns) {
                hb.set_style(`font-family: "${this._fontFamilyCss}"; font-size: 13px;`);
                const ct = this._getClutterText(hb);
                if (ct) {
                    ct.font_name = `${this._fontFamilyCss} 13px`;
                }
            }
        }

        this._tsStyleBar();

        // Apply container padding dynamically
        this.actor.set_style(`padding: 6px 12px ${paddingBottom}px 12px;`);

        // Style the keys and rows
        if (this._rows) {
            let yCursor = 0;
            for (let r = 0; r < this._rows.length; r++) {
                const row = this._rows[r];
                const isNumRow = (r === 0 && row.box.has_style_class_name('apropos-osk-number-row'));
                const isLastRow = (r === this._rows.length - 1);

                // Row vertical gap / number row gap
                let rowMarginBottom = gapY;
                if (isNumRow) {
                    rowMarginBottom = numGap;
                } else if (isLastRow) {
                    rowMarginBottom = 0;
                }
                row.box.set_style(`margin-bottom: ${rowMarginBottom}px; padding: 0;`);
                row.top = yCursor;
                yCursor += keyHeight + rowMarginBottom;

                const totalUnits = row.defs.reduce((acc, d) => acc + (d.width || 1.0), 0);
                const keyCount = row.keys.length;
                const totalGaps = (keyCount - 1) * gapX;
                const netRowW = availableW - totalGaps;
                const unitWidth = netRowW / totalUnits;

                row.xs = [];
                row.ws = [];
                let usedWidth = 0;
                let xCursor = 0;
                for (let i = 0; i < keyCount; i++) {
                    const btn = row.keys[i];
                    const def = row.defs[i];
                    const flex = def.width || 1.0;

                    let kw;
                    if (i === keyCount - 1) {
                        // Chiusura bordo destro riga
                        kw = Math.max(28, netRowW - usedWidth);
                    } else {
                        kw = Math.max(28, Math.round(flex * unitWidth));
                        usedWidth += kw;
                    }

                    const marginRight = (i === keyCount - 1) ? 0 : gapX;
                    row.xs[i] = xCursor;
                    row.ws[i] = kw;
                    xCursor += kw + gapX;

                    btn.set_size(kw, keyHeight);
                    btn._keyW = kw;
                    btn._keyH = keyHeight;
                    btn._baseRadius = radius;
                    btn._baseMarginRight = marginRight;
                    this._updateKeyStyle(btn, false);
                }
            }

            // Overlay Invio ISO su segnaposto
            this._layoutIsoEnter(keyHeight, radius);
        }

        this._updateHeaderButtons();
        this._updateStruts();
    }

    // ------------------------------------------------------------------
    // Word suggestions
    // ------------------------------------------------------------------
    _tsInit() {
        this._tsReady = true;
        this._tsBuf = '';
        this._tsSuppress = false;
        this._tsShown = [];
        this._tsLastTypeUs = 0;
        this._tsBase = null;
        this._tsTail = null;
        this._tsTailId = 0;
        this._tsLearned = {};
        this._tsLearnedDirty = false;
        this._tsSaveId = 0;
        this._tsPlayId = 0;
        this._tsStageId = 0;
        this._tsLoadLearned();
        this._tbShown = [];
        try {
            this._tbBridge = new TypingBoosterBridge(() => this._tsRefresh());
            this._tbSettingIds = ['use-typing-booster', 'suggestions-enabled']
                .filter(k => this._hasKey(k))
                .map(k => this._settings.connect(`changed::${k}`, () => this._tbSync()));
            // Re-check the engine whenever the focused field changes type (e.g. Chrome's
            // address bar reports URL). Notifications come in bursts, so coalesce them.
            this._tbFieldSyncId = 0;
            this._tbImIds = ['notify::content-purpose', 'notify::content-hints'].map(sig =>
                Main.inputMethod.connect(sig, () => {
                    if (this._tbFieldSyncId)
                        return;
                    this._tbFieldSyncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this._tbFieldSyncId = 0;
                        if (this._tbWanted())
                            this._tbSync();
                        return GLib.SOURCE_REMOVE;
                    });
                }));
        } catch (err) {
            console.warn('[AproposOSK] typing-booster bridge unavailable:', err);
            this._tbBridge = null;
        }
    }

    // Field type check from the Clutter-side purpose/hints (not the IBus copies in
    // im._purpose/_hints, whose hint bits differ). Does not require a focus object, so it
    // can gate the engine before the shell has finished focusing the field.
    _fieldTypeAllowed() {
        try {
            const im = Main.inputMethod;
            if (!im)
                return false;
            const P = Clutter.InputContentPurpose;
            const blocked = [P.PASSWORD, P.PIN, P.TERMINAL, P.URL, P.EMAIL, P.DIGITS, P.NUMBER, P.PHONE]
                .filter(v => v !== undefined);
            const purpose = im.contentPurpose ?? im.content_purpose;
            if (purpose !== undefined && purpose !== null && blocked.includes(purpose))
                return false;
            const H = Clutter.InputContentHintFlags;
            const hints = im.contentHints ?? im.content_hints ?? 0;
            const bad = (H.SENSITIVE_DATA ?? 0) | (H.HIDDEN_TEXT ?? 0);
            if (hints & bad)
                return false;
            return true;
        } catch (err) {
            return false;
        }
    }

    // ---- typing-booster mode ---------------------------------------------
    _tbWanted() {
        try {
            return this._tsEnabled() && this._hasKey('use-typing-booster') &&
                this._settings.get_boolean('use-typing-booster');
        } catch (err) {
            return false;
        }
    }

    _tbOn() {
        return !!(this._tbBridge && this._tbBridge.active);
    }

    _tbSync() {
        if (!this._tbBridge)
            return;
        try {
            // typing-booster composes words as preedit; in URL/e-mail/password fields that
            // breaks inline autocompletion (Chrome's address bar), so use plain xkb there.
            if (this.isOpen && this._tbWanted() && this._fieldTypeAllowed())
                this._tbBridge.start();
            else
                this._tbBridge.stop();
        } catch (err) {
            console.warn('[AproposOSK] typing-booster sync failed:', err);
        }
        this._tsRefresh();
    }

    _tsEnabled() {
        try {
            return !!this._tsReady && this._hasKey('suggestions-enabled') &&
                this._settings.get_boolean('suggestions-enabled');
        } catch (err) {
            return false;
        }
    }

    _tsBarHeight() {
        return this._tsEnabled() ? 36 : 0;
    }

    // Only suggest/learn in ordinary text fields: never passwords, terminals, numbers, URLs, e-mail
    _tsFieldAllowed() {
        try {
            const im = Main.inputMethod;
            if (!im || !im.currentFocus)
                return false;
            return this._fieldTypeAllowed();
        } catch (err) {
            return false;
        }
    }

    _tsBuildBarWidgets() {
        this._suggestBar = new St.BoxLayout({
            style_class: 'apropos-osk-suggest-bar',
            vertical: false,
            x_expand: true,
            y_expand: false,
        });
        this._suggestBtns = [];
        // Slots left..right -> candidate rank (0 = best).
        // Typing-booster mode uses all six (shown as 6 4 1 2 3 5); the built-in list keeps its
        // old three middle slots with the best word in the centre (-1 = slot hidden).
        const order = [5, 3, 0, 1, 2, 4];
        const tsOrder = [-1, 1, 0, 2, -1, -1];
        for (let slot = 0; slot < order.length; slot++) {
            const btn = new St.Button({
                label: '',
                x_expand: true,
                y_expand: true,
                reactive: false,
                can_focus: false,
            });
            btn._rank = order[slot];
            btn._tsRank = tsOrder[slot];
            btn.visible = btn._tsRank >= 0;
            btn.opacity = 0;
            btn.connect('clicked', () => {
                if (this._tbOn()) {
                    const c = this._tbShown && this._tbShown[btn._rank];
                    if (c && typeof c.cb === 'function') {
                        try {
                            c.cb();
                        } catch (err) {
                            console.warn('[AproposOSK] typing-booster commit failed:', err);
                        }
                    }
                    return;
                }
                const w = this._tsShown && this._tsShown[btn._tsRank];
                if (w)
                    this._tsAccept(w);
            });
            this._suggestBar.add_child(btn);
            this._suggestBtns.push(btn);
        }
    }

    _buildSuggestBar() {
        if (!this._tsReady)
            this._tsInit();
        this._tsBuildBarWidgets();
        this.actor.add_child(this._suggestBar);
    }

    _tsSizeBar(h, w) {
        const bar = this._suggestBar;
        if (!bar)
            return;
        bar.visible = h > 0;
        bar.set_height(h > 0 ? h : -1);
        bar.set_width(w);
        bar.set_x_align(w > 0 ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL);
        this._tsRefresh();
    }

    _tsStyleBar() {
        if (!this._suggestBtns)
            return;
        const fam = this._fontFamilyCss || 'sans-serif';
        for (const b of this._suggestBtns) {
            b.set_style(`font-family: "${fam}"; font-size: 15px; color: #f3f3f3; ` +
                'background-color: rgba(255, 255, 255, 0.07); border-radius: 6px; margin: 3px 3px; padding: 0 8px;');
            const ct = this._getClutterText(b);
            if (ct)
                ct.font_name = `${fam} 15px`;
        }
    }

    // ---- data -----------------------------------------------------------
    _tsLoadBase() {
        if (this._tsBase)
            return;
        this._tsBase = [];
        try {
            const p = GLib.build_filenamev([this._extension.path, 'words-en.txt']);
            const [ok, bytes] = Gio.File.new_for_path(p).load_contents(null);
            if (ok) {
                this._tsBase = new TextDecoder().decode(bytes).split('\n')
                    .map(s => s.trim()).filter(Boolean);
            }
        } catch (err) {
            console.warn('[AproposOSK] Could not load words-en.txt:', err);
        }
    }

    // Larger word pool (if the system spell-check dictionary is installed), loaded when idle
    _tsLoadTail() {
        if (this._tsTail || this._tsTailId)
            return;
        this._tsTailId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._tsTailId = 0;
            try {
                const f = Gio.File.new_for_path('/usr/share/hunspell/en_US.dic');
                if (f.query_exists(null)) {
                    const [ok, bytes] = f.load_contents(null);
                    if (ok) {
                        const known = new Set(this._tsBase || []);
                        const out = [];
                        const lines = new TextDecoder().decode(bytes).split('\n');
                        for (let i = 1; i < lines.length; i++) {
                            const w = lines[i].split('/')[0].trim();
                            if (/^[a-z]{3,14}$/.test(w) && !known.has(w))
                                out.push(w);
                        }
                        out.sort((a, b) => (a.length - b.length) || (a < b ? -1 : 1));
                        this._tsTail = out;
                    }
                }
            } catch (err) {}
            if (!this._tsTail)
                this._tsTail = [];
            return GLib.SOURCE_REMOVE;
        });
    }

    _tsLearnedPath() {
        return GLib.build_filenamev([GLib.get_user_config_dir(), 'apropos-osk', 'learned-words.json']);
    }

    _tsLoadLearned() {
        try {
            const f = Gio.File.new_for_path(this._tsLearnedPath());
            if (!f.query_exists(null))
                return;
            const [ok, bytes] = f.load_contents(null);
            if (ok) {
                const obj = JSON.parse(new TextDecoder().decode(bytes));
                if (obj && typeof obj === 'object')
                    this._tsLearned = obj;
            }
        } catch (err) {
            console.warn('[AproposOSK] Could not read learned words:', err);
        }
    }

    _tsSaveNow() {
        if (!this._tsLearnedDirty)
            return;
        try {
            const dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'apropos-osk']);
            GLib.mkdir_with_parents(dir, 0o700);
            const f = Gio.File.new_for_path(this._tsLearnedPath());
            f.replace_contents(JSON.stringify(this._tsLearned), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
            this._tsLearnedDirty = false;
        } catch (err) {
            console.warn('[AproposOSK] Could not save learned words:', err);
        }
    }

    _tsScheduleSave() {
        if (this._tsSaveId)
            return;
        this._tsSaveId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
            this._tsSaveId = 0;
            this._tsSaveNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _tsFlushSave() {
        if (this._tsSaveId) {
            GLib.source_remove(this._tsSaveId);
            this._tsSaveId = 0;
        }
        this._tsSaveNow();
    }

    _tsLearn(word, inc = 1) {
        this._tsLearned[word] = Math.min(1000, (this._tsLearned[word] || 0) + inc);
        this._tsLearnedDirty = true;
        const keys = Object.keys(this._tsLearned);
        if (keys.length > 2500) {
            for (const w of keys) {
                if (this._tsLearned[w] <= 1)
                    delete this._tsLearned[w];
                if (Object.keys(this._tsLearned).length <= 2000)
                    break;
            }
        }
        this._tsScheduleSave();
    }

    // ---- state tracking -------------------------------------------------
    _tsReset(suppress = false) {
        if (!this._tsReady)
            return;
        this._tsBuf = '';
        this._tsSuppress = suppress;
        this._tsRefresh();
    }

    // The text before the cursor is no longer known: stay quiet until the next word boundary
    _tsUnknown() {
        this._tsReset(true);
    }

    _tsCommit() {
        const w = this._tsBuf;
        if (this._tsSuppress || w.length < 3 || !/^\p{L}+$/u.test(w))
            return;
        if (!this._tsFieldAllowed())
            return;
        this._tsLearn(w.toLowerCase());
    }

    _tsOnKey(keyDef, label) {
        if (!this._tsEnabled() || this._tbOn())
            return;
        const now = GLib.get_monotonic_time();
        if (this._tsBuf && (now - this._tsLastTypeUs) > 20 * 1000000)
            this._tsBuf = '';   // long pause: the cursor may have moved
        this._tsLastTypeUs = now;

        const t = keyDef.type;
        const mods = this._leftCtrlActive || this._rightCtrlActive || this.altActive || this._superDown;
        if (mods) {
            this._tsUnknown();
            return;
        }
        if (t === 'enter' || t === 'fn') {
            this._tsCommit();
            this._tsReset(false);
            return;
        }
        if (t || !label || Array.from(label).length !== 1) {
            this._tsUnknown();
            return;
        }
        if (/^\p{L}$/u.test(label)) {
            if (!this._tsSuppress) {
                this._tsBuf += label;
                this._tsRefresh();
            }
            return;
        }
        if (label === "'" || label === '\u2019') {
            this._tsReset(true);   // contractions: stay quiet until the next word
            return;
        }
        if (/^\p{N}$/u.test(label)) {
            this._tsReset(true);
            return;
        }
        this._tsCommit();
        this._tsReset(false);
    }

    _tsOnBackspace() {
        if (!this._tsEnabled() || this._tbOn())
            return;
        if (this._tsBuf.length > 0) {
            const a = Array.from(this._tsBuf);
            a.pop();
            this._tsBuf = a.join('');
            this._tsRefresh();
        } else {
            this._tsSuppress = true;
        }
    }

    _tsOnSpace() {
        if (!this._tsEnabled() || this._tbOn())
            return;
        this._tsCommit();
        this._tsReset(false);
    }

    _tsOnOpen() {
        if (!this._tsEnabled())
            return;
        this._tsLoadBase();
        this._tsLoadTail();
        this._tsReset(false);
        this._tsAttachStage();
        if (this._tbWanted())
            this._tbSync();
    }

    _tsOnClose() {
        try {
            if (this._tbBridge)
                this._tbBridge.stop();
        } catch (err) {}
        this._tsDetachStage();
        if (this._tsReady) {
            this._tsReset(false);
            this._tsFlushSave();
        }
    }

    _tsAttachStage() {
        this._tsDetachStage();
        // A tap anywhere outside the keyboard may move the cursor
        this._tsStageId = global.stage.connect('captured-event', (stage, ev) => {
            const t = ev.type();
            if (t === Clutter.EventType.BUTTON_PRESS || t === Clutter.EventType.TOUCH_BEGIN) {
                const src = ev.get_source();
                if (this.actor && src && !this.actor.contains(src))
                    this._tsUnknown();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _tsDetachStage() {
        if (this._tsStageId) {
            global.stage.disconnect(this._tsStageId);
            this._tsStageId = 0;
        }
    }

    _tsDestroy() {
        try {
            if (this._tbSettingIds)
                this._tbSettingIds.forEach(id => this._settings.disconnect(id));
            this._tbSettingIds = null;
            if (this._tbImIds)
                this._tbImIds.forEach(id => Main.inputMethod.disconnect(id));
            this._tbImIds = null;
            if (this._tbFieldSyncId) {
                GLib.source_remove(this._tbFieldSyncId);
                this._tbFieldSyncId = 0;
            }
            if (this._tbBridge)
                this._tbBridge.destroy();
            this._tbBridge = null;
        } catch (err) {}
        this._tsDetachStage();
        if (!this._tsReady)
            return;
        if (this._tsTailId) {
            GLib.source_remove(this._tsTailId);
            this._tsTailId = 0;
        }
        if (this._tsPlayId) {
            GLib.source_remove(this._tsPlayId);
            this._tsPlayId = 0;
        }
        this._tsFlushSave();
    }

    // ---- suggestions ----------------------------------------------------
    _tsSuggest(typed) {
        if (!this._tsBase)
            return [];
        const prefix = typed.toLowerCase();
        const n = prefix.length;
        const res = new Map();
        const put = (w, s) => {
            if (!res.has(w) || res.get(w) < s)
                res.set(w, s);
        };
        const base = this._tsBase;
        for (let i = 0; i < base.length; i++) {
            const w = base[i];
            if (w.length > n && w.startsWith(prefix)) {
                const c = this._tsLearned[w] || 0;
                put(w, 4000 - i + Math.min(c, 20) * 150);
            }
        }
        for (const w in this._tsLearned) {
            const c = this._tsLearned[w];
            if (c >= 2 && w.length > n && w.startsWith(prefix))
                put(w, 1500 + Math.min(c, 40) * 150);
        }
        if (res.size < 3 && this._tsTail) {
            for (const w of this._tsTail) {
                if (w.length > n && w.startsWith(prefix) && !res.has(w)) {
                    put(w, 100 - Math.min(w.length, 60));
                    if (res.size >= 12)
                        break;
                }
            }
        }
        return [...res.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
    }

    _tsMimicCase(typed, word) {
        if (typed.length > 1 && typed === typed.toUpperCase() && typed !== typed.toLowerCase())
            return word.toUpperCase();
        const first = Array.from(typed)[0];
        if (first !== first.toLowerCase())
            return word.charAt(0).toUpperCase() + word.slice(1);
        return word;
    }

    _tsRefresh() {
        if (!this._suggestBtns)
            return;
        if (this._tbOn()) {
            // Candidates from typing-booster; best one goes to the centre slot (rank 0)
            let c = [];
            if (this._tsEnabled() && this._tsFieldAllowed())
                c = this._tbBridge.candidates.slice(0, 6);
            this._tbShown = c;
            this._tsShown = [];
            for (const b of this._suggestBtns) {
                b.visible = true;
                const w = (c[b._rank] && c[b._rank].text) || '';
                b.label = w;
                b.reactive = !!w;
                b.opacity = w ? 255 : 0;
            }
            return;
        }
        this._tbShown = [];
        let words = [];
        if (this._tsEnabled() && !this._tsSuppress && this._tsBuf.length >= 2 && this._tsFieldAllowed())
            words = this._tsSuggest(this._tsBuf).map(w => this._tsMimicCase(this._tsBuf, w));
        this._tsShown = words;
        for (const b of this._suggestBtns) {
            b.visible = b._tsRank >= 0;
            const w = words[b._tsRank] || '';
            b.label = w;
            b.reactive = !!w;
            b.opacity = w ? 255 : 0;
        }
    }

    // ---- accepting a suggestion ----------------------------------------
    _tsKeyFor(ch) {
        const isLetter = ch.toLowerCase() !== ch.toUpperCase();
        for (const btn of this._keyActors) {
            const def = btn._keyDef;
            if (!def || !def.code)
                continue;
            if (def.label === ch)
                return { code: def.code, shift: isLetter && this.capsActive };
            if (def.shift === ch)
                return { code: def.code, shift: !(isLetter && this.capsActive) };
        }
        return null;
    }

    _tsPlay(steps) {
        if (this._tsPlayId) {
            GLib.source_remove(this._tsPlayId);
            this._tsPlayId = 0;
        }
        let i = 0;
        this._tsPlayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (i >= steps.length || !this._input) {
                this._tsPlayId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const s = steps[i++];
            if (s.shift)
                this._input.pressKey(42);
            this._input.pressKey(s.code);
            this._oneShot(8, () => {
                if (this._input) {
                    this._input.releaseKey(s.code);
                    if (s.shift)
                        this._input.releaseKey(42);
                }
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    _tsAccept(word) {
        const typed = this._tsBuf;
        if (!word || !typed)
            return;
        const steps = [];
        for (let i = 0; i < Array.from(typed).length; i++)
            steps.push({ code: 14, shift: false });
        for (const ch of Array.from(word)) {
            const key = this._tsKeyFor(ch);
            if (!key)
                return;   // this word cannot be typed on the current layout
            steps.push(key);
        }
        steps.push({ code: 57, shift: false });   // trailing space
        this._tsLearn(word.toLowerCase());
        this._tsBuf = '';
        this._tsSuppress = false;
        this._tsRefresh();
        this._tsPlay(steps);
    }

    _computeFontFamily() {
        let custom = (this._settings.get_string('font-family') || '').trim();
        custom = custom.replace(/[;{}"'\\]/g, '');
        return custom || DEFAULT_FONT_NAME;
    }

    // Font scaling dinamico
    _fitFont(text, base, keyW, keyH) {
        const scale = (this._settings.get_int('font-scale') || 100) / 100;
        const len = Math.max(1, Array.from(text || '').length);
        const byWidth = Math.floor((keyW - 12) / (len * 0.6));
        const byHeight = Math.floor(keyH * 0.5);
        return Math.max(11, Math.min(Math.round(base * scale), byWidth, byHeight));
    }

    _fontSizeFor(btn) {
        const def = btn._keyDef;
        const text = btn.label || '';
        const n = Array.from(text).length;
        let base;
        if (def.type === 'arrow') base = 20;
        else if (n <= 1) base = 24;
        else if (n <= 3) base = 20;
        else base = 18;
        return this._fitFont(text, base, btn._keyW || 64, btn._keyH || 50);
    }

    _updateKeyStyle(btn, isPressed = false) {
        const def = btn._keyDef;
        if (!def) return;

        // Invio ISO: Cairo su DrawingArea, sfondo trasparente
        if (btn._isIsoEnter) {
            btn.set_style('background-color: transparent !important; border: none !important; box-shadow: none !important;');
            if (btn._redraw) btn._redraw();
            return;
        }

        const marginRight = (btn._baseMarginRight !== undefined) ? btn._baseMarginRight : 4;

        // Segnaposto trasparente
        if (btn._isEnterPlaceholder) {
            btn.set_style(`margin-right: ${marginRight}px; background-color: transparent !important; border: none !important; box-shadow: none !important;`);
            return;
        }

        const radius = btn._baseRadius || 8;
        const family = this._fontFamilyCss || this._computeFontFamily();
        const fontSize = this._fontSizeFor(btn);

        let s = `border-radius: ${radius}px; margin-right: ${marginRight}px; font-family: "${family}"; font-size: ${fontSize}px; font-weight: normal;`;

        const isToggled = (def.behavior === 'toggle' && (this._toggleKeyStates?.get(def.code) || false));
        const isActiveOrPressed = isPressed || isToggled;

        const modBg = this._settings.get_string('modified-key-bg-color') || '';
        const modText = this._settings.get_string('modified-key-text-color') || '';

        if (isActiveOrPressed) {
            if (def.activeColor) {
                s += ` background-color: ${def.activeColor} !important; border-color: ${def.activeColor} !important;`;
            } else if (def.bgColor) {
                s += ` background-color: ${def.bgColor};`;
            }
        } else {
            if (btn._modifiedLevel >= 2 && modBg) {
                s += ` background-color: ${modBg} !important; filter: brightness(1.2);`;
            } else if (btn._modifiedLevel === 1 && modBg) {
                s += ` background-color: ${modBg} !important;`;
            } else if (def.bgColor) {
                s += ` background-color: ${def.bgColor} !important;`;
            }
        }

        if (btn._isCurrentlyModified && modText) {
            s += ` color: ${modText} !important;`;
        } else if (def.textColor) {
            s += ` color: ${def.textColor} !important;`;
        }
        btn.set_style(s);

        const ct = this._getClutterText(btn);
        if (ct) {
            ct.font_name = `${family} ${fontSize}px`;
        }
    }

    // Risoluzione attore Clutter.Text
    _getClutterText(actor) {
        if (!actor) return null;
        if (actor instanceof Clutter.Text || typeof actor.set_font_name === 'function')
            return actor;
        if (actor.clutter_text)
            return actor.clutter_text;
        const child = actor.get_first_child ? actor.get_first_child() : (actor.get_child ? actor.get_child() : null);
        if (child) {
            if (child instanceof Clutter.Text || typeof child.set_font_name === 'function')
                return child;
            if (child.clutter_text)
                return child.clutter_text;
        }
        return null;
    }

    _setupSettingsListeners() {
        const keys = [
            'width-percent',
            'height-percent',
            'key-radius',
            'key-gap-x',
            'key-gap-y',
            'number-row-gap',
            'padding-bottom',
            'dock-bottom',
            'dock-full-strip',
            'full-strip-centered-keys',
            'suggestions-enabled',
            'modified-key-bg-color',
            'modified-key-text-color',
        ];

        for (const k of keys) {
            const id = this._settings.connect(`changed::${k}`, () => {
                this._updateLabels();
                this._applyGeometry();
            });
            this._settingsSignals.push(id);
        }

        // Live Font reload
        for (const k of ['font-family', 'font-scale']) {
            const id = this._settings.connect(`changed::${k}`, () => {
                this._fontFamilyCss = this._computeFontFamily();
                this._applyGeometry();
                this._updateLabels();
                if (this._isoEnter && this._isoEnter._redraw) {
                    this._isoEnter._redraw();
                }
            });
            this._settingsSignals.push(id);
        }

        // Live Custom Layout reload
        const tokenSignalId = this._settings.connect('changed::custom-layout-token', () => {
            this._currentLayoutKey = this._settings.get_string('layout-variant');
            if (this._layoutLabel) {
                this._layoutLabel.label = this._getLayoutLabelText();
            }
            this._buildKeyboardLayout();
            this._applyGeometry();
        });
        this._settingsSignals.push(tokenSignalId);

        const layoutId = this._settings.connect('changed::layout-variant', () => {
            this._currentLayoutKey = this._settings.get_string('layout-variant');
            if (this._layoutLabel) {
                this._layoutLabel.label = this._getLayoutLabelText();
            }
            this._buildKeyboardLayout();
            this._applyGeometry();
        });
        this._settingsSignals.push(layoutId);

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            if (this.isOpen)
                this._applyGeometry();
        });
    }

    open() {
        this._resetGestureStates();
        this.isOpen = true;
        this._tsOnOpen();
        this.actor.show();
        this.actor.opacity = 255;
        this._applyGeometry();

        if (this.actor.get_parent()) {
            this.actor.get_parent().set_child_above_sibling(this.actor, null);
        }

        this._updateStruts();
        this._settings.set_boolean('keyboard-visible', true);
        this._extension.updateToggleState(true);
    }

    close() {
        this._resetGestureStates();
        this._stopKeyRepeat();
        this._input.releaseAll();
        this._superDown = false;
        this._superSent = false;
        this._enterDelegate = null;
        if (this._leftCtrlActive) {
            this._input.releaseKey(29);
            this._leftCtrlActive = false;
        }
        if (this._rightCtrlActive) {
            this._input.releaseKey(97);
            this._rightCtrlActive = false;
        }
        if (this.shiftActive) {
            this._input.releaseKey(this._activeShiftCode || 42);
            this.shiftActive = false;
        }
        if (this.altActive) {
            this._input.releaseKey(56);
            this.altActive = false;
        }
        this._updateModifierUI();
        this._tsOnClose();
        this.isOpen = false;
        this.actor.hide();

        this._updateStruts();
        this._settings.set_boolean('keyboard-visible', false);
        this._extension.updateToggleState(false);
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    // Short high-priority timer that is cancelled in destroy().
    _oneShot(ms, fn) {
        this._oneShotIds ??= new Set();
        const id = GLib.timeout_add(GLib.PRIORITY_HIGH, ms, () => {
            this._oneShotIds.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._oneShotIds.add(id);
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._oneShotIds ?? [])
            GLib.source_remove(id);
        this._oneShotIds?.clear();
        this._tsDestroy();
        this._cleanupStageGesture();
        this._stopKeyRepeat();
        if (this._superFallbackId) {
            GLib.source_remove(this._superFallbackId);
            this._superFallbackId = 0;
        }

        if (this._restackedId) {
            global.display.disconnect(this._restackedId);
            this._restackedId = null;
        }

        if (this._focusNotifyId) {
            global.stage.disconnect(this._focusNotifyId);
            this._focusNotifyId = null;
        }

        for (const id of this._settingsSignals) {
            this._settings.disconnect(id);
        }
        this._settingsSignals = [];

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        this.isOpen = false;
        this._updateStruts();

        if (this.actor) {
            Main.layoutManager.untrackChrome(this.actor);
            if (this.actor.get_parent()) {
                this.actor.get_parent().remove_child(this.actor);
            }
            this.actor.destroy();
            this.actor = null;
        }
    }
}
