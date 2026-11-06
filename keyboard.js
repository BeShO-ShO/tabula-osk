import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import IBus from 'gi://IBus';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import { getIBusManager } from 'resource:///org/gnome/shell/misc/ibusManager.js';
import { getInputSourceManager } from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import { Layouts, loadCustomLayout } from './layouts.js';
import * as TL from './textlogic.js';
import { SpellChecker } from './spell.js';

// Characters after which a just-typed word is checked by autocorrect
const AC_TERMINATORS = new Set([' ', '.', ',', '!', '?', ';', ':']);

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
    constructor(onChange, isOpen = () => false) {
        this._onChange = onChange;
        this._isOpen = isOpen;
        this._active = false;
        this._weEnabled = false;
        this._cands = [];
        this._visible = false;
        this._idleId = 0;
        this._queue = Promise.resolve();
        this._saved = null;
        this._uiSaved = null;
        this._capCtx = null;
        this._actualEngine = null;
        this._engineSigId = 0;
        this._checkIds = new Set();
    }

    // Started by us, or typing-booster running anyway while the keyboard is open (e.g.
    // left over from a start that timed out): either way its candidates belong in our bar
    get active() {
        return this._active || this._strayTb();
    }

    // Candidates of the current page, best first: [{ text, cb }]
    get candidates() {
        return this._visible ? this._cands : [];
    }

    // The engine IBus really runs. The Shell's IBusManager drops engine changes while it
    // is not "ready" and a timed-out switch leaves its name out of date, so follow the bus.
    _engine() {
        return this._actualEngine ?? this._mgr?._currentEngineName ?? null;
    }

    _strayTb() {
        try {
            return this._isOpen() && this._engine() === TB_ENGINE;
        } catch (e) {
            return false;
        }
    }

    _collecting() {
        return this._active || this._strayTb();
    }

    _available() {
        try {
            const m = getIBusManager();
            return !!(m && m._ready && m._engines && m._engines.has(TB_ENGINE));
        } catch (e) {
            return false;
        }
    }

    // Engine tracking + candidate routing stay installed for the bridge's lifetime and
    // are gated on _collecting(), so a stale flag can never send candidates to the
    // Shell's popup next to the text while our keyboard is open.
    _setup() {
        if (this._uiSaved)
            return;
        const m = getIBusManager();
        if (!m)
            return;
        this._mgr = m;
        try {
            if (m._ibus && !this._engineSigId) {
                this._engineSigId = m._ibus.connect('global-engine-changed', (bus, name) => {
                    this._actualEngine = name;
                    this._notify();
                });
            }
        } catch (e) {}
        this._hookUi();
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
        this._setup();
        if (!this._available())
            return;
        const m = this._mgr;
        this._active = true;
        try {
            this._hook();
            if (this._engine() === TB_ENGINE) {
                // Already running (a start that timed out and came up late): adopt it, so
                // stop() switches back to the keyboard layout's engine
                this._weEnabled = true;
            } else {
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
                }
                this._weEnabled = true;
            }
            try {
                Main.inputMethod.update();
            } catch (e) {}
        } catch (e) {
            // typing-booster can take longer than the Shell's 4 s limit on its first
            // start; the Shell has already switched to it and the engine still comes up,
            // so keep going (otherwise words sit in preedit with no suggestion bar)
            const timedOut = e instanceof GLib.Error &&
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT);
            if (!timedOut || !this._active) {
                this._active = false;
                this._unhook();
                throw e;
            }
            this._weEnabled = true;
            console.warn('[AproposOSK] typing-booster slow to start, continuing');
        }
        // GNOME 51 swallows that timeout and falls back to plain xkb: check that
        // typing-booster really runs and ask again if not
        this._check(2500, () => this._ensureStarted());
        this._check(7000, () => this._ensureStarted());
        this._notify();
    }

    _ensureStarted() {
        if (!this._active || !this._isOpen())
            return;
        const eng = this._engine();
        if (eng === TB_ENGINE)
            return;
        try {
            this._mgr._setEngine(TB_ENGINE).catch(() => {});
        } catch (e) {}
    }

    async _doStop() {
        if (!this._active) {
            // Nothing of ours, but typing-booster may still be running (stray)
            this._check(300, () => this._ensureStopped());
            return;
        }
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
        this._check(400, () => this._ensureStopped());
        this._notify();
    }

    // Keyboard closed but typing-booster still the engine: switch back to the current
    // input source's engine (what the Shell itself does when a source is activated)
    _ensureStopped() {
        if (this._active || this._isOpen() || this._engine() !== TB_ENGINE)
            return;
        try {
            if (this._mgr?._oskCompletion)
                return;   // the stock keyboard turned completion on itself
            const ism = getInputSourceManager();
            const src = ism?.currentSource;
            if (!src || src.type === 'ibus' && src.id === TB_ENGINE)
                return;   // typing-booster is the user's own input source
            ism.activateInputSource(src, false);
        } catch (e) {}
    }

    _check(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._checkIds.delete(id);
            try {
                fn();
            } catch (e) {}
            return GLib.SOURCE_REMOVE;
        });
        this._checkIds.add(id);
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

    // ---- hooks (instance overrides, removed again in _unhookUi/_unhook) ----
    _override(list, obj, name, fn) {
        const own = Object.prototype.hasOwnProperty.call(obj, name);
        list.push({ obj, name, own, value: obj[name] });
        obj[name] = fn;
    }

    _restore(list) {
        for (const s of (list ?? []).reverse()) {
            try {
                if (s.own)
                    s.obj[s.name] = s.value;
                else
                    delete s.obj[s.name];
            } catch (e) {}
        }
    }

    _hookUi() {
        this._uiSaved = [];
        const self = this;
        const kb = Main.keyboard;
        const origAdd = kb.addSuggestion;
        const origReset = kb.resetSuggestions;
        const origVis = kb.setSuggestionsVisible;
        this._override(this._uiSaved, kb, 'addSuggestion', function (text, cb) {
            try {
                if (self._collecting()) {
                    self._cands.push({ text: String(text ?? ''), cb });
                    self._notify();
                }
            } catch (e) {}
            return origAdd.call(this, text, cb);
        });
        this._override(this._uiSaved, kb, 'resetSuggestions', function () {
            try {
                if (self._collecting()) {
                    self._cands = [];
                    self._hookCaps();
                    self._notify();
                }
            } catch (e) {}
            return origReset.call(this);
        });
        this._override(this._uiSaved, kb, 'setSuggestionsVisible', function (visible) {
            try {
                if (self._collecting()) {
                    self._visible = !!visible;
                    self._notify();
                }
            } catch (e) {}
            return origVis.call(this, visible);
        });

        // Keep the Shell's floating candidate popup closed while our bar shows the candidates
        const popup = this._mgr && this._mgr._candidatePopup;
        if (popup && typeof popup._updateVisibility === 'function') {
            const origUpd = popup._updateVisibility;
            this._override(this._uiSaved, popup, '_updateVisibility', function () {
                let ours = false;
                try {
                    ours = self._collecting();
                } catch (e) {}
                if (ours) {
                    try {
                        this.close(BoxPointer.PopupAnimation.NONE);
                    } catch (e) {}
                    return;
                }
                return origUpd.call(this);
            });
        }
    }

    _hook() {
        this._unhook();
        this._saved = [];
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
        this._restore(this._saved);
        this._saved = null;
    }

    destroy() {
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        for (const id of this._checkIds)
            GLib.source_remove(id);
        this._checkIds.clear();
        this._onChange = () => {};
        this._isOpen = () => false;
        // Synchronous part of stop: never leave our overrides behind
        const wasEnabled = this._weEnabled;
        this._active = false;
        this._weEnabled = false;
        this._unhook();
        this._restore(this._uiSaved);
        this._uiSaved = null;
        if (this._engineSigId && this._mgr?._ibus) {
            try {
                this._mgr._ibus.disconnect(this._engineSigId);
            } catch (e) {}
        }
        this._engineSigId = 0;
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

        // Typing assistance (long-press, auto-capitalization, double-space period, autocorrect)
        this._keySeq = 0;            // bumped on every key press and cursor move
        this._typed = null;          // text typed since the cursor was last moved (null = unknown)
        this._autoShift = false;     // Shift was turned on by auto-capitalization
        this._shiftSent = false;     // Shift is physically held for the current key
        this._acSuppressSeq = -1;
        this._lastSpaceUs = 0;
        this._lastSpaceSeq = -1;
        this._lastShiftTapUs = 0;
        this._lp = null;             // long-press state
        this._lastCorrection = null;
        this._spell = null;
        this._freq = null;
        this._waiters = new Set();
        this._accentCache = new Map();

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
            // A different field: nothing is known about the text before the cursor
            this._trkUnknown();
            this._acUpdate();
        });

        // Auto-capitalization follows the real text when the app reports it
        this._surroundingId = Main.inputMethod.connect('surrounding-text-set', () => this._acUpdate());

        this._applyTheme();
    }

    _buildUI() {
        this.actor = new St.BoxLayout({
            name: 'apropos-osk',
            style_class: 'apropos-osk-container',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
            can_focus: false,
        });

        this.actor.connect('event', (actor, event) => {
            const type = event.type();
            // Keys stop their own events, so a press arriving here hit empty space
            if (type === Clutter.EventType.TOUCH_BEGIN ||
                (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1)) {
                if (!this._activeGesture && this._deadZonePress(event))
                    return Clutter.EVENT_STOP;
            }
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
        // Move/resize grip: a thin coloured strip across the top edge. The reactive area is
        // a little taller than the visible strip so it is still easy to grab by touch.
        this._handleBox = new St.Bin({
            style_class: 'apropos-osk-handle-box',
            track_hover: true,
            x_expand: true,
            y_expand: false,
            reactive: true,
            can_focus: false,
        });
        this._dragHandle = new St.Widget({
            style_class: 'apropos-osk-handle',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._handleBox.set_child(this._dragHandle);
        this._setupDragging(this._handleBox);
        this.actor.add_child(this._handleBox);

        // Header row: [layout] [suggestions ...] [Cfg Dock Norm X]
        // (_buildSuggestBar puts the suggestion bar between the two button groups)
        this._header = new St.BoxLayout({
            style_class: 'apropos-osk-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_expand: false,
        });
        this._headerRow = this._header;

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

        // Fills the middle when the suggestion bar is hidden (suggestions off)
        this._headerSpacer = new St.Widget({ x_expand: true });
        this._headerRow.add_child(this._headerSpacer);

        // Pulsanti intestazione destra
        const rightBtns = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
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
        const shown = { phone: "tablet" }[this._currentLayoutKey] || this._currentLayoutKey;
        return `[${shown.toUpperCase()}]`;
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
            orientation: Clutter.Orientation.VERTICAL,
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
        this._layout = layout;
        this._hintActors = [];

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
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                y_expand: false,
            });
            const rowKeys = [];
            spec.defs.forEach((keyDef, k) => {
                let btn;
                const isIsoPart = iso && (
                    (iso.top.r === r && iso.top.i === k) ||
                    (iso.bottom.r === r && iso.bottom.i === k));
                if (keyDef.type === 'spacer') {
                    // Empty gap (e.g. the half-key indent of a phone layout's middle row)
                    btn = new St.Widget({ reactive: false });
                    btn._keyDef = keyDef;
                    btn._isSpacer = true;
                } else if (isIsoPart) {
                    // Segnaposto spaziatore riga
                    btn = new St.Widget({
                        reactive: false,
                        style: 'background-color: transparent !important; border: none !important; box-shadow: none !important;',
                    });
                    btn._keyDef = keyDef;
                    btn._isEnterPlaceholder = true;
                } else {
                    btn = this._createKeyButton(keyDef, spec.isNumber, k);
                    this._setupLongPress(btn, keyDef, layout);
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
            if (this._isMaterial()) {
                const light = this._isLight();
                fill = light ? [0.04, 0.34, 0.82, pressed ? 0.8 : 1] : [0.66, 0.78, 0.98, pressed ? 0.8 : 1];
                stroke = fill;
            } else if (pressed) {
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

    // ------------------------------------------------------------------
    // Long-press (accents and symbols)
    // ------------------------------------------------------------------

    // Accented variants from GNOME's own on-screen keyboard layouts
    // (/usr/share/gnome-shell/gnome-shell-osk-layouts.gresource), read at runtime.
    _accentsFor(name) {
        if (!name)
            return new Map();
        if (this._accentCache.has(name))
            return this._accentCache.get(name);
        const map = new Map();
        try {
            if (!this._oskResource) {
                const dir = global.datadir || '/usr/share/gnome-shell';
                this._oskResource = Gio.Resource.load(GLib.build_filenamev([dir, 'gnome-shell-osk-layouts.gresource']));
            }
            const bytes = this._oskResource.lookup_data(`/org/gnome/shell/osk-layouts/${name}.json`,
                Gio.ResourceLookupFlags.NONE);
            const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            for (const level of data.levels || []) {
                for (const row of level.rows || []) {
                    for (const key of row) {
                        const s = key.strings;
                        if (Array.isArray(s) && s.length > 1 && !map.has(s[0]))
                            map.set(s[0], s.slice(1));
                    }
                }
            }
        } catch (e) {
            console.warn('[AproposOSK] GNOME accent data unavailable:', e.message);
        }
        this._accentCache.set(name, map);
        return map;
    }

    _setupLongPress(btn, keyDef, layout) {
        if (!layout.longPress)
            return;
        if (keyDef.lpAlt) {
            // Super key: hold latches Alt (no popup), the hint shows that
            this._addHint(btn, keyDef.hint || 'Alt');
            return;
        }
        if (keyDef.lpKeys && keyDef.lpKeys.length) {
            // Special keys (Tab, Esc...) offered on long-press: popup shows their names
            btn._longpress = keyDef.lpKeys.map(k => k.label);
            btn._lpCodes = new Map(keyDef.lpKeys.map(k => [k.label, k.code]));
            // Modifiers held around the key: `mods: [codes]`, or `shift: true` for [42]
            btn._lpMods = new Map(keyDef.lpKeys.map(k => [k.label, k.mods ?? (k.shift ? [42] : [])]));
            // Entry highlighted when the popup opens (index into lpKeys, default the first)
            btn._lpDefault = Number.isInteger(keyDef.lpDefault) ? keyDef.lpDefault : 0;
            if (keyDef.hint)
                this._addHint(btn, keyDef.hint);
            if (keyDef.hintLeft)
                this._addHint(btn, keyDef.hintLeft, true);
            return;
        }
        if (keyDef.type)
            return;
        const items = [];
        const add = c => {
            if (c && c !== keyDef.label && !items.includes(c))
                items.push(c);
        };
        (keyDef.longpress || []).forEach(add);
        // `noAccents: true`: only the key's own list (no symbols from GNOME's layout data)
        if (!keyDef.noAccents)
            (this._accentsFor(layout.accents).get(keyDef.label) || []).forEach(add);
        if (items.length === 0)
            return;
        btn._longpress = items;
        if (keyDef.hint)
            this._addHint(btn, keyDef.hint);
    }

    _addHint(btn, text, left = false) {
        const hint = new St.Label({
            text,
            style_class: 'apropos-osk-hint',
            reactive: false,
        });
        hint._btn = btn;
        // Hints on the accent-coloured Enter key take the key's text colour
        if (btn._keyDef?.type === 'enter')
            hint.add_style_class_name('apropos-osk-hint-accent');
        this._overlay.add_child(hint);
        if (left)
            btn._hintLeftActor = hint;
        else
            btn._hintActor = hint;
        this._hintActors.push(hint);
    }

    // Sticky Alt on/off (Alt key, or long-press on a Super key with lpAlt)
    _toggleAlt() {
        this.altActive = !this.altActive;
        if (this.altActive)
            this._input.pressKey(56);
        else
            this._input.releaseKey(56);
        this._updateModifierUI();
    }

    _superLpCancel() {
        const st = this._superLp;
        this._superLp = null;
        if (st && st.timer) {
            GLib.source_remove(st.timer);
            st.timer = 0;
        }
        return st;
    }

    _longPressOn() {
        try {
            return this._settings.get_boolean('long-press');
        } catch (e) {
            return false;
        }
    }

    _lpEligible(btn) {
        return this._longPressOn() && !!btn._longpress && !this.fnActive &&
            !this._leftCtrlActive && !this._rightCtrlActive && !this.altActive && !this._superDown;
    }

    _lpItems(btn) {
        const upper = this._lettersUpper();
        return btn._longpress.map(c => {
            if (!upper || btn._lpCodes)
                return c;
            const u = c.toUpperCase();
            return (c !== u && Array.from(u).length === 1) ? u : c;
        });
    }

    _lpShow() {
        const lp = this._lp;
        if (!lp || this._activeGesture !== 'longpress' || !lp.btn.get_stage())
            return;
        const btn = lp.btn;
        lp.items = this._lpItems(btn);
        const [kx, ky] = btn.get_transformed_position();
        const kw = btn._keyW || btn.width;
        const kh = btn._keyH || btn.height;
        const cellW = Math.round(Math.max(kw * 0.95, 34));
        const cellH = Math.round(Math.max(kh * 0.95, 34));
        const pad = 4;
        const n = lp.items.length;
        const popupW = n * cellW + pad * 2;
        const monitor = Main.layoutManager.findMonitorForActor(btn) || Main.layoutManager.primaryMonitor;

        const popup = new St.BoxLayout({
            style_class: 'apropos-osk-lp-popup',
            orientation: Clutter.Orientation.HORIZONTAL,
            reactive: false,
        });
        for (const cls of this._themeClasses())
            popup.add_style_class_name(cls);
        const fam = this._fontFamilyCss || this._computeFontFamily();
        const fs = Math.round(Math.min(cellH * 0.45, 26));
        lp.cells = lp.items.map(text => {
            const label = new St.Label({
                text,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.set_style(`font-family: "${fam}"; font-size: ${fs}px;`);
            const cell = new St.Bin({
                style_class: 'apropos-osk-lp-cell',
                child: label,
            });
            cell.set_size(cellW, cellH);
            popup.add_child(cell);
            return cell;
        });
        // First cell sits right above the key; the row grows to the right, or to the left
        // when it would run off the screen
        let x = kx + kw / 2 - cellW / 2 - pad;
        if (monitor) {
            const maxX = monitor.x + monitor.width - popupW - 2;
            if (x > maxX)
                x = Math.max(monitor.x + 2, kx + kw / 2 + cellW / 2 + pad - popupW);
            x = Math.max(monitor.x + 2, Math.min(x, maxX));
        }
        const y = Math.max(monitor ? monitor.y : 0, ky - cellH - pad * 2 - 6);
        popup.set_position(Math.round(x), Math.round(y));
        Main.layoutManager.uiGroup.add_child(popup);
        Main.layoutManager.uiGroup.set_child_above_sibling(popup, null);

        lp.popup = popup;
        lp.x0 = x + pad;
        lp.cellW = cellW;
        lp.cancelY = ky + kh * 1.6;
        // Without a hint symbol the first entry is an accent: start on it as Gboard does.
        // Keys may name another entry as the default (e.g. ▼ starts on PgDn).
        lp.def = Math.max(0, Math.min(n - 1, btn._lpDefault ?? 0));
        this._lpSelect(lp.def);
    }

    _lpSelect(idx) {
        const lp = this._lp;
        if (!lp || !lp.cells)
            return;
        lp.sel = idx;
        lp.cells.forEach((c, i) => {
            if (i === idx)
                c.add_style_class_name('apropos-osk-lp-cell-selected');
            else
                c.remove_style_class_name('apropos-osk-lp-cell-selected');
        });
    }

    _lpMotion(event) {
        const lp = this._lp;
        if (!lp || !lp.popup)
            return;
        const [x, y] = event.get_coords();
        if (y > lp.cancelY) {
            this._lpSelect(-1);
            return;
        }
        // A non-first default stays chosen until the finger really slides sideways
        if (lp.def && lp.px !== undefined && Math.abs(x - lp.px) < lp.cellW / 2) {
            if (lp.sel !== lp.def)
                this._lpSelect(lp.def);
            return;
        }
        const n = lp.cells.length;
        const idx = Math.max(0, Math.min(n - 1, Math.floor((x - lp.x0) / lp.cellW)));
        if (idx !== lp.sel)
            this._lpSelect(idx);
    }

    _lpDispose(lp) {
        if (!lp)
            return;
        if (lp.timer) {
            GLib.source_remove(lp.timer);
            lp.timer = 0;
        }
        if (lp.popup) {
            lp.popup.destroy();
            lp.popup = null;
        }
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

        if (isNumberRow && indexInRow >= 1 && indexInRow <= 12 && !keyDef.type) {
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
        } else if (['mod', 'ctrl', 'alt', 'super', 'tab'].includes(keyDef.type)) {
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
        // `special: true`: drawn like the modifier keys (e.g. Backspace on the Tablet layout)
        if (keyDef.special)
            btn.add_style_class_name('apropos-osk-key-mod');

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

        // Split key: one button (one hit area) drawn as two small stacked keys.
        if (keyDef.split) {
            btn.add_style_class_name('apropos-osk-split');
            const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true });
            btn._splitHalves = Array.from(keyDef.label.split('\n')).map((t, i) => {
                const lbl = new St.Label({ text: t, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true });
                const half = new St.Bin({
                    style_class: 'apropos-osk-key apropos-osk-arrow apropos-osk-split-half',
                    x_expand: true, y_expand: true, child: lbl,
                });
                half._code = keyDef.split[i];
                half._label = lbl;
                box.add_child(half);
                return half;
            });
            btn._splitBox = box;
            btn.set_child(box);
        }

        this._setupKeyEvents(btn, keyDef);
        return btn;
    }

    _setupKeyEvents(btn, keyDef) {
        // Kept on the button so a tap in the empty space around keys can be handed to it
        btn._oskOnEvent = (actor, event) => {
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
        };
        btn.connect('event', btn._oskOnEvent);
    }

    // ------------------------------------------------------------------
    // Dead zones: a tap in the empty space of the key area (padding below the bottom
    // row, gaps between keys, side padding, half-key indents) goes to the nearest key,
    // like Gboard. Header, suggestions and resize handle are not part of it.
    // ------------------------------------------------------------------
    _deadZoneKey(x, y) {
        if (!this._keysBox || !this.isOpen)
            return null;
        const [, ky] = this._keysBox.get_transformed_position();
        const [ax, ay] = this.actor.get_transformed_position();
        const [aw, ah] = this.actor.get_transformed_size();
        if (y < ky - 2 || y > ay + ah || x < ax || x > ax + aw)
            return null;
        const MAX = 30;
        let best = null, bestD = Infinity;
        for (const k of this._keyActors) {
            if (!k || !k.visible || !k.mapped || k._isSpacer || k._isEnterPlaceholder)
                continue;
            const [kx, kyy] = k.get_transformed_position();
            const [kw, kh] = k.get_transformed_size();
            const dx = x < kx ? kx - x : (x > kx + kw ? x - (kx + kw) : 0);
            const dy = y < kyy ? kyy - y : (y > kyy + kh ? y - (kyy + kh) : 0);
            const d = Math.hypot(dx, dy);
            if (d < bestD) {
                bestD = d;
                best = k;
            }
        }
        // ISO Enter (drawn shape with its own hit test) is never a target: a tap near it
        // does nothing rather than risk the wrong key
        if (!best || bestD > MAX || !best._oskOnEvent)
            return null;
        return best;
    }

    _deadZonePress(event) {
        const [x, y] = event.get_coords();
        const btn = this._deadZoneKey(x, y);
        if (!btn)
            return false;
        const seq = (typeof event.get_event_sequence === 'function') ? event.get_event_sequence() : null;
        const slot = (seq && typeof seq.get_slot === 'function') ? seq.get_slot() : null;
        const isTouch = event.type() === Clutter.EventType.TOUCH_BEGIN;
        const id = isTouch ? `t${slot ?? 'x'}` : 'm';
        this._deadZoneDrop(id);
        btn._oskOnEvent(btn, event);
        // Follow this touch/click until it ends and hand motion and release to the key.
        // A gesture the key started (space slide, backspace swipe, long-press) captures
        // the stage before this handler, so it then runs as usual.
        const entry = { btn, seq, slot, isTouch, stageId: 0 };
        entry.stageId = global.stage.connect('captured-event', (stage, ev) => this._deadZoneEvent(id, entry, ev));
        this._deadZones ??= new Map();
        this._deadZones.set(id, entry);
        return true;
    }

    _deadZoneEvent(id, entry, ev) {
        const T = Clutter.EventType;
        const type = ev.type();
        // The key's own gesture already took the release
        if (!entry.btn._down && !(this._activeGesture && this._gestureBtn === entry.btn)) {
            this._deadZoneDrop(id);
            return Clutter.EVENT_PROPAGATE;
        }
        if (this._activeGesture)
            return Clutter.EVENT_PROPAGATE;
        let mine = false;
        if (entry.isTouch) {
            if (type === T.TOUCH_UPDATE || type === T.TOUCH_END || type === T.TOUCH_CANCEL) {
                const seq = (typeof ev.get_event_sequence === 'function') ? ev.get_event_sequence() : null;
                const slot = (seq && typeof seq.get_slot === 'function') ? seq.get_slot() : null;
                mine = (entry.slot !== null && slot !== null) ? slot === entry.slot : seq === entry.seq;
            }
        } else {
            mine = type === T.MOTION || type === T.BUTTON_RELEASE;
        }
        if (!mine)
            return Clutter.EVENT_PROPAGATE;
        const end = type === T.TOUCH_END || type === T.TOUCH_CANCEL || type === T.BUTTON_RELEASE;
        if (end)
            this._deadZoneDrop(id);
        entry.btn._oskOnEvent(entry.btn, ev);
        return end ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _deadZoneDrop(id) {
        const e = this._deadZones?.get(id);
        if (!e)
            return;
        if (e.stageId)
            global.stage.disconnect(e.stageId);
        e.stageId = 0;
        this._deadZones.delete(id);
    }

    _deadZoneDropAll() {
        for (const id of [...(this._deadZones?.keys() ?? [])])
            this._deadZoneDrop(id);
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
        // Another key while Super is held: a Super combo, not an Alt long-press
        this._superLpCancel();
        if (this._superDown && !this._superSent) {
            this._input.pressKey(this._superCode);
            this._superSent = true;
        }
    }

    _onKeyPress(btn, keyDef, event) {
        // Split key (▲ over ▼): the half that was touched decides the key code. The
        // choice is kept on the button so release and key repeat use the same code.
        if (keyDef.split) {
            keyDef = { ...keyDef, code: this._splitCode(btn, keyDef, event) };
            btn._splitDef = keyDef;
        }
        this._keySeq++;
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
            this._superLpCancel();
            // Alt latched: a tap on this key just unlatches it (handled on release)
            this._superUnlatch = !!(keyDef.lpAlt && this.altActive);
            if (keyDef.lpAlt && this._longPressOn() && !this._superUnlatch) {
                const delay = Math.max(150, this._settings.get_int('long-press-delay') || 350);
                const st = { t0: this._eventTime(event), delay, fired: false, timer: 0 };
                st.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    st.timer = 0;
                    if (this._superLp === st && this._superDown && !this._superSent && !this._destroyed) {
                        st.fired = true;
                        this._toggleAlt();
                        this._playSound();
                    }
                    return GLib.SOURCE_REMOVE;
                });
                this._superLp = st;
            }
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
            this._trkUnknown();
            if (this._releaseOneShotMods()) {
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
            const now = GLib.get_monotonic_time();
            const phone = !!(this._layout && this._layout.longPress);
            if (phone && this.capsActive) {
                // Phone style: Shift turns Caps Lock off again
                this.capsActive = false;
                this._input.tapKey(58);
                this.shiftActive = false;
            } else if (phone && !this._autoShift && this.shiftActive && now - this._lastShiftTapUs < 400000) {
                // Phone style: double-tap Shift = Caps Lock
                this.shiftActive = false;
                this.capsActive = true;
                this._input.tapKey(58);
            } else {
                // A manual tap on an auto-capitalized Shift means "lowercase, please"
                this.shiftActive = this._autoShift ? false : !this.shiftActive;
            }
            this._autoShift = false;
            this._acSuppressSeq = this._keySeq;
            this._lastShiftTapUs = now;
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

        // Keys with accents/symbols: wait to see whether this is a tap or a long press
        if (this._lpEligible(btn)) {
            this._startGesture('longpress', btn, event);
            return;
        }

        // Regular key press
        this._pressRegular(keyDef);

        if (!['fn', 'mod', 'ctrl', 'alt', 'super', 'shift', 'caps', 'altgr'].includes(keyDef.type)) {
            this._startKeyRepeat(keyDef);
        }
    }

    _splitCode(btn, keyDef, event) {
        try {
            const [, y] = event.get_coords();
            const [, top] = btn.get_transformed_position();
            const h = btn._keyH || btn.height;
            return y < top + h / 2 ? keyDef.split[0] : keyDef.split[1];
        } catch (e) {
            return keyDef.split[0];
        }
    }

    // Plain A-Z keys only: on other keys Shift gives a different symbol (Italian è -> é),
    // not the capital letter
    _isLetterDef(keyDef) {
        const l = keyDef && keyDef.label;
        return !!keyDef && !keyDef.type && typeof l === 'string' && /^[a-z]$/i.test(l);
    }

    // Letters are upper case (Shift xor Caps Lock)
    _lettersUpper() {
        return this.shiftActive !== this.capsActive;
    }

    // Shift for every key (manual Shift). Auto-capitalization only shifts letters, so
    // Enter stays Enter and digits stay digits at the start of a sentence.
    _shiftAll() {
        return this.shiftActive && !this._autoShift;
    }

    _pressRegular(keyDef) {
        let shift = this.shiftActive && (!this._autoShift || this._isLetterDef(keyDef));
        // `invShift`: the key's own symbol is the shifted one of its key code (| on the \ key)
        if (keyDef.invShift)
            shift = !shift;
        if (shift) {
            this._input.pressKey(this._activeShiftCode || 42);
            this._shiftSent = true;
        }
        this._input.pressKey(keyDef.code);
    }

    // One-shot Shift/AltGr end after a typed character
    _releaseOneShotMods() {
        let changed = false;
        if (this._shiftSent)
            this._input.releaseKey(this._activeShiftCode || 42);
        this._shiftSent = false;
        if (this.shiftActive) {
            this.shiftActive = false;
            this._autoShift = false;
            changed = true;
        }
        if (this.altgrActive) {
            this._input.releaseKey(100);
            this.altgrActive = false;
            changed = true;
        }
        return changed;
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
        if (type === 'longpress') {
            const delay = Math.max(150, this._settings.get_int('long-press-delay') || 350);
            const lp = { btn, keyDef: btn._keyDef, popup: null, sel: -1, timer: 0, delay, t0: this._eventTime(event), px: x };
            lp.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                lp.timer = 0;
                if (this._lp === lp)
                    this._lpShow();
                return GLib.SOURCE_REMOVE;
            });
            this._lp = lp;
        } else if (type === 'space') {
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
        if (this._lp) {
            this._lpDispose(this._lp);
            this._lp = null;
        }
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
                // Fast two-thumb typing: a new touch while a key waits for long-press
                // turns that key into a normal tap and lets the new touch through
                if (this._activeGesture === 'longpress' && !(this._lp && this._lp.popup)) {
                    this._endGesture(ev);
                    return Clutter.EVENT_PROPAGATE;
                }
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

        if (this._activeGesture === 'longpress') {
            this._lpMotion(event);
            return;
        }

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

    // Event timestamp in ms (from the input device), or 0 when unknown
    _eventTime(event) {
        try {
            return (event && typeof event.get_time === 'function' && event.get_time()) || 0;
        } catch (e) {
            return 0;
        }
    }

    _endGesture(event) {
        const gesture = this._activeGesture;
        const btn = this._gestureBtn;
        const lp = this._lp;
        this._lp = null;
        this._cleanupStageGesture();

        if (!btn) {
            this._lpDispose(lp);
            return;
        }
        btn._down = false;
        btn.remove_style_pseudo_class('pressed');
        this._updateKeyStyle(btn, false);

        if (gesture === 'longpress') {
            // The timer can fire late-but-first when the Shell was busy (e.g. the first app
            // search): the events' own timestamps tell whether the finger was really held
            const t1 = this._eventTime(event);
            const quick = !!(lp && lp.popup && lp.t0 && t1 && t1 >= lp.t0 && t1 - lp.t0 < lp.delay);
            const shown = !!(lp && lp.popup) && !quick;
            const choice = shown && lp.sel >= 0 ? lp.items[lp.sel] : null;
            this._lpDispose(lp);
            const keyDef = btn._keyDef;
            if (shown) {
                const code = choice && btn._lpCodes && btn._lpCodes.get(choice);
                if (code) {
                    this._keySeq++;
                    this._tsUnknown();
                    const mods = btn._lpMods?.get(choice) ?? [];
                    if (mods.length)
                        this._input.tapCombo(mods, code);
                    else
                        this._input.tapKey(code);
                } else if (choice) {
                    this._commitChar(choice);
                }
                return;
            }
            // Released before the popup opened: an ordinary tap
            this._pressRegular(keyDef);
            btn._down = true;
            this._onKeyRelease(btn, keyDef, event);
            return;
        }

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
                this._onSpaceTap();
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
            this._onBackspaceTap();
            return;
        }
    }

    _onBackspaceTap() {
        // Backspace right after an autocorrection puts the original word back
        if (this._tryRevertCorrection())
            return;
        this._input.tapKey(14);
        this._tsOnBackspace();
        this._trkBackspace();
        if (this._smartPairStack.length > 0) {
            this._smartPairStack.pop();
        }
        this._acUpdate();
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
        if (keyDef.split) {
            if (!btn._splitDef)
                return;
            keyDef = btn._splitDef;
            btn._splitDef = null;
        }
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
                this._onSpaceTap();
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
            this._onBackspaceTap();
            return;
        }

        if (keyDef.type === 'super') {
            if (!this._superDown) return;
            const code = this._superCode || SUPER_KEYCODE;
            const st = this._superLpCancel();
            if (st && st.fired) {
                // Held: Alt was latched. A late timer on a quick tap (busy Shell) is undone.
                const t1 = this._eventTime(event);
                const quick = st.t0 && t1 && t1 >= st.t0 && t1 - st.t0 < st.delay;
                this._superDown = false;
                this._superSent = false;
                if (!quick)
                    return;
                this._toggleAlt();
                this._tapSuperAlone(code);
                return;
            }
            const unlatch = this._superUnlatch;
            this._superUnlatch = false;
            if (this._superSent) {
                // Super combo: chiusura combinazione
                this._input.releaseKey(code);
            } else if (unlatch) {
                // Tap while Alt latched: back to normal (no Super tap)
                if (this.altActive)
                    this._toggleAlt();
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
        this._trkOnKey(keyDef, typedLabel);
        const isAutoPairs = this._settings.get_boolean('smart-auto-pairs');
        const openingPairs = { '(': ')', '[': ']', '{': '}', '"': '"', '«': '»', "'": "'" };

        // Rilascio automatico modificatori
        const modifiersChanged = this._releaseOneShotMods();

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
        this._acUpdate();
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
        // Phone layout has no Caps key: Shift shows Caps Lock (lit + ⇪ glyph)
        const phoneCaps = !!(this._layout && this._layout.longPress) && this.capsActive;
        for (const btn of this._shiftButtons) {
            if (this.shiftActive || phoneCaps) {
                btn.add_style_class_name('apropos-osk-key-active');
            } else {
                btn.remove_style_class_name('apropos-osk-key-active');
            }
            if (phoneCaps)
                btn.add_style_class_name('apropos-osk-key-locked');
            else
                btn.remove_style_class_name('apropos-osk-key-locked');
            const base = btn._keyDef?.label;
            if (base === '⇧' || base === '⇪')
                btn.label = phoneCaps ? '⇪' : base;
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
            if (def.type === 'alt' || def.code === 56 || def.lpAlt) {
                if (this.altActive) btn.add_style_class_name('apropos-osk-key-active');
                else btn.remove_style_class_name('apropos-osk-key-active');
            }
            if (def.lpAlt) {
                // Super key with latched Alt reads "Alt" while it is held
                btn.label = this.altActive ? 'Alt' : def.label;
                if (btn._hintActor)
                    btn._hintActor.visible = !this.altActive;
            }
        }

        // Indicatore Shift+Invio (A capo)
        if (this._enterButtons) {
            for (const btn of this._enterButtons) {
                if (btn._isEnterPlaceholder) continue;
                if (this._shiftAll()) {
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
        const isUpper = this._lettersUpper();
        const shiftAll = this._shiftAll();

        for (const btn of this._keyActors) {
            const def = btn._keyDef;
            if (!def) continue;

            let targetLabel = def.label;
            let modType = null; // 'shift', 'altgr', 'both', 'fn'
            const isLetter = this._isLetterDef(def);

            if (this.fnActive && btn._isFnNumberKey) {
                targetLabel = btn._fnLabel;
                modType = 'fn';
            } else if (shiftAll && this.altgrActive && def.shiftAltgr) {
                targetLabel = def.shiftAltgr;
                modType = 'both'; // Shift + AltGr: lighter greenish-grey
            } else if (this.altgrActive && def.altgr) {
                targetLabel = def.altgr;
                modType = 'altgr'; // AltGr: dark green infused grey
            } else if (isLetter && def.shift) {
                // Letters follow Shift xor Caps Lock
                targetLabel = isUpper ? def.shift : def.label;
            } else if (shiftAll && def.shift) {
                targetLabel = def.shift;
                if (def.shift !== def.label)
                    modType = 'shift'; // Shift: pure grey
            } else if (def.lpAlt && this.altActive) {
                targetLabel = 'Alt';
            } else if (def.type === 'enter') {
                targetLabel = shiftAll ? 'New line' : def.label;
            } else if (def.type === 'shift' && def.label === '⇧' && this.capsActive &&
                       this._layout && this._layout.longPress) {
                targetLabel = '⇪';
            } else {
                targetLabel = def.label;
            }

            if (!def.split)
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
        // Only the layouts chosen in Preferences, in their fixed order
        const all = ['it', 'us', 'phone', 'custom'];
        let chosen = [];
        try {
            if (this._hasKey('layout-cycle'))
                chosen = this._settings.get_strv('layout-cycle');
        } catch (e) {}
        let sequence = all.filter(k => chosen.includes(k));
        if (sequence.length === 0)
            sequence = all;
        const idx = sequence.indexOf(this._currentLayoutKey);
        // Current layout not in the list: go to the first chosen one
        const nextKey = idx === -1 ? sequence[0] : sequence[(idx + 1) % sequence.length];
        if (nextKey === this._currentLayoutKey)
            return;

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
        let isTouch = false;
        let slot = null;
        let seq = null;

        const seqOf = ev => {
            const sq = (typeof ev.get_event_sequence === 'function') ? ev.get_event_sequence() : null;
            const sl = (sq && typeof sq.get_slot === 'function') ? sq.get_slot() : null;
            return [sq, sl];
        };

        const onMotion = ev => {
            const [x, y] = ev.get_coords();
            if (isResizing) {
                const monitor = Main.layoutManager.primaryMonitor;
                if (!monitor)
                    return;
                let pct = Math.round(startPct + ((dragStartY - y) / monitor.height) * 100);
                pct = Math.max(MIN_PCT, Math.min(MAX_PCT, pct));
                if (pct !== lastPct) {
                    lastPct = pct;
                    this._heightOverride = pct;
                    this._applyGeometry();
                }
            } else if (isDragging) {
                const mon = Main.layoutManager.primaryMonitor;
                const newX = Math.max(0, Math.min(mon.width - this.actor.width, actorStartX + (x - dragStartX)));
                const newY = Math.max(30, Math.min(mon.height - this.actor.height, actorStartY + (y - dragStartY)));
                this.actor.set_position(newX, newY);
            }
        };

        // Ends the drag wherever the finger or mouse button is lifted. Before, only a
        // release over the (thin) bar ended it, and a missed release left a temporary
        // height override in place that made later height changes do nothing.
        const finish = commit => {
            if (this._dragStageId) {
                global.stage.disconnect(this._dragStageId);
                this._dragStageId = 0;
            }
            this._dragFinish = null;
            if (isResizing) {
                isResizing = false;
                if (commit)
                    this._commitHeight(lastPct);
                else {
                    this._heightOverride = null;
                    this._applyGeometry();
                }
            }
            isDragging = false;
        };

        const onCaptured = ev => {
            const T = Clutter.EventType;
            const type = ev.type();
            if (isTouch) {
                if (type !== T.TOUCH_UPDATE && type !== T.TOUCH_END && type !== T.TOUCH_CANCEL)
                    return Clutter.EVENT_PROPAGATE;
                const [sq, sl] = seqOf(ev);
                const same = (slot !== null && sl !== null) ? sl === slot : sq === seq;
                if (!same)
                    return Clutter.EVENT_PROPAGATE;
                if (type === T.TOUCH_UPDATE)
                    onMotion(ev);
                else
                    finish(type === T.TOUCH_END);
                return Clutter.EVENT_STOP;
            }
            if (type === T.MOTION) {
                const state = (typeof ev.get_state === 'function') ? ev.get_state() : 0;
                if ((state & Clutter.ModifierType.BUTTON1_MASK) === 0) {
                    finish(true);   // button already up (release went elsewhere)
                    return Clutter.EVENT_PROPAGATE;
                }
                onMotion(ev);
                return Clutter.EVENT_STOP;
            }
            if (type === T.BUTTON_RELEASE) {
                finish(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        };

        this._onHandleEvent = (actor, event) => {
            const type = event.type();
            if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            if (this._dragFinish)
                this._dragFinish(true);
            const [x, y] = event.get_coords();
            dragStartX = x;
            dragStartY = y;
            isTouch = type === Clutter.EventType.TOUCH_BEGIN;
            [seq, slot] = seqOf(event);
            if (this._isDocked) {
                // Docked: dragging the bar up/down resizes the keyboard height
                const monitor = Main.layoutManager.primaryMonitor;
                if (!monitor)
                    return Clutter.EVENT_PROPAGATE;
                isResizing = true;
                startPct = this._getHeightPercent(monitor);
                lastPct = startPct;
            } else {
                // Floating: dragging the bar moves the keyboard
                isDragging = true;
                const [ax, ay] = this.actor.get_position();
                actorStartX = ax;
                actorStartY = ay;
            }
            this._dragFinish = finish;
            this._dragStageId = global.stage.connect('captured-event', (stage, ev) => onCaptured(ev));
            this._onHandleCaptured = onCaptured;
            return Clutter.EVENT_STOP;
        };
        handle.connect('event', this._onHandleEvent);
    }

    // Close/destroy in the middle of a drag: keep what was dragged so far
    _endHandleDrag() {
        if (this._dragFinish)
            this._dragFinish(true);
        this._heightOverride = null;
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

        // Resize strip (10) + header row (34 + 2 margin); the suggestions share the header row
        const handleHeight = 10;
        const headerHeight = 36;
        // Padding verticale contenitore
        const containerPadV = 2 + paddingBottom;
        const suggestH = this._tsBarHeight();
        const nonKeyH = handleHeight + headerHeight + containerPadV + numGap + ((numRows - 1) * gapY);

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
            this._handleBox.set_width(normalW);
            this._handleBox.set_x_align(Clutter.ActorAlign.CENTER);
        } else {
            this._keysBox.set_width(-1);
            this._keysBox.set_x_align(Clutter.ActorAlign.FILL);
            this._header.set_width(-1);
            this._header.set_x_align(Clutter.ActorAlign.FILL);
            this._handleBox.set_width(-1);
            this._handleBox.set_x_align(Clutter.ActorAlign.FILL);
        }
        this._tsSizeBar(suggestH);

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

                    // Long-press symbol shown small in the top-right corner
                    if (btn._hintActor) {
                        const hint = btn._hintActor;
                        const hw = Math.round(kw * 0.45);
                        const hh = Math.round(keyHeight * 0.42);
                        const hfs = Math.max(9, Math.round(keyHeight * 0.22));
                        hint.visible = this._longPressOn() &&
                            !(btn._keyDef?.lpAlt && this.altActive);
                        hint.set_size(hw, hh);
                        hint.set_position(row.xs[i] + kw - hw - Math.round(kw * 0.08), row.top + 2);
                        hint.set_style(`font-family: "${this._fontFamilyCss || this._computeFontFamily()}"; font-size: ${hfs}px; text-align: right;`);
                    }
                    // Second long-press hint in the top-left corner (e.g. Esc on Enter)
                    if (btn._hintLeftActor) {
                        const hint = btn._hintLeftActor;
                        const hw = Math.round(kw * 0.45);
                        const hh = Math.round(keyHeight * 0.42);
                        const hfs = Math.max(9, Math.round(keyHeight * 0.22));
                        hint.visible = this._longPressOn();
                        hint.set_size(hw, hh);
                        hint.set_position(row.xs[i] + Math.round(kw * 0.08), row.top + 2);
                        hint.set_style(`font-family: "${this._fontFamilyCss || this._computeFontFamily()}"; font-size: ${hfs}px; text-align: left;`);
                    }
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
        this._nwInit();
        this._tbShown = [];
        try {
            this._tbBridge = new TypingBoosterBridge(() => this._tsRefresh(), () => this.isOpen);
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
            // Overview opens/closes: switch engine and auto-caps right away, before the first key
            this._tbOverviewIds = ['showing', 'hidden'].map(sig => Main.overview.connect(sig, () => {
                if (this._tbWanted())
                    this._tbSync();
                this._acUpdate();
            }));
            this._tbFocusId = global.stage.connect('notify::key-focus', () => {
                if (this._tbFieldSyncId)
                    return;
                this._tbFieldSyncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._tbFieldSyncId = 0;
                    if (this._tbWanted())
                        this._tbSync();
                    return GLib.SOURCE_REMOVE;
                });
            });
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

    // Typing goes to the shell itself (app search, run dialog, lock screen), not an app.
    // In the overview the search entry only takes focus after the first key, so the
    // overview counts as shell even before that.
    _focusInShell() {
        try {
            if (Main.overview.visible || Main.modalCount > 0)
                return true;
            const f = global.stage.get_key_focus();
            return !!f && f !== global.stage && f instanceof Clutter.Text;
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
            // Shell entries (app search, run dialog) react to committed text only, so a
            // preedit word would not filter anything until Enter/Tab: use plain xkb there.
            if (this.isOpen && this._tbWanted() && this._fieldTypeAllowed() && !this._focusInShell())
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
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_expand: true,
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
                if (this._nwShown && this._nwShown.length) {
                    const w = this._nwShown[btn._tsRank];
                    if (w)
                        this._nwAccept(w);
                    return;
                }
                if (this._tbOn()) {
                    const c = this._tbShown && this._tbShown[btn._rank];
                    if (c && typeof c.cb === 'function') {
                        this._keySeq++;
                        this._nwOnTbCandidate(c.text);
                        try {
                            c.cb();
                        } catch (err) {
                            console.warn('[AproposOSK] typing-booster commit failed:', err);
                        }
                        this._acUpdate();
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
        // Lives in the header row, between the layout button and the right-hand buttons
        this._header.insert_child_above(this._suggestBar, this._layoutLabel);
    }

    _tsSizeBar(h) {
        const bar = this._suggestBar;
        if (!bar)
            return;
        bar.visible = h > 0;
        if (this._headerSpacer)
            this._headerSpacer.visible = !bar.visible;
        this._tsRefresh();
    }

    _tsStyleBar() {
        if (!this._suggestBtns)
            return;
        const fam = this._fontFamilyCss || 'sans-serif';
        let colors = 'color: #f3f3f3; background-color: rgba(255, 255, 255, 0.07);';
        if (this._isMaterial()) {
            colors = this._isLight()
                ? 'color: #1f1f1f; background-color: transparent;'
                : 'color: #e3e3e3; background-color: transparent;';
        }
        for (const b of this._suggestBtns) {
            b.set_style(`font-family: "${fam}"; font-size: 15px; ${colors} ` +
                'border-radius: 6px; margin: 3px 3px; padding: 0 8px;');
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
            // Preferred: the bundled frequency list, so common words come first
            try {
                this._loadFreq();
                if (this._freq && this._freq.size > 0) {
                    const known = new Set(this._tsBase || []);
                    this._tsTail = this._freq.words().filter(w => /^[a-z]{3,14}$/.test(w) && !known.has(w));
                    return GLib.SOURCE_REMOVE;
                }
            } catch (err) {}
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
        this._nwSaveNow();
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
        this._trkUnknown();
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
        // Taps outside the keyboard move the cursor: needed by suggestions and by the
        // typing assistance (auto-capitalization, autocorrect), so always watched
        this._tsAttachStage();
        if (!this._tsEnabled())
            return;
        this._tsLoadBase();
        this._tsLoadTail();
        this._nwLoadTb();
        this._tsReset(false);
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
            if (this._tbFocusId)
                global.stage.disconnect(this._tbFocusId);
            this._tbFocusId = 0;
            if (this._tbOverviewIds)
                this._tbOverviewIds.forEach(id => Main.overview.disconnect(id));
            this._tbOverviewIds = null;
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

    // ---- next-word prediction --------------------------------------------
    // Shown in the suggestion bar when nothing is being typed (after a space, or at the
    // start of a sentence). Learns word pairs typed with this keyboard; also uses the
    // pairs Typing Booster has learned and a small bundled starter list.
    _nwInit() {
        this._nw = new TL.NextWords();
        this._nwShown = [];
        this._nwCtx = null;
        this._nwLast = null;
        this._nwDirty = false;
        this._nwTbLoadedUs = 0;
        this._nwTbProc = null;
        try {
            const p = GLib.build_filenamev([this._extension.path, 'next-words-en.txt']);
            const [ok, bytes] = Gio.File.new_for_path(p).load_contents(null);
            if (ok)
                this._nw.loadSeed(new TextDecoder().decode(bytes));
        } catch (err) {
            console.warn('[AproposOSK] Could not load next-words-en.txt:', err.message);
        }
        try {
            const f = Gio.File.new_for_path(this._nwPath());
            if (f.query_exists(null)) {
                const [ok, bytes] = f.load_contents(null);
                const obj = ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
                if (obj && typeof obj === 'object')
                    this._nw.learned = obj;
            }
        } catch (err) {
            console.warn('[AproposOSK] Could not read learned word pairs:', err.message);
        }
        this._nwReady = true;
    }

    // Typing Booster finishes a tapped word asynchronously: the commit and the cleared
    // preedit arrive after the tap, often after the bar was refreshed (which then found
    // a preedit and showed nothing). Refresh again whenever the input context reports it.
    _nwHookIm() {
        const ctx = Main.inputMethod?._context ?? null;
        if (ctx === this._nwImCtx)
            return;
        this._nwUnhookIm();
        if (!ctx)
            return;
        this._nwImIds = [];
        for (const sig of ['commit-text', 'hide-preedit-text', 'update-preedit-text-with-mode']) {
            const cb = () => this._nwQueueRefresh();
            try {
                this._nwImIds.push(ctx.connect(sig, cb));
            } catch (e) {}
        }
        this._nwImCtx = ctx;
    }

    _nwUnhookIm() {
        for (const id of this._nwImIds ?? []) {
            try {
                this._nwImCtx.disconnect(id);
            } catch (e) {}
        }
        this._nwImIds = [];
        this._nwImCtx = null;
    }

    _nwQueueRefresh() {
        if (this._nwRefreshId || this._destroyed)
            return;
        this._nwRefreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._nwRefreshId = 0;
            if (!this._destroyed && this.isOpen)
                this._tsRefresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _nwPath() {
        return GLib.build_filenamev([GLib.get_user_config_dir(), 'apropos-osk', 'learned-pairs.json']);
    }

    _nwSaveNow() {
        if (!this._nwReady || !this._nwDirty)
            return;
        try {
            this._nw.prune();
            const dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'apropos-osk']);
            GLib.mkdir_with_parents(dir, 0o700);
            Gio.File.new_for_path(this._nwPath()).replace_contents(JSON.stringify(this._nw.learned),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
            this._nwDirty = false;
        } catch (err) {
            console.warn('[AproposOSK] Could not save learned word pairs:', err.message);
        }
    }

    _nwLearn(ctx, word, inc = 1) {
        this._nw.learn(ctx, word, inc);
        this._nwDirty = true;
        this._tsScheduleSave();
    }

    // Word pairs from Typing Booster's user database (read-only, at most every 10 minutes)
    _nwLoadTb() {
        if (!this._nwReady || this._nwTbProc)
            return;
        const now = GLib.get_monotonic_time();
        if (this._nwTbLoadedUs && now - this._nwTbLoadedUs < 600 * 1000000)
            return;
        const db = GLib.build_filenamev([GLib.get_user_data_dir(), 'ibus-typing-booster', 'user.db']);
        if (!GLib.file_test(db, GLib.FileTest.EXISTS))
            return;
        this._nwTbLoadedUs = now;
        const script = [
            'import sqlite3, json, sys, re',
            "c = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
            "w = re.compile(r\"^[^\\W\\d_]+(?:['’][^\\W\\d_]+)*$\")",
            'out = {}',
            "for p, ph, f in c.execute('select p_phrase, phrase, sum(user_freq) from phrases ' +",
            "        \"where p_phrase != '' group by lower(p_phrase), lower(phrase) order by 3 desc limit 20000\"):",
            '    if w.match(p) and w.match(ph):',
            '        d = out.setdefault(p.lower(), {})',
            '        d[ph.lower()] = d.get(ph.lower(), 0) + int(f or 1)',
            'print(json.dumps(out))',
        ].join('\n');
        try {
            const proc = Gio.Subprocess.new(['python3', '-I', '-c', script, db],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._nwTbProc = proc;
            proc.communicate_utf8_async(null, null, (pr, res) => {
                this._nwTbProc = null;
                try {
                    const [, out] = pr.communicate_utf8_finish(res);
                    if (this._destroyed || !pr.get_successful() || !out)
                        return;
                    const obj = JSON.parse(out);
                    if (obj && typeof obj === 'object' && this._nw)
                        this._nw.tb = obj;
                } catch (err) {}
            });
        } catch (err) {
            this._nwTbProc = null;
        }
    }

    _nwAllowed() {
        try {
            return this._nwReady && this._tsEnabled() && this._tsFieldAllowed() &&
                !this._focusInShell() && !Main.inputMethod.hasPreedit?.();
        } catch (err) {
            return false;
        }
    }

    // Text left of the cursor: the keyboard's own record if it has words in it, else the app's
    _nwContextText() {
        const t = this._typed;
        if (t !== null && t.trim().length > 0)
            return t;
        const s = this._surroundingBefore();
        return s !== null ? s : t;
    }

    // Fills the bar with predictions; false when there are none
    _nwShowPredictions() {
        this._nwShown = [];
        this._nwCtx = null;
        if (!this._nwAllowed())
            return false;
        const ctx = TL.predictionContext(this._nwContextText());
        if (!ctx)
            return false;
        const words = this._nw.predict(ctx, 3).map(w => TL.casePrediction(w, ctx));
        if (!words.length)
            return false;
        this._nwShown = words;
        this._nwCtx = ctx;
        for (const b of this._suggestBtns) {
            b.visible = b._tsRank >= 0;
            const w = words[b._tsRank] || '';
            b.label = w;
            b.reactive = !!w;
            b.opacity = w ? 255 : 0;
        }
        return true;
    }

    _nwAccept(word) {
        const ctx = this._nwCtx;
        const low = word.replace(/’/g, "'").toLowerCase();
        const before = this._nwContextText();
        this._keySeq++;
        this._lastCorrection = null;
        if (ctx) {
            this._nwLearn(ctx, low);
            this._nwLast = { ctx, word: low };
        }
        if (!this._tbOn() && low.length >= 3)
            this._tsLearn(low);
        this._trkSet((before ?? '') + word + ' ');
        this._tsBuf = '';
        this._tsSuppress = false;
        // A space right after this gives "word. " like after a typed word
        this._lastSpaceUs = GLib.get_monotonic_time();
        this._lastSpaceSeq = this._keySeq;
        this._typeText(word + ' ');
        this._acUpdate();
    }

    // Learn the pair completed by the word at the end of `textBefore` (a terminator follows)
    _nwLearnAt(textBefore) {
        this._nwLast = null;
        if (!this._nwReady || textBefore === null || textBefore === undefined)
            return;
        if (!this._tsEnabled() || !this._tsFieldAllowed() || this._focusInShell())
            return;
        const pair = TL.pairBefore(textBefore);
        if (!pair)
            return;
        const [ctx, word] = pair;
        if (ctx === TL.SENTENCE_START) {
            // Text typed since a cursor move does not show where the sentence starts:
            // check with the app (its text lacks a Typing Booster preedit, may lack the word)
            const wlen = TL.wordBefore(textBefore).length;
            if (textBefore.slice(0, textBefore.length - wlen).trim().length === 0) {
                let s = this._surroundingBefore();
                if (s !== null && s.endsWith(textBefore.slice(-wlen)))
                    s = s.slice(0, s.length - wlen);
                if (s === null || TL.wantsCapital(s) !== true)
                    return;
            }
        }
        this._nwLearn(ctx, word);
        this._nwLast = { ctx, word };
    }

    // Autocorrect replaced the word just learned: learn the fix instead
    _nwOnCorrected(orig, fix) {
        const l = this._nwLast;
        const o = orig.replace(/’/g, "'").toLowerCase();
        const f = fix.replace(/’/g, "'").toLowerCase();
        if (l && l.word === o && o !== f) {
            this._nwLearn(l.ctx, o, -1);
            this._nwLearn(l.ctx, f);
            this._nwLast = { ctx: l.ctx, word: f };
        }
        this._tsRefresh();
    }

    // A Typing Booster candidate replaces the word being typed (plus a space by default)
    _nwOnTbCandidate(text) {
        // The engine's labels carry invisible direction marks (U+202A…U+202C) that are not
        // part of the committed text; keeping them would hide the word from predictions
        text = String(text ?? '').replace(/\p{Cf}/gu, '');
        const t = this._typed;
        if (t === null || !text) {
            this._trkUnknown();
            return;
        }
        const head = t.replace(/\p{L}+(?:['’]\p{L}+)*['’]?$/u, '');
        this._nwLearnAt(head + text);
        let space = true;
        try {
            // (an uninstalled schema would abort the Shell: look it up first)
            if (this._nwTbSettings === undefined) {
                const id = 'org.freedesktop.ibus.engine.typing-booster';
                const schema = Gio.SettingsSchemaSource.get_default()?.lookup(id, true);
                this._nwTbSettings = schema && schema.has_key('addspaceoncommit')
                    ? new Gio.Settings({ schema_id: id, path: '/org/freedesktop/ibus/engine/typing-booster/' })
                    : null;
            }
            if (this._nwTbSettings)
                space = this._nwTbSettings.get_boolean('addspaceoncommit');
        } catch (err) {}
        this._trkSet(head + text + (space ? ' ' : ''));
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
            this._nwHookIm();
            // Candidates from typing-booster; best one goes to the centre slot (rank 0)
            let c = [];
            if (this._tsEnabled() && this._tsFieldAllowed())
                c = this._tbBridge.candidates.slice(0, 6);
            this._tbShown = c;
            this._tsShown = [];
            if (!c.length && this._nwShowPredictions())
                return;
            this._nwShown = [];
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
        if (!words.length && !this._tsBuf && this._nwShowPredictions())
            return;
        this._nwShown = [];
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
                return { code: def.code, shift: (isLetter && this.capsActive) !== !!def.invShift };
            if (def.shift === ch)
                return { code: def.code, shift: !(isLetter && this.capsActive) !== !!def.invShift };
        }
        return null;
    }

    // Plays key steps ({code, shift} or {keyval}) 20 ms apart. Steps queue up behind any
    // playback that is still running, so a correction never cuts another one short.
    _tsPlay(steps) {
        this._tsPlayQueue = (this._tsPlayQueue || []).concat(steps);
        if (this._tsPlayId)
            return;
        this._tsPlayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (!this._tsPlayQueue.length || !this._input) {
                this._tsPlayId = 0;
                this._tsPlayQueue = [];
                return GLib.SOURCE_REMOVE;
            }
            const s = this._tsPlayQueue.shift();
            if (s.keyval) {
                this._input.tapKeyval(s.keyval);
                return GLib.SOURCE_CONTINUE;
            }
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
        this._keySeq++;
        if (this._typed !== null && this._typed.endsWith(typed))
            this._trkSet(this._typed.slice(0, this._typed.length - typed.length) + word + ' ');
        else
            this._trkUnknown();
        this._tsLearn(word.toLowerCase());
        this._tsBuf = '';
        this._tsSuppress = false;
        this._tsRefresh();
        this._tsPlay(steps);
        this._acUpdate();
    }

    // ------------------------------------------------------------------
    // Text typed since the last cursor move. Only what this keyboard typed is known;
    // a tap outside the keyboard, arrow keys, shortcuts or key repeat make it unknown.
    // ------------------------------------------------------------------
    _trkUnknown() {
        this._typed = null;
        this._lastCorrection = null;
    }

    _trkSet(text) {
        this._typed = text.length > 200 ? text.slice(-200) : text;
    }

    _trkAppend(str) {
        // Typing after an unknown point still gives a known suffix of the text
        this._trkSet((this._typed ?? '') + str);
    }

    _trkBackspace() {
        if (this._typed === null)
            return;
        if (this._typed.length === 0) {
            this._typed = null;
            return;
        }
        const a = Array.from(this._typed);
        a.pop();
        this._typed = a.join('');
    }

    _trkOnKey(keyDef, label) {
        const mods = this._leftCtrlActive || this._rightCtrlActive || this.altActive || this._superDown;
        if (mods) {
            this._trkUnknown();
            return;
        }
        if (keyDef.type === 'enter') {
            this._nwLearnAt(this._typed);
            this._trkAppend('\n');
            return;
        }
        if (keyDef.type || !label || Array.from(label).length !== 1) {
            this._trkUnknown();
            return;
        }
        const before = this._typed;
        if (AC_TERMINATORS.has(label))
            this._nwLearnAt(before);
        this._trkAppend(label);
        if (label !== ' ' && AC_TERMINATORS.has(label))
            this._acMaybeCorrect(before, label);
    }

    // ------------------------------------------------------------------
    // Typing characters that may not be on the layout (long-press, corrections)
    // ------------------------------------------------------------------
    _canTypeWithKeys(str) {
        return Array.from(str).every(ch => ch === ' ' || this._tsKeyFor(ch));
    }

    _keySteps(str) {
        const steps = [];
        for (const ch of Array.from(str)) {
            if (ch === ' ') {
                steps.push({ code: 57, shift: false });
                continue;
            }
            const key = this._tsKeyFor(ch);
            if (key) {
                steps.push(key);
            } else {
                const kv = Clutter.unicode_to_keysym(ch.codePointAt(0));
                if (!kv)
                    return null;
                steps.push({ keyval: kv });
            }
        }
        return steps;
    }

    // Same order of preference as GNOME's own keyboard: through the input method when
    // Typing Booster is active, as a text commit when a text field has input focus,
    // and as key events otherwise (e.g. X11 apps).
    async _typeText(str) {
        if (!str)
            return;
        const im = Main.inputMethod;
        if (this._canTypeWithKeys(str) || !im.currentFocus) {
            const steps = this._keySteps(str);
            if (steps)
                this._tsPlay(steps);
            return;
        }
        if (this._tbOn()) {
            for (const ch of Array.from(str)) {
                const kv = Clutter.unicode_to_keysym(ch.codePointAt(0));
                let handled = false;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    handled = await im.handleVirtualKey(kv);
                } catch (e) {}
                if (!handled && this._input)
                    this._input.tapKeyval(kv);
            }
            return;
        }
        im.commit(str);
    }

    // A character chosen from the long-press popup
    _commitChar(ch) {
        this._keySeq++;
        if (Array.from(ch).length === 1 && this._tsKeyFor(ch)) {
            const k = this._tsKeyFor(ch);
            this._tsPlay([k]);
        } else {
            this._typeText(ch);
        }
        this._tsOnKey({}, ch);
        const before = this._typed;
        if (AC_TERMINATORS.has(ch))
            this._nwLearnAt(before);
        this._trkAppend(ch);
        if (this._releaseOneShotMods()) {
            this._updateModifierUI();
            this._updateLabels();
        }
        if (AC_TERMINATORS.has(ch))
            this._acMaybeCorrect(before, ch);
        this._acUpdate();
    }

    // ------------------------------------------------------------------
    // Space: double-space period and autocorrect
    // ------------------------------------------------------------------
    _onSpaceTap() {
        const now = GLib.get_monotonic_time();
        const typed = this._typed;
        const doublePeriod = this._settings.get_boolean('double-space-period') &&
            typed !== null && /[\p{L}\p{N}] $/u.test(typed) &&
            this._lastSpaceSeq === this._keySeq - 1 && now - this._lastSpaceUs < 1000000 &&
            this._tsFieldAllowed() && this._tsKeyFor('.');
        if (doublePeriod) {
            // "word␣" + space -> "word.␣"
            this._lastSpaceUs = 0;
            this._lastSpaceSeq = -1;
            this._lastCorrection = null;
            this._tsPlay([{ code: 14, shift: false }, this._tsKeyFor('.'), { code: 57, shift: false }]);
            this._trkSet(typed.slice(0, -1) + '. ');
            this._tsReset(false);
            this._acUpdate(true);
            return;
        }
        this._input.tapKey(57);
        this._tsOnSpace();
        this._lastSpaceUs = now;
        this._lastSpaceSeq = this._keySeq;
        this._nwLearnAt(typed);
        this._trkAppend(' ');
        this._acMaybeCorrect(typed, ' ');
        this._acUpdate();
    }

    // ------------------------------------------------------------------
    // Autocorrect (English): Enchant decides whether a word is misspelled, the bundled
    // frequency list (textlogic.js) picks the fix. Runs after space or punctuation.
    // ------------------------------------------------------------------
    _acEnabled() {
        try {
            // English word list only: stay off when the system language is not English
            if (!/^en(_|$|\.)/.test(GLib.get_language_names()[0] || ''))
                return false;
            return this._settings.get_boolean('autocorrect');
        } catch (e) {
            return false;
        }
    }

    _acLang() {
        for (const n of GLib.get_language_names()) {
            const m = /^(en_[A-Z]{2})/.exec(n);
            if (m)
                return m[1];
        }
        return 'en_US';
    }

    _acPrepare() {
        if (!this._acEnabled())
            return;
        if (!this._spell)
            this._spell = new SpellChecker(this._acLang());
        if (this._freq || this._freqId)
            return;
        this._freqId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._freqId = 0;
            this._loadFreq();
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadFreq() {
        if (this._freq)
            return;
        try {
            const p = GLib.build_filenamev([this._extension.path, 'words-freq-en.txt']);
            const [ok, bytes] = Gio.File.new_for_path(p).load_contents(null);
            this._freq = new TL.WordFreq(ok ? new TextDecoder().decode(bytes) : '');
        } catch (e) {
            console.warn('[AproposOSK] Could not load words-freq-en.txt:', e.message);
            this._freq = new TL.WordFreq('');
        }
    }

    // textBefore: tracked text before the terminator; term: the character just typed
    async _acMaybeCorrect(textBefore, term) {
        try {
            if (!this._acEnabled() || textBefore === null || textBefore === undefined)
                return;
            // (A Typing Booster preedit is only committed after this; _replaceTail checks it)
            if (!this._tsFieldAllowed())
                return;
            const word = TL.wordBefore(textBefore);
            if (!word)
                return;
            // Is the start of the word known? (otherwise only the surrounding text can tell)
            const pre = textBefore.slice(0, textBefore.length - word.length);
            const startKnown = pre.length > 0;
            const seq = this._keySeq;
            const low = word.toLowerCase();
            if ((this._tsLearned[low] || 0) >= 3)
                return;     // the user insists on this spelling

            let fix = null;
            if (TL.SPECIAL[low]) {
                fix = TL.mimicCase(word, TL.SPECIAL[low]);
            } else {
                if (!TL.correctable(word) || !this._freq || !this._spell)
                    return;
                const res = await this._spell.check(word);
                if (!res || res.ok)
                    return;
                // Only the case differs ("linux" -> "Linux", "lol" -> "LOL"): leave it
                if (res.suggestions.some(s => s.toLowerCase() === low))
                    return;
                // Only real words may replace it: the frequency list comes from subtitles and
                // contains some common misspellings, so candidates the spell checker did
                // not suggest itself are checked first
                const sugg = new Set(res.suggestions.map(s => s.toLowerCase()));
                const ranked = TL.rankCorrections(word, this._freq, res.suggestions).slice(0, 4);
                const valid = [];
                for (const it of ranked) {
                    // eslint-disable-next-line no-await-in-loop
                    const ok = sugg.has(it.c) || (await this._spell.check(it.c))?.ok;
                    if (ok)
                        valid.push(it);
                }
                fix = TL.pickConfident(word, valid);
            }
            if (!fix || fix === word || seq !== this._keySeq || this._destroyed)
                return;
            const done = await this._replaceTail(word + term, fix + term, startKnown, seq);
            if (!done)
                return;
            this._lastCorrection = { orig: word, fix, term, seq: this._keySeq };
            this._nwOnCorrected(word, fix);
            if (!this._tbOn()) {
                // Learn the fix, not the typo
                if (this._tsLearned[low]) {
                    this._tsLearned[low] -= 1;
                    if (this._tsLearned[low] <= 0)
                        delete this._tsLearned[low];
                }
                if (/^\p{L}+$/u.test(fix) && fix.length >= 3)
                    this._tsLearn(fix.toLowerCase());
            }
        } catch (e) {
            console.warn('[AproposOSK] autocorrect failed:', e.message);
        }
    }

    // Text left of the cursor from the app, or null when the app does not report it
    _surroundingBefore() {
        try {
            const [text, cursor] = Main.inputMethod.getSurroundingText();
            if (text === null || text === undefined || cursor === null || cursor === undefined)
                return null;
            return GLib.utf8_substring(text, 0, cursor);
        } catch (e) {
            return null;
        }
    }

    // Ask the app for its current text and wait briefly for the answer
    _freshSurrounding(timeoutMs = 150) {
        const im = Main.inputMethod;
        if (!im.currentFocus)
            return Promise.resolve(null);
        return new Promise(resolve => {
            let sigId = 0;
            let timer = 0;
            const finish = () => {
                if (!this._waiters.has(finish))
                    return;
                this._waiters.delete(finish);
                if (sigId)
                    im.disconnect(sigId);
                if (timer)
                    GLib.source_remove(timer);
                sigId = 0;
                timer = 0;
                resolve(this._destroyed ? null : this._surroundingBefore());
            };
            this._waiters.add(finish);
            sigId = im.connect('surrounding-text-set', finish);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timer = 0;
                finish();
                return GLib.SOURCE_REMOVE;
            });
            try {
                im.request_surrounding();
            } catch (e) {
                finish();
            }
        });
    }

    // Replace `oldTail` (just left of the cursor) with `newText`. Uses the app's surrounding
    // text when available: it checks that the text really ends with oldTail and swaps it in
    // one step. Without it, falls back to Backspace + retyping, but only when the start of
    // the word is known.
    async _replaceTail(oldTail, newText, startKnown, seq) {
        // The app may not have received the last key yet: re-check briefly
        let before = null;
        for (let attempt = 0; attempt < 8; attempt++) {
            // eslint-disable-next-line no-await-in-loop
            before = await this._freshSurrounding();
            if (seq !== this._keySeq || this._destroyed || !this.isOpen)
                return false;
            if (before === null || before.endsWith(oldTail))
                break;
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => this._oneShot(40, r));
        }
        if (seq !== this._keySeq || this._destroyed || !this.isOpen)
            return false;
        const n = Array.from(oldTail).length;
        const im = Main.inputMethod;
        if (before !== null) {
            if (!before.endsWith(oldTail))
                return false;
            const prev = Array.from(before.slice(0, before.length - oldTail.length)).pop();
            if (prev && /[\p{L}\p{N}'’_-]/u.test(prev))
                return false;   // part of a longer word
            if (im.hasPreedit?.())
                return false;
            im.delete_surrounding(-n, n);
            im.commit(newText);
        } else {
            if (!startKnown)
                return false;
            const steps = [];
            for (let i = 0; i < n; i++)
                steps.push({ code: 14, shift: false });
            const typed = this._keySteps(newText);
            if (!typed)
                return false;
            this._tsPlay(steps.concat(typed));
        }
        if (this._typed !== null && this._typed.endsWith(oldTail))
            this._trkSet(this._typed.slice(0, this._typed.length - oldTail.length) + newText);
        else
            this._trkUnknown();
        return true;
    }

    _tryRevertCorrection() {
        const lc = this._lastCorrection;
        this._lastCorrection = null;
        // Only when Backspace is the very next key after the correction
        if (!lc || lc.seq !== this._keySeq - 1)
            return false;
        const seq = this._keySeq;
        this._replaceTail(lc.fix + lc.term, lc.orig, true, seq).then(ok => {
            if (!ok) {
                // Could not verify the text: behave like a normal Backspace
                if (seq === this._keySeq) {
                    this._input.tapKey(14);
                    this._trkBackspace();
                }
                return;
            }
            // Don't correct this word again
            const low = lc.orig.toLowerCase();
            this._tsLearned[low] = Math.max(this._tsLearned[low] || 0, 3);
            this._tsLearnedDirty = true;
            this._tsScheduleSave();
            this._acUpdate();
        });
        return true;
    }

    // ------------------------------------------------------------------
    // Auto-capitalization: Shift turns on by itself at the start of a sentence and only
    // affects letters. Tapping Shift turns it off until the next key.
    // ------------------------------------------------------------------
    _acUpdate(force = false) {
        // Called after every key: the tracked text is final now, so update predictions
        if (this._nwReady)
            this._tsRefresh();
        // Never change Shift while a key is held with it (the key release takes care of it)
        if (!this.isOpen || this._destroyed || this._activeGesture === 'longpress' || this._shiftSent)
            return;
        let want = false;
        try {
            const im = Main.inputMethod;
            const H = Clutter.InputContentHintFlags;
            const hints = im.contentHints ?? im.content_hints ?? 0;
            const enabled = this._settings.get_boolean('auto-capitalize') &&
                !this.capsActive && this._acSuppressSeq !== this._keySeq &&
                !(hints & (H.LOWERCASE ?? 0)) && this._fieldTypeAllowed() && !im.hasPreedit?.() &&
                !this._focusInShell(); // searches and commands don't start sentences
            if (enabled) {
                let d = null;
                // The keyboard's own record is fresher than the app's report, as long as it
                // contains something other than spaces
                if (this._typed !== null && this._typed.trim().length > 0)
                    d = TL.wantsCapital(this._typed);
                if (d === null)
                    d = TL.wantsCapital(this._surroundingBefore());
                want = d === true;
            }
        } catch (e) {
            want = false;
        }
        if (want && !this.shiftActive) {
            this.shiftActive = true;
            this._autoShift = true;
            this._activeShiftCode = 42;
        } else if (!want && this.shiftActive && this._autoShift) {
            this.shiftActive = false;
            this._autoShift = false;
        } else if (!force) {
            return;
        }
        this._updateModifierUI();
        this._updateLabels();
    }

    // ------------------------------------------------------------------
    // Theme
    // ------------------------------------------------------------------
    _isMaterial() {
        try {
            return this._settings.get_string('theme') === 'material';
        } catch (e) {
            return false;
        }
    }

    _isLight() {
        try {
            if (!this._ifaceSettings)
                this._ifaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            return this._ifaceSettings.get_string('color-scheme') !== 'prefer-dark';
        } catch (e) {
            return false;
        }
    }

    _themeClasses() {
        if (!this._isMaterial())
            return [];
        return ['apropos-osk-theme-material', this._isLight() ? 'apropos-osk-light' : 'apropos-osk-dark'];
    }

    _applyTheme() {
        if (!this.actor)
            return;
        for (const c of ['apropos-osk-theme-material', 'apropos-osk-light', 'apropos-osk-dark'])
            this.actor.remove_style_class_name(c);
        for (const c of this._themeClasses())
            this.actor.add_style_class_name(c);
        this._tsStyleBar();
        if (this._isoEnter && this._isoEnter._redraw)
            this._isoEnter._redraw();
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
        if (def.split) {
            // Two stacked symbols: both lines must fit the key height
            const kh = btn._keyH || 50;
            return Math.max(11, Math.min(this._fitFont('▲', 18, btn._keyW || 64, kh), Math.floor(kh * 0.36)));
        }
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
        if (btn._isEnterPlaceholder || btn._isSpacer) {
            btn.set_style(`margin-right: ${marginRight}px; background-color: transparent !important; border: none !important; box-shadow: none !important;`);
            return;
        }

        // `pill: true` (Gboard tablet Enter): fully rounded ends
        const radius = def.pill && btn._keyH ? Math.floor(btn._keyH / 2) : (btn._baseRadius || 8);
        const family = this._fontFamilyCss || this._computeFontFamily();
        const fontSize = this._fontSizeFor(btn);

        // Split key: transparent outer button, two separately drawn halves
        if (btn._splitHalves) {
            const kh = btn._keyH || 50;
            const gap = Math.max(2, Math.round(kh * 0.07));
            const halfH = Math.floor((kh - gap) / 2);
            const r = Math.min(radius, Math.floor(halfH / 2));
            btn.set_style(`margin-right: ${marginRight}px; padding: 0; background-color: transparent !important; border: none !important; box-shadow: none !important;`);
            btn._splitBox.set_style(`spacing: ${gap}px;`);
            const fs = Math.max(9, Math.min(Math.floor(halfH * 0.5), 16));
            const down = isPressed && btn._splitDef ? btn._splitDef.code : null;
            for (const half of btn._splitHalves) {
                half.set_height(halfH);
                half.set_style(`border-radius: ${r}px; margin: 0; font-family: "${family}"; font-size: ${fs}px;`);
                if (half._code === down)
                    half.add_style_class_name('pressed');
                else
                    half.remove_style_class_name('pressed');
            }
            return;
        }

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

        // Theme, and the system light/dark style for the Material theme
        this._settingsSignals.push(this._settings.connect('changed::theme', () => {
            this._applyTheme();
            this._applyGeometry();
        }));
        try {
            this._ifaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            this._colorSchemeId = this._ifaceSettings.connect('changed::color-scheme', () => this._applyTheme());
        } catch (e) {}

        // Long-press on/off shows or hides the corner symbols
        this._settingsSignals.push(this._settings.connect('changed::long-press', () => this._applyGeometry()));
        this._settingsSignals.push(this._settings.connect('changed::autocorrect', () => {
            if (this.isOpen)
                this._acPrepare();
        }));

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

        // Typing assistance: nothing is known about the text yet; ask the app for it
        this._trkUnknown();
        this._acPrepare();
        this._acUpdate();
        try {
            if (Main.inputMethod.currentFocus)
                Main.inputMethod.request_surrounding();
        } catch (e) {}
    }

    close() {
        this._endHandleDrag();
        this._deadZoneDropAll();
        this._resetGestureStates();
        this._stopKeyRepeat();
        this._input.releaseAll();
        this._superLpCancel();
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
        this._autoShift = false;
        this._shiftSent = false;
        if (this.altActive) {
            this._input.releaseKey(56);
            this.altActive = false;
        }
        this._trkUnknown();
        this._updateModifierUI();
        this._updateLabels();
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
        for (const finish of [...this._waiters])
            finish();
        this._waiters.clear();
        if (this._freqId) {
            GLib.source_remove(this._freqId);
            this._freqId = 0;
        }
        if (this._spell) {
            this._spell.destroy();
            this._spell = null;
        }
        this._freq = null;
        if (this._surroundingId) {
            Main.inputMethod.disconnect(this._surroundingId);
            this._surroundingId = 0;
        }
        if (this._colorSchemeId && this._ifaceSettings) {
            this._ifaceSettings.disconnect(this._colorSchemeId);
            this._colorSchemeId = 0;
        }
        this._ifaceSettings = null;
        this._tsPlayQueue = [];
        if (this._nwRefreshId) {
            GLib.source_remove(this._nwRefreshId);
            this._nwRefreshId = 0;
        }
        this._nwUnhookIm();
        this._tsDestroy();
        this._endHandleDrag();
        this._deadZoneDropAll();
        this._cleanupStageGesture();
        this._stopKeyRepeat();
        this._superLpCancel();
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
