// Emoji panel: replaces the key area while open. Category tabs on top, pages of emoji
// below (swipe sideways or use ‹ › to turn pages), recently used emoji in the first tab.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import { RECENT_MAX, parseEmojiData, pageCount, pageSlice, pushRecent } from './emojidata.js';

const RECENT_ICON = '🕘';

export class EmojiPanel {
    // opts: dataPath, recentPath, cellSize() -> px, onEmoji(str), onBackspace(), onClose()
    constructor(opts) {
        this._opts = opts;
        this._groups = [];
        this._recent = [];
        this._tab = 0;       // 0 = recent, 1.. = groups
        this._page = 0;
        this._color = '#f3f3f3';
        this._font = 'sans-serif';
        this._idleId = 0;
        this._load();

        this.actor = new St.BoxLayout({
            style_class: 'tabula-osk-emoji-panel',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            reactive: true,
            can_focus: false,
        });
        // Nothing tapped here may fall through to the keys underneath
        this.actor.connect('event', (actor, event) => {
            const t = event.type();
            if (t === Clutter.EventType.TOUCH_BEGIN || t === Clutter.EventType.TOUCH_END ||
                t === Clutter.EventType.BUTTON_PRESS || t === Clutter.EventType.BUTTON_RELEASE)
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        });

        this._bar = new St.BoxLayout({
            style_class: 'tabula-osk-emoji-bar',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        this.actor.add_child(this._bar);

        this._tabBtns = [];
        const icons = [RECENT_ICON, ...this._groups.map(g => g.icon)];
        icons.forEach((icon, i) => {
            const b = this._button(icon, 'tabula-osk-emoji-tab', () => this._select(i, 0));
            this._tabBtns.push(b);
            this._bar.add_child(b);
        });
        this._bar.add_child(new St.Widget({ x_expand: true }));
        this._prevBtn = this._button('‹', 'tabula-osk-emoji-ctl', () => this._turn(-1));
        this._pageLabel = new St.Label({
            style_class: 'tabula-osk-emoji-page',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._nextBtn = this._button('›', 'tabula-osk-emoji-ctl', () => this._turn(1));
        this._abcBtn = this._button('ABC', 'tabula-osk-emoji-ctl', () => this._opts.onClose());
        this._bsBtn = this._button('⌫', 'tabula-osk-emoji-ctl', () => this._opts.onBackspace());
        this._textBtns = [this._prevBtn, this._nextBtn, this._abcBtn, this._bsBtn];
        for (const w of [this._prevBtn, this._pageLabel, this._nextBtn, this._abcBtn, this._bsBtn])
            this._bar.add_child(w);

        this._grid = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
            y_expand: true,
            reactive: true,
            clip_to_allocation: true,
        });
        // The grid takes whatever room is left; its cells never ask for more
        this._grid.set({ min_width: 0, natural_width: 0, min_height: 0, natural_height: 0 });
        this.actor.add_child(this._grid);
        this._gw = 0;
        this._gh = 0;
        this._grid.connect('notify::allocation', () => {
            const box = this._grid.allocation;
            const w = Math.round(box.get_width()), h = Math.round(box.get_height());
            if (w === this._gw && h === this._gh)
                return;
            this._gw = w;
            this._gh = h;
            this._queueFill();
        });
        // A sideways swipe over the emoji turns the page instead of typing one
        this._grid.connect('captured-event', (actor, event) => this._onGridEvent(event));

        this._select(this._recent.length ? 0 : 1, 0);
    }

    _button(label, styleClass, onClick) {
        const b = new St.Button({ label, style_class: styleClass, reactive: true, can_focus: false });
        b.connect('clicked', onClick);
        return b;
    }

    _load() {
        try {
            const [ok, bytes] = Gio.File.new_for_path(this._opts.dataPath).load_contents(null);
            if (ok)
                this._groups = parseEmojiData(new TextDecoder().decode(bytes));
        } catch (e) {
            console.warn('[TabulaOSK] emoji data not loaded:', e);
        }
        try {
            const f = Gio.File.new_for_path(this._opts.recentPath);
            if (f.query_exists(null)) {
                const [ok, bytes] = f.load_contents(null);
                const list = ok ? JSON.parse(new TextDecoder().decode(bytes)) : [];
                if (Array.isArray(list))
                    this._recent = list.filter(e => typeof e === 'string').slice(0, RECENT_MAX);
            }
        } catch (e) {
            this._recent = [];
        }
    }

    _saveRecent() {
        try {
            const f = Gio.File.new_for_path(this._opts.recentPath);
            GLib.mkdir_with_parents(f.get_parent().get_path(), 0o755);
            f.replace_contents(JSON.stringify(this._recent), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {}
    }

    _list() {
        return this._tab === 0 ? this._recent : (this._groups[this._tab - 1]?.list ?? []);
    }

    _metrics() {
        const w = this._gw, h = this._gh;
        const cell = Math.max(32, Math.min(72, this._opts.cellSize() || 48));
        const cols = Math.max(1, Math.floor(w / cell));
        const rows = Math.max(1, Math.floor(h / cell));
        return { w, h, cell, cols, rows, per: cols * rows, cw: w / cols, ch: h / rows };
    }

    _select(tab, page) {
        this._tab = Math.max(0, Math.min(this._groups.length, tab));
        this._page = page;
        this._queueFill();
    }

    // Next/previous page; past the end it moves on to the neighbouring category
    _turn(dir) {
        const m = this._metrics();
        const pages = pageCount(this._list().length, m.per);
        let page = this._page + dir, tab = this._tab;
        if (page >= pages) {
            if (tab >= this._groups.length)
                return;
            tab++;
            page = 0;
        } else if (page < 0) {
            if (tab <= (this._recent.length ? 0 : 1))
                return;
            tab--;
            const list = tab === 0 ? this._recent : this._groups[tab - 1].list;
            page = pageCount(list.length, m.per) - 1;
        }
        this._select(tab, page);
    }

    _queueFill() {
        if (this._idleId || this._destroyed)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            if (!this._destroyed)
                this._fill();
            return GLib.SOURCE_REMOVE;
        });
    }

    _fill() {
        const m = this._metrics();
        if (m.w < 8 || m.h < 8)
            return;   // not laid out yet: the first allocation fills it
        this._grid.destroy_all_children();
        const list = this._list();
        const pages = pageCount(list.length, m.per);
        this._page = Math.max(0, Math.min(pages - 1, this._page));
        const size = Math.floor(Math.min(m.cw, m.ch) * 0.56);
        pageSlice(list, this._page, m.per).forEach((emoji, i) => {
            const b = this._button(emoji, 'tabula-osk-emoji-cell', () => this._pick(emoji));
            b.set_style(`font-size: ${size}px;`);
            b.set_size(Math.floor(m.cw), Math.floor(m.ch));
            b.set_position(Math.floor((i % m.cols) * m.cw), Math.floor(Math.floor(i / m.cols) * m.ch));
            this._grid.add_child(b);
        });
        if (!list.length) {
            const hint = new St.Label({
                text: 'Emoji you use will appear here',
                style: `color: ${this._color}; font-family: "${this._font}"; font-size: 15px;`,
            });
            hint.set_position(16, 12);
            this._grid.add_child(hint);
        }
        this._pageLabel.text = `${this._page + 1}/${pages}`;
        this._tabBtns.forEach((b, i) => {
            if (i === this._tab)
                b.add_style_class_name('tabula-osk-emoji-tab-active');
            else
                b.remove_style_class_name('tabula-osk-emoji-tab-active');
        });
        this._styleBar(m);
    }

    _styleBar(m) {
        // From the key size, not the grid, so restyling the bar cannot change the page layout
        const h = Math.max(30, Math.round(m.cell * 0.85));
        const tabFont = Math.floor(h * 0.55);
        for (const b of this._tabBtns) {
            b.set_style(`font-size: ${tabFont}px;`);
            b.set_size(Math.round(h * 1.15), h);
        }
        const text = `color: ${this._color}; font-family: "${this._font}"; font-size: ${Math.floor(h * 0.42)}px;`;
        for (const b of this._textBtns) {
            b.set_style(text);
            b.set_height(h);
        }
        this._pageLabel.set_style(text);
    }

    _pick(emoji) {
        this._opts.onEmoji(emoji);
        const before = this._recent;
        this._recent = pushRecent(before, emoji);
        this._saveRecent();
        // The recent page is not reshuffled while it is being used
    }

    _onGridEvent(event) {
        const t = event.type();
        const E = Clutter.EventType;
        if (t === E.TOUCH_BEGIN || t === E.BUTTON_PRESS) {
            this._swipe = { x0: event.get_coords()[0], moved: false };
        } else if ((t === E.TOUCH_UPDATE || t === E.MOTION) && this._swipe) {
            const dx = event.get_coords()[0] - this._swipe.x0;
            if (Math.abs(dx) > Math.max(40, this._metrics().cw * 0.9))
                this._swipe.moved = true;
        } else if ((t === E.TOUCH_END || t === E.BUTTON_RELEASE) && this._swipe) {
            const sw = this._swipe;
            this._swipe = null;
            if (sw.moved) {
                this._turn(event.get_coords()[0] < sw.x0 ? 1 : -1);
                return Clutter.EVENT_STOP;
            }
        } else if (t === E.TOUCH_CANCEL) {
            this._swipe = null;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Called when the panel is shown again: start on the recent tab if there is one
    reset() {
        this._select(this._recent.length ? 0 : 1, 0);
    }

    setLook(color, font) {
        this._color = color;
        this._font = font;
        this._queueFill();
    }

    destroy() {
        this._destroyed = true;
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        this.actor.destroy();
    }
}
